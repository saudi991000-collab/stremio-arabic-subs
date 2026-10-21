import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseTimeline } from "./timing.js";

const execFileAsync = promisify(execFile);
const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text"]);

async function fetchText(url, timeoutMs) {
  if (!safeStremioStreamUrl(url)) throw new Error("Only local Stremio Service URLs can be read");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Local HLS request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error("Local HLS response is too large");
  return text;
}

export function samplePositions(duration, length) {
  const total = Number(duration);
  if (!(total > length * 6)) return [30, 300, 900, 1500, 2100].filter((start, index) => index < 3 || !total || start + length < total);
  const fractions = [0.04, 0.25, 0.5, 0.75, 0.92];
  return fractions.map((fraction) => Math.max(0, Math.min(total - length - 1, Math.round(total * fraction))));
}

// Whisper ran on N concatenated samples; map its timestamps back to the
// original timeline and drop segments that straddle a sample boundary.
export function mapConcatenatedSegments(segments, positions, length) {
  const mapped = [];
  for (const segment of segments) {
    const index = Math.floor(segment.start / length);
    if (index < 0 || index >= positions.length) continue;
    if (Math.floor(Math.max(segment.start, segment.end - 0.001) / length) !== index) continue;
    const start = positions[index] + (segment.start - index * length);
    const end = positions[index] + (segment.end - index * length);
    if (end - start >= 0.2) mapped.push({ start, end });
  }
  return mapped.sort((a, b) => a.start - b.start);
}

export function speechFromSilence(stderr, offset, length) {
  const events = [...String(stderr).matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)].map((match) => ({ type: match[1], time: Number(match[2]) }));
  const speech = [];
  let cursor = 0;
  let silent = false;
  for (const event of events) {
    if (event.type === "start" && !silent) {
      if (event.time - cursor >= 0.3) speech.push({ start: offset + Math.max(0, cursor), end: offset + event.time });
      silent = true;
    } else if (event.type === "end" && silent) {
      cursor = event.time;
      silent = false;
    }
  }
  if (!silent && length - cursor >= 0.3) speech.push({ start: offset + cursor, end: offset + length });
  return speech;
}

function hlsAttribute(line, name) {
  return line.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1] || "";
}

