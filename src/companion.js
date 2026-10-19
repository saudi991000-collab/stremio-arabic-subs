import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseTimeline } from "./timing.js";

const execFileAsync = promisify(execFile);
const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text"]);

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Local HLS request failed (${response.status})`);
  return response.text();
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

export class CompanionRegistry {
  constructor() {
    this.session = null;
    this.waiters = new Set();
  }

  register(payload) {
    const streamUrl = safeStremioStreamUrl(payload?.streamUrl);
    if (!streamUrl) throw new Error("Only a local Stremio Service stream URL is accepted");
    this.session = {
      streamUrl,
      duration: Number(payload.duration) || undefined,
      playbackTime: Number(payload.playbackTime) || undefined,
      title: String(payload.title || "").slice(0, 240),
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
      duration: Number(payload.duration) || undefined,
      playbackTime: Number(payload.playbackTime) || undefined,
      title: String(payload.title || "").slice(0, 240),
      receivedAt: Date.now(),
      discoveredFrom: String(payload.discoveredFrom || "trusted-local-probe")
    };
    for (const resolve of this.waiters) resolve(this.session);
    this.waiters.clear();
    return this.session;
  }

  latest(maxAgeMs = 120000) {
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
      await this.embeddedReference(safeUrl, playbackTime) || await this.whisperReference(safeUrl, duration)
    )().catch(() => null);
    this.cache.set(key, work);
    return work;
  }

  async whisperReference(streamUrl, duration) {
    const safeUrl = safeMediaAnalysisUrl(streamUrl);
    if (!safeUrl || !this.ffmpegPath || !this.whisperPath || !this.whisperModelPath) return null;
    await Promise.all([access(this.whisperPath), access(this.whisperModelPath)]);
    const sampleOffset = Number(duration) > 600 ? Math.min(120, Math.floor(Number(duration) * 0.12)) : 30;
    const temporary = await mkdtemp(path.join(os.tmpdir(), "arabic-syncrank-"));
    const wavePath = path.join(temporary, "audio.wav");
    const outputBase = path.join(temporary, "whisper");
    try {
      await execFileAsync(this.ffmpegPath, [
        "-v", "error", "-ss", String(sampleOffset), "-t", String(this.whisperSampleSeconds),
        "-i", safeUrl, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavePath
      ], { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      await execFileAsync(this.whisperPath, [
        "-m", this.whisperModelPath, "-f", wavePath, "-l", "auto", "-t", "8",
        "-oj", "-of", outputBase, "-np"
      ], { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const payload = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
      const timeline = (payload.transcription || []).map((segment) => ({
        start: sampleOffset + Number(segment.offsets?.from || 0) / 1000,
        end: sampleOffset + Number(segment.offsets?.to || 0) / 1000
      })).filter((cue) => cue.end - cue.start >= 0.2);
      if (timeline.length < 3) return null;
      return {
        timeline,
        candidate: { timingReferenceKind: "audio-whisper", fileName: "local-audio" },
        source: "audio-whisper",
        language: payload.result?.language || "auto"
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #readHlsEmbeddedReference(masterUrl, playbackTime) {
    const master = await fetchText(masterUrl, this.timeoutMs);
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
    const playlist = await fetchText(playlistUrl, this.timeoutMs);
    const segments = playlist.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && /\.vtt(?:\?|$)/i.test(line));
    if (!segments.length) return null;
    const target = Number.isFinite(playbackTime) && playbackTime > 0
      ? Math.floor(playbackTime / 10)
      : Math.floor(segments.length * 0.4);
    const first = Math.max(0, Math.min(segments.length - 3, target - 1));
    const sampled = segments.slice(first, first + 3);
    const settled = await Promise.allSettled(sampled.map((segment) => fetchText(new URL(segment, playlistUrl), this.timeoutMs)));
    const timeline = settled.flatMap((result) => result.status === "fulfilled" ? parseTimeline(result.value) : []);
    if (timeline.length < 3) return null;
    return {
      timeline,
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