export function safeStremioStreamUrl(value) {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    return loopback && url.protocol === "http:" && url.port === "11470" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Remote media URLs are accepted only when they were discovered from the
// command line of Stremio's own ffmpeg process. They are never accepted from
// the HTTP companion endpoint, which remains restricted to port 11470.
export function safeMediaAnalysisUrl(value) {
  const local = safeStremioStreamUrl(value);
  if (local) return local;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseFfmpegInputUrl(commandLine = "") {
  const match = String(commandLine).match(/(?:^|\s)-i\s+(?:"([^"]+)"|(\S+))/i);
  return match ? match[1] || match[2] : null;
}

export async function discoverWindowsStremioSession({ platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  const script = [
    "$items = Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\"",
    "$items | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | Sort-Object CreationDate -Descending | ConvertTo-Json -Compress"
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script
  ], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of processes) {
    if (!/\\Programs\\Stremio(?:Service)?\\ffmpeg\.exe$/i.test(String(item.ExecutablePath || ""))) continue;
    const streamUrl = safeMediaAnalysisUrl(parseFfmpegInputUrl(item.CommandLine));
    if (!streamUrl) continue;
    return {
      streamUrl,
      title: "Active Stremio playback",
      receivedAt: Date.now(),
      discoveredFrom: "stremio-ffmpeg"
    };
  }
  return null;
}

export async function discoverWindowsStremioHlsSession(session, { appData = process.env.APPDATA } = {}) {
  if (!session?.streamUrl || !appData) return null;
  const cacheFile = path.join(appData, "stremio-enhanced", "Cache", "Cache_Data", "data_2");
  const contents = (await readFile(cacheFile)).toString("latin1");
  const matches = contents.match(/http:\/\/127\.0\.0\.1:11470\/hlsv2\/[^\x00-\x20]*master\.m3u8[^\x00-\x20]*/g) || [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const streamUrl = safeStremioStreamUrl(matches[index]);
    if (!streamUrl) continue;
    if (new URL(streamUrl).searchParams.get("mediaURL") !== session.streamUrl) continue;
    return { ...session, streamUrl, receivedAt: Date.now(), discoveredFrom: "stremio-hls-cache" };
  }
  return null;
}

export function isLoopbackAddress(value = "") {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function finiteBetween(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

// Only metadata is accepted from the companion; nothing here is ever fetched
// except streamUrl, which must be Stremio Service on loopback.
export function sanitizeCompanionPayload(payload = {}) {
  const hash = String(payload.videoHash || "");
  return {
    duration: finiteBetween(payload.duration, 1, 6 * 3600),
    playbackTime: finiteBetween(payload.playbackTime, 0, 6 * 3600),
    title: String(payload.title || "").replace(/[\u0000-\u001f]/g, "").slice(0, 240),
    filename: String(payload.filename || "").replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f]/g, "").slice(0, 240),
    videoHash: /^[0-9a-f]{16}$/i.test(hash) ? hash.toLowerCase() : undefined,
    videoSize: finiteBetween(payload.videoSize, 1, 2 ** 46),
    fps: finiteBetween(payload.fps, 10, 120)
  };
}

export function isAllowedCompanionOrigin(origin) {
  if (!origin || origin === "null") return true;
  try {
    const url = new URL(origin);
    if (["file:", "app:", "stremio:"].includes(url.protocol)) return true;
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return true;
    return url.protocol === "https:" && ["web.stremio.com", "app.strem.io", "staging.strem.io", "web.strem.io"].includes(url.hostname);
  } catch {
    return /^(?:file|app|stremio):/i.test(origin);
  }
}

export class CompanionRegistry {
  constructor({ maxAgeMs = 120000 } = {}) {
    this.session = null;
    this.waiters = new Set();
    this.maxAgeMs = maxAgeMs;
  }

  clear() {
    this.session = null;
  }

  register(payload) {
    const streamUrl = safeStremioStreamUrl(payload?.streamUrl);
    if (!streamUrl) throw new Error("Only a local Stremio Service stream URL is accepted");
    this.session = {
      streamUrl,
      ...sanitizeCompanionPayload(payload),
      receivedAt: Date.now()
    };
    for (const resolve of this.waiters) resolve(this.session);
    this.waiters.clear();
    return this.session;
  }

  registerTrusted(payload) {
    const streamUrl = safeMediaAnalysisUrl(payload?.streamUrl);
    if (!streamUrl) throw new Error("Unsupported Stremio media URL");
    this.session = {
      streamUrl,
      ...sanitizeCompanionPayload(payload),
      receivedAt: Date.now(),
      discoveredFrom: String(payload.discoveredFrom || "trusted-local-probe").slice(0, 40)
    };
    for (const resolve of this.waiters) resolve(this.session);
    this.waiters.clear();
    return this.session;
  }

  latest(maxAgeMs = this.maxAgeMs) {
    return this.session && Date.now() - this.session.receivedAt <= maxAgeMs ? this.session : null;
  }

  async waitForRecent(timeoutMs = 1200) {
    const existing = this.latest();
    if (existing) return existing;
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.waiters.add(done);
    });
  }
}

function preferredTextTrack(streams) {
  return [...streams]
    .filter((stream) => TEXT_SUBTITLE_CODECS.has(String(stream.codec_name || "").toLowerCase()))
    .sort((a, b) => {
      const languageScore = (stream) => /^(eng|en|ara|ar)$/i.test(stream.tags?.language || "") ? 1 : 0;
      return languageScore(b) - languageScore(a) || Number(a.index) - Number(b.index);
    })[0];
}

export class LocalMediaAnalyzer {
  constructor({ ffprobePath, ffmpegPath, whisperPath, whisperModelPath, whisperSampleSeconds = 60, timeoutMs = 20000 } = {}) {
    this.ffprobePath = ffprobePath;
    this.ffmpegPath = ffmpegPath;
    this.whisperPath = whisperPath;
    this.whisperModelPath = whisperModelPath;
    this.whisperSampleSeconds = whisperSampleSeconds;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async embeddedReference(streamUrl, playbackTime) {
    const safeUrl = safeMediaAnalysisUrl(streamUrl);
    if (!safeUrl || !this.ffprobePath || !this.ffmpegPath) return null;
    if (this.cache.has(safeUrl)) return this.cache.get(safeUrl);
    const work = this.#readEmbeddedReference(safeUrl, playbackTime).catch(() => null);
    this.cache.set(safeUrl, work);
    return work;
  }

  async bestReference(streamUrl, duration, playbackTime) {
    const safeUrl = safeMediaAnalysisUrl(streamUrl);
    if (!safeUrl) return null;
    const key = `best:${safeUrl}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const work = (async () =>
      await this.embeddedReference(safeUrl, playbackTime).catch(() => null) ||
      await this.whisperReference(safeUrl, duration).catch(() => null) ||
      await this.vadReference(safeUrl, duration).catch(() => null)
    )().catch(() => null);
    this.cache.set(key, work);
    // Keep only recent analyses; nothing is written to disk and audio
    // samples are deleted as soon as each analysis finishes.
    while (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
    return work;
  }

  async mediaDuration(streamUrl, hint) {
    if (Number(hint) > 60) return Number(hint);
    if (!this.ffprobePath) return undefined;
    const { stdout } = await execFileAsync(this.ffprobePath, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", streamUrl
    ], { timeout: this.timeoutMs, maxBuffer: 64 * 1024, windowsHide: true });
    const value = Number(String(stdout).trim());
    return Number.isFinite(value) && value > 60 ? value : undefined;
  }

  // Beginning, first quarter, middle, third quarter and near the end. Openings,
  // "previously on" recaps and end credits differ between releases, so one
  // sample from the first minute is never enough to estimate drift.
  samplePositions(duration, length) {
    return samplePositions(duration, length);
  }

  async whisperReference(streamUrl, duration) {
    const safeUrl = safeMediaAnalysisUrl(streamUrl);
    if (!safeUrl || !this.ffmpegPath || !this.whisperPath || !this.whisperModelPath) return null;
    await Promise.all([access(this.whisperPath), access(this.whisperModelPath)]);
    const total = await this.mediaDuration(safeUrl, duration).catch(() => undefined);
    const length = Math.max(15, Math.min(40, Math.round(this.whisperSampleSeconds / 3)));
    const positions = this.samplePositions(total, length);
    const temporary = await mkdtemp(path.join(os.tmpdir(), "arabic-syncrank-"));
    const wavePath = path.join(temporary, "audio.wav");
    const outputBase = path.join(temporary, "whisper");
    try {
      // One ffmpeg call: N input seeks concatenated into a single mono WAV.
      const inputs = positions.flatMap((start) => ["-ss", String(start), "-t", String(length), "-i", safeUrl]);
      const filter = `${positions.map((_, index) => `[${index}:a:0]`).join("")}concat=n=${positions.length}:v=0:a=1[a]`;
      await execFileAsync(this.ffmpegPath, [
        "-v", "error", ...inputs, "-filter_complex", filter, "-map", "[a]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavePath
      ], { timeout: this.timeoutMs * 2, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      await execFileAsync(this.whisperPath, [
        "-m", this.whisperModelPath, "-f", wavePath, "-l", "auto", "-t", "8",
        "-oj", "-of", outputBase, "-np"
      ], { timeout: this.timeoutMs * 2, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const payload = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
      const timeline = mapConcatenatedSegments((payload.transcription || []).map((segment) => ({
        start: Number(segment.offsets?.from || 0) / 1000,
        end: Number(segment.offsets?.to || 0) / 1000
      })), positions, length);
      if (timeline.length < 6) return null;
      return {
        timeline,
        windows: positions.map((start) => ({ start, end: start + length })),
        kind: "audio-whisper",
        candidate: { timingReferenceKind: "audio-whisper", fileName: "local-audio" },
        source: "audio-whisper",
        language: payload.result?.language || "auto"
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  // Voice-activity reference using only ffmpeg (no Whisper needed): a speech
  // band-pass followed by silencedetect; non-silent spans become pseudo-cues.
  // It is weaker than Whisper (music is not silence), so alignment applies a
  // lower confidence weight to it.
  async vadReference(streamUrl, duration) {
    const safeUrl = safeMediaAnalysisUrl(streamUrl);
    if (!safeUrl || !this.ffmpegPath) return null;
    const total = await this.mediaDuration(safeUrl, duration).catch(() => undefined);
    if (!total) return null;
    const length = 45;
    const positions = this.samplePositions(total, length);
    const timeline = [];
    for (const start of positions) {
      const { stderr } = await execFileAsync(this.ffmpegPath, [
        "-v", "info", "-nostats", "-ss", String(start), "-t", String(length), "-i", safeUrl, "-vn",
        "-af", "highpass=f=250,lowpass=f=3400,silencedetect=n=-30dB:d=0.35", "-f", "null", "-"
      ], { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      timeline.push(...speechFromSilence(stderr, start, length));
    }
    if (timeline.length < 10) return null;
    return {
      timeline,
      windows: positions.map((start) => ({ start, end: start + length })),
      kind: "vad",
      candidate: { timingReferenceKind: "vad", fileName: "local-audio-vad" },
      source: "audio-vad"
    };
  }

  async #readHlsEmbeddedReference(masterUrl, playbackTime) {
    const master = await fetchText(masterUrl, this.timeoutMs);
    const origin = new URL(masterUrl).origin;
    const sameOrigin = (value) => {
      try {
        return new URL(value).origin === origin;
      } catch {
        return false;
      }
    };
    const tracks = master.split(/\r?\n/)
      .filter((line) => /^#EXT-X-MEDIA:TYPE=SUBTITLES/i.test(line))
      .map((line) => ({
        uri: hlsAttribute(line, "URI"),
        name: hlsAttribute(line, "NAME"),
        language: hlsAttribute(line, "LANGUAGE")
      }))
      .filter((track) => track.uri)
      .sort((a, b) => Number(/sign|song/i.test(a.name)) - Number(/sign|song/i.test(b.name)));
    const track = tracks[0];
    if (!track) return null;
    const playlistUrl = new URL(track.uri, masterUrl).toString();
    // Playlists come from the local Stremio Service; never follow them to
    // another origin (that would turn the companion into an open fetcher).
    if (!sameOrigin(playlistUrl)) return null;
    const playlist = await fetchText(playlistUrl, this.timeoutMs);
    const segments = playlist.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && /\.vtt(?:\?|$)/i.test(line))
      .filter((line) => sameOrigin(new URL(line, playlistUrl).toString()));
    if (!segments.length) return null;
    // Sample the embedded track at five places across the video (plus the
    // current playback position) instead of one block near 40%.
    const groups = [...new Set([0.04, 0.25, 0.5, 0.75, 0.92].map((fraction) => Math.floor(segments.length * fraction))
      .concat(Number.isFinite(playbackTime) && playbackTime > 0 ? [Math.floor(playbackTime / 10)] : []))]
      .map((index) => Math.max(0, Math.min(segments.length - 2, index)));
    const timeline = [];
    const windows = [];
    for (const first of [...new Set(groups)]) {
      const settled = await Promise.allSettled(segments.slice(first, first + 2).map((segment) => fetchText(new URL(segment, playlistUrl).toString(), this.timeoutMs)));
      const cues = settled.flatMap((result) => result.status === "fulfilled" ? parseTimeline(result.value) : []);
      if (!cues.length) continue;
      timeline.push(...cues);
      windows.push({ start: Math.min(...cues.map((cue) => cue.start)) - 2, end: Math.max(...cues.map((cue) => cue.end)) + 2 });
    }
    if (timeline.length < 6) return null;
    return {
      timeline: timeline.sort((a, b) => a.start - b.start),
      windows,
      kind: "embedded-sample",
      candidate: { timingReferenceKind: "embedded-sample", fileName: track.name || "embedded-hls" },
      source: "embedded-hls",
      language: track.language || "und",
      codec: "webvtt"
    };
  }

  async #readEmbeddedReference(streamUrl, playbackTime) {
    if (/\/master\.m3u8(?:\?|$)/i.test(streamUrl)) return this.#readHlsEmbeddedReference(streamUrl, playbackTime);
    const { stdout } = await execFileAsync(this.ffprobePath, [
      "-v", "error",
      "-select_streams", "s",
      "-show_entries", "stream=index,codec_name:stream_tags=language,title",
      "-of", "json",
      streamUrl
    ], { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const track = preferredTextTrack(JSON.parse(stdout || "{}").streams || []);
    if (!track) return null;
    const extracted = await execFileAsync(this.ffmpegPath, [
      "-v", "error", "-i", streamUrl,
      "-map", `0:${track.index}`,
      "-f", "srt", "pipe:1"
    ], { timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
    const timeline = parseTimeline(extracted.stdout || "");
    if (timeline.length < 8) return null;
    return {
      timeline,
      kind: "embedded",
      candidate: {
        timingReferenceKind: "embedded",
        fileName: track.tags?.title || `embedded-track-${track.index}`
      },
      source: "embedded",
      language: track.tags?.language || "und",
      codec: track.codec_name
    };
  }
}
