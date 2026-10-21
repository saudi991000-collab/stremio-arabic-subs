import { gunzipSync, inflateRawSync } from "node:zlib";
import { looksLikeHtml } from "./quality.js";

const MAX_SUBTITLE_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_DEPTH = 1;
const ARCHIVE_TEXT_FORMAT = /\.(srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i;

function stripAssAttachments(buffer, fileName) {
  if (!/\.(?:ass|ssa)$/i.test(String(fileName || "")) && !/^\s*\ufeff?\[Script Info\]/i.test(buffer.subarray(0, 256).toString("utf8"))) return buffer;
  if (buffer.length <= MAX_SUBTITLE_BYTES) return buffer;
  const text = buffer.toString("utf8")
    .replace(/\r?\n\[Fonts\][\s\S]*?(?=\r?\n\[[^\]]+\]|$)/gi, "")
    .replace(/\r?\n\[Graphics\][\s\S]*?(?=\r?\n\[[^\]]+\]|$)/gi, "");
  const cleaned = Buffer.from(text, "utf8");
  if (cleaned.length > MAX_SUBTITLE_BYTES) throw new Error("Styled subtitle is too large after removing embedded attachments");
  return cleaned;
}

function findEocd(buffer) {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function archiveEntryScore(fileName, selector = {}) {
  const episode = Number(selector.episode);
  if (!Number.isInteger(episode)) return 0;
  const season = Number(selector.season);
  const escapedEpisode = String(episode);
  const explicit = fileName.match(/s(\d{1,2})[ ._-]*(?:ep?|episode)[ ._-]*0*(\d{1,3})/i) || fileName.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (explicit) {
    if (Number.isInteger(season) && Number(explicit[1]) !== season) return -1;
    return Number(explicit[2]) === episode ? 120 : -1;
  }
  if (new RegExp(`\\b(?:episode|ep|e)[ ._-]*0*${escapedEpisode}\\b`, "i").test(fileName)) return 100;
  if (new RegExp(`(?:^|[\\s._\\-[\\(])0*${escapedEpisode}(?=$|[\\s._\\-\\]\\)])`, "i").test(fileName)) return 70;
  return 0;
}

// Entry names are only used for scoring; nothing is ever written to disk, so a
// hostile name cannot escape a directory. Unsafe names are still ignored so a
// crafted archive cannot smuggle a "subtitle" through path tricks (Zip Slip).
export function safeArchiveEntryName(name) {
  const value = String(name || "");
  if (!value || value.length > 400 || /[\u0000-\u001f]/.test(value)) return false;
  if (/^(?:[\\/]|[a-z]:)/i.test(value)) return false;
  if (value.split(/[\\/]/).some((part) => part === ".." )) return false;
  if (/(?:^|[\\/])__MACOSX[\\/]/i.test(value) || /(?:^|[\\/])\._/.test(value)) return false;
  return !/[\\/]$/.test(value);
}

function preferredMovieEntry(options, selector) {
  const hint = String(selector.fileName || "").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "");
  return [...options].sort((a, b) => {
    const english = (option) => Number(/(?:^|[^a-z])(?:eng|english|en)(?:[^a-z]|$)/i.test(option.fileName));
    const arabic = (option) => Number(/(?:^|[^a-z])(?:ara|arabic|ar)(?:[^a-z]|$)|عرب/i.test(option.fileName));
    const hinted = (option) => Number(Boolean(hint) && option.fileName.toLowerCase().includes(hint));
    return arabic(b) - arabic(a) || english(a) - english(b) || hinted(b) - hinted(a) || b.uncompressedSize - a.uncompressedSize;
  })[0];
}

export function extractArchive(buffer, selector = {}, depth = 0) {
  const hintedFileName = String(selector.fileName || "subtitle.srt");
  if (buffer.length > MAX_COMPRESSED_BYTES) throw new Error("Compressed subtitle is too large");
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const result = gunzipSync(buffer, { maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES });
    return { buffer: stripAssAttachments(result, hintedFileName), fileName: hintedFileName.replace(/\.gz$/i, "") };
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("latin1") === "Rar!") throw new Error("RAR subtitle archives are not supported");
  if (buffer.length >= 6 && buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc) throw new Error("7z subtitle archives are not supported");
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) return { buffer, fileName: hintedFileName };
  if (depth > MAX_ARCHIVE_DEPTH) throw new Error("Nested subtitle archives are too deep");

  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("Invalid ZIP subtitle archive");
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("ZIP contains too many files");
  let offset = buffer.readUInt32LE(eocd + 16);
  const options = [];
  const nested = [];
  let declaredTotal = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!safeArchiveEntryName(fileName) || (flags & 0x1)) continue;
    const option = { method, compressedSize, uncompressedSize, localOffset, fileName };
    if (ARCHIVE_TEXT_FORMAT.test(fileName)) {
      declaredTotal += uncompressedSize;
      options.push(option);
    } else if (/\.zip$/i.test(fileName)) nested.push(option);
  }
  if (declaredTotal > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("ZIP expands beyond the safe size limit");
  if (!options.length && nested.length) {
    // Some uploaders wrap a ZIP inside a ZIP. Allow exactly one more level.
    for (const option of nested.slice(0, 3)) {
      try {
        return extractArchive(readZipEntry(buffer, option), selector, depth + 1);
      } catch (error) {
        if (/requested episode|too deep/i.test(error.message)) throw error;
      }
    }
  }
  let entry = options.length > 1 && !Number.isInteger(Number(selector.episode)) ? preferredMovieEntry(options, selector) : options[0];
  if (options.length > 1 && Number.isInteger(Number(selector.episode))) {
    const ranked = options
      .map((option) => ({ option, score: archiveEntryScore(option.fileName, selector) }))
      .sort((a, b) => b.score - a.score || a.option.fileName.localeCompare(b.option.fileName));
    if (ranked[0]?.score <= 0) throw new Error(`ZIP does not contain requested episode ${selector.episode}`);
    entry = ranked[0].option;
  }
  if (!entry) throw new Error("ZIP does not contain a supported subtitle");
  const result = readZipEntry(buffer, entry);
  return { buffer: stripAssAttachments(result, entry.fileName), fileName: entry.fileName.replace(/^.*[\\/]/, "") };
}

function readZipEntry(buffer, entry) {
  if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 300) {
    throw new Error("Unsafe ZIP compression ratio");
  }
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local entry");
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + localNameLength + localExtraLength;
  if (start + entry.compressedSize > buffer.length) throw new Error("Truncated ZIP entry");
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  const limit = Math.min(MAX_ARCHIVE_ENTRY_BYTES, Math.max(1024, entry.uncompressedSize * 2));
  const result = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: limit }) : null;
  if (!result) throw new Error("Unsupported ZIP compression method");
  return result;
}

function scoreDecoded(text) {
  const arabic = (text.match(/[\u0600-\u06ff]/g) || []).length;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const mojibake = (text.match(/[ØÙÃ]/g) || []).length;
  return arabic * 4 - replacement * 20 - mojibake * 5;
}

export function decodeArabic(buffer, options = {}) {
  const requireArabic = options.requireArabic !== false;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: "utf-16le", text: new TextDecoder("utf-16le").decode(buffer.subarray(2)) };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: "utf-16be", text: new TextDecoder("utf-16be").decode(buffer.subarray(2)) };
  }
  // UTF-16 without a BOM: every other byte of ASCII timing lines is zero.
  const sample = buffer.subarray(0, 512);
  const zeroOdd = sample.filter((value, index) => index % 2 === 1 && value === 0).length;
  const zeroEven = sample.filter((value, index) => index % 2 === 0 && value === 0).length;
  if (sample.length >= 64 && zeroOdd > sample.length * 0.3) return { encoding: "utf-16le", text: new TextDecoder("utf-16le").decode(buffer) };
  if (sample.length >= 64 && zeroEven > sample.length * 0.3) return { encoding: "utf-16be", text: new TextDecoder("utf-16be").decode(buffer) };
  // A valid UTF-8 Arabic file must win immediately. Decoding the same UTF-8
  // bytes as Windows-1256 often produces strings such as "ط§ظ„..." with
  // *more* Arabic code points, which fooled the old score-only detector.
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (!requireArabic || (utf8.match(/[\u0600-\u06ff]/g) || []).length >= 10) {
      return { encoding: "utf-8", text: utf8 };
    }
  } catch {
    // Invalid UTF-8 is expected for legacy Arabic subtitle encodings.
  }

  const encodings = requireArabic ? ["windows-1256", "iso-8859-6"] : ["windows-1252", "windows-1256", "iso-8859-6"];
  const decoded = encodings.map((encoding) => {
    try {
      return { encoding, text: new TextDecoder(encoding).decode(buffer) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  decoded.sort((a, b) => scoreDecoded(b.text) - scoreDecoded(a.text));
  return decoded[0];
}

export function analyzeSubtitle(text, options = {}) {
  const requireArabic = options.requireArabic !== false;
  const arabic = (text.match(/[\u0600-\u06ff]/g) || []).length;
  const letters = (text.match(/[\p{L}]/gu) || []).length;
  const arrowTiming = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/g;
  const arrowCues = [...text.matchAll(arrowTiming)];
  const assCues = text.match(/^Dialogue:/gim) || [];
  const arabicRatio = letters ? arabic / letters : 0;
  const languageValid = requireArabic ? arabic >= 10 : letters >= 10;
  const valid = text.length >= 40 && languageValid && (arrowCues.length >= 1 || assCues.length >= 1);
  let durationSeconds = 0;
  for (const match of arrowCues) {
    const end = Number(match[5] || 0) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(match[8]) / 1000;
    durationSeconds = Math.max(durationSeconds, end);
  }
  const assTiming = /^Dialogue:\s*[^,]*,\s*\d+:\d{2}:\d{2}[.]\d{1,2},\s*(\d+):(\d{2}):(\d{2})[.](\d{1,2}),/gim;
  for (const match of text.matchAll(assTiming)) {
    // Include the hour field: a 2-hour movie ASS used to look like a 59-minute
    // episode and slipped past the series-duration check.
    const end = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(2, "0")) / 100;
    durationSeconds = Math.max(durationSeconds, end);
  }
  return { valid, arabicRatio, cueCount: arrowCues.length || assCues.length, durationSeconds };
}

function assTimestamp(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/);
  if (!match) return null;
  const milliseconds = String(Number(match[4].padEnd(2, "0")) * 10).padStart(3, "0");
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]},${milliseconds}`;
}

function splitAssFields(value, count) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const comma = value.indexOf(",", start);
    if (comma < 0) break;
    fields.push(value.slice(start, comma));
    start = comma + 1;
  }
  fields.push(value.slice(start));
  return fields;
}

export function assToSrt(text) {
  let inEvents = false;
  let format = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
  const cues = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[Events\]$/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[.+\]$/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      format = trimmed.slice(trimmed.indexOf(":") + 1).split(",").map((field) => field.trim());
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed)) continue;
    const fields = splitAssFields(trimmed.slice(trimmed.indexOf(":") + 1).trim(), format.length);
    const start = assTimestamp(fields[format.findIndex((field) => /^start$/i.test(field))]);
    const end = assTimestamp(fields[format.findIndex((field) => /^end$/i.test(field))]);
    const rawText = fields[format.findIndex((field) => /^text$/i.test(field))] || "";
    const cueText = rawText
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .trim();
    if (!start || !end || !/[\u0600-\u06ff]/.test(cueText)) continue;
    cues.push(`${cues.length + 1}\n${start} --> ${end}\n${cueText}`);
  }
  if (!cues.length) throw new Error("ASS subtitle does not contain Arabic dialogue cues");
  return `${cues.join("\n\n")}\n`;
}

function srtClock(seconds) {
  const milliseconds = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function parseFlexibleClock(value) {
  const text = String(value || "").trim();
  const secondsOnly = text.match(/^(\d+(?:\.\d+)?)s$/i);
  if (secondsOnly) return Number(secondsOnly[1]);
  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!clock) return null;
  return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) + Number(String(clock[4] || "0").padEnd(3, "0")) / 1000;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lrm;|&rlm;/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function cleanMarkup(value) {
  return decodeEntities(String(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function cuesToSrt(cues) {
  const arabic = cues.filter((cue) => /[\u0600-\u06ff]/.test(cue.text) && cue.end > cue.start);
  if (!arabic.length) throw new Error("Subtitle does not contain Arabic dialogue cues");
  return `${arabic.map((cue, index) => `${index + 1}\n${srtClock(cue.start)} --> ${srtClock(cue.end)}\n${cue.text}`).join("\n\n")}\n`;
}

function sbvToSrt(text) {
  const cues = [];
  for (const block of String(text).split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const timing = lines.shift()?.match(/^\s*([^,]+),\s*([^,]+)\s*$/);
    if (!timing) continue;
    const start = parseFlexibleClock(timing[1]);
    const end = parseFlexibleClock(timing[2]);
    if (start == null || end == null) continue;
    cues.push({ start, end, text: cleanMarkup(lines.join("\n")) });
  }
  return cuesToSrt(cues);
}

function vttToSrt(text) {
  const cues = [];
  const source = String(text).replace(/^\ufeff?WEBVTT[^\r\n]*\r?\n/i, "");
  for (const block of source.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => !/^NOTE(?:\s|$)/i.test(line));
    const timingIndex = lines.findIndex((line) => /-->/.test(line));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/);
    if (!timing) continue;
    const start = parseFlexibleClock(timing[1]);
    const end = parseFlexibleClock(timing[2]);
    if (start == null || end == null) continue;
    cues.push({ start, end, text: cleanMarkup(lines.slice(timingIndex + 1).join("\n")) });
  }
  return cuesToSrt(cues);
}

function samiToSrt(text) {
  const matches = [...String(text).matchAll(/<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|$)/gi)];
  return cuesToSrt(matches.map((match, index) => ({
    start: Number(match[1]) / 1000,
    end: Number(matches[index + 1]?.[1] || Number(match[1]) + 4000) / 1000,
    text: cleanMarkup(match[2])
  })));
}

function ttmlToSrt(text) {
  const cues = [];
  for (const match of String(text).matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const begin = match[1].match(/\bbegin\s*=\s*["']([^"']+)["']/i)?.[1];
    const endValue = match[1].match(/\bend\s*=\s*["']([^"']+)["']/i)?.[1];
    const duration = match[1].match(/\bdur\s*=\s*["']([^"']+)["']/i)?.[1];
    const start = parseFlexibleClock(begin);
    const end = parseFlexibleClock(endValue) ?? (start == null ? null : start + (parseFlexibleClock(duration) || 0));
    if (start == null || end == null) continue;
    cues.push({ start, end, text: cleanMarkup(match[2]) });
  }
  return cuesToSrt(cues);
}

function subToSrt(text, fpsHint) {
  const raw = String(text);
  const microDvd = [...raw.matchAll(/^\{(\d+)\}\{(\d+)\}(.*)$/gm)];
  if (microDvd.length) {
    const declaredFps = microDvd.find((match) => match[1] === "1" && match[2] === "1" && /^\d+(?:\.\d+)?$/.test(match[3].trim()))?.[3];
    const fps = Number(fpsHint || declaredFps);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("MicroDVD subtitle requires a valid frame rate");
    return cuesToSrt(microDvd
      .filter((match) => !(match[1] === "1" && match[2] === "1" && match[3].trim() === declaredFps?.trim()))
      .map((match) => ({ start: Number(match[1]) / fps, end: Number(match[2]) / fps, text: cleanMarkup(match[3].replace(/\|/g, "\n")) })));
  }
  const mpl2 = [...raw.matchAll(/^\[(\d+)\]\[(\d+)\](.*)$/gm)];
  if (mpl2.length) return cuesToSrt(mpl2.map((match) => ({ start: Number(match[1]) / 10, end: Number(match[2]) / 10, text: cleanMarkup(match[3].replace(/\|/g, "\n")) })));
  throw new Error("Unsupported SUB subtitle encoding");
}

export function normalizeSubtitle(buffer, selector = {}) {
  if (!buffer?.length) throw new Error("Downloaded subtitle is empty");
  if (looksLikeHtml(buffer)) throw new Error("Provider returned an HTML or JSON error page instead of a subtitle");
  const extracted = extractArchive(buffer, selector);
  if (looksLikeHtml(extracted.buffer)) throw new Error("Archive contains an HTML page instead of a subtitle");
  if (extracted.buffer.length > MAX_SUBTITLE_BYTES) throw new Error("Subtitle file is too large");
  const requireArabic = selector.requireArabic !== false;
  const decoded = decodeArabic(extracted.buffer, { requireArabic });
  const hintedExtension = extracted.fileName.toLowerCase().match(/\.(srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/)?.[1];
  const detectedAss = hintedExtension === "ass" || hintedExtension === "ssa" || /^\s*\ufeff?\[Script Info\]/i.test(decoded.text);
  const detectedVtt = /^\s*\ufeff?WEBVTT\b/i.test(decoded.text);
  const detectedSami = /<sami\b|<sync\b[^>]*\bstart\s*=/i.test(decoded.text);
  const detectedTtml = /<(?:tt|ttml)\b|<p\b[^>]*\bbegin\s*=/i.test(decoded.text);
  const detectedSbv = /^\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d+\s*,\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d+\s*$/m.test(decoded.text);
  const detectedSub = /^\s*(?:\{\d+\}\{\d+\}|\[\d+\]\[\d+\])/m.test(decoded.text);
  const sourceExtension = detectedAss
    ? (hintedExtension === "ssa" ? "ssa" : "ass")
    : detectedVtt ? "vtt"
      : detectedSami ? (hintedExtension === "sami" ? "sami" : "smi")
        : detectedTtml ? (hintedExtension === "dfxp" ? "dfxp" : "ttml")
          : detectedSbv ? "sbv"
            : detectedSub ? "sub"
              : hintedExtension || "srt";
  const requestedExtension = String(selector.outputExtension || sourceExtension).toLowerCase();
  const shouldConvert = selector.preserveFormat !== true && requestedExtension === "srt";
  // Some providers mislabel SRT files that contain ASS override commands such
  // as {\an8}. Stremio renders those commands as visible garbage because the
  // surrounding file is not actually ASS. Preserve real ASS/SSA files, but
  // remove override commands from plain SRT/VTT text.
  let normalizedText;
  let extension = sourceExtension;
  if (shouldConvert && detectedAss) normalizedText = assToSrt(decoded.text);
  else if (shouldConvert && detectedVtt) normalizedText = vttToSrt(decoded.text);
  else if (detectedSami) normalizedText = samiToSrt(decoded.text);
  else if (detectedTtml) normalizedText = ttmlToSrt(decoded.text);
  else if (detectedSbv) normalizedText = sbvToSrt(decoded.text);
  else if (detectedSub) normalizedText = subToSrt(decoded.text, selector.fps);
  else if (detectedAss) normalizedText = decoded.text;
  else normalizedText = decoded.text.replace(/\{\\[^{}]+\}/g, "");
  if ((shouldConvert && (detectedAss || detectedVtt)) || detectedSami || detectedTtml || detectedSbv || detectedSub) extension = "srt";
  if (requestedExtension !== extension && selector.allowFormatMismatch !== true) {
    throw new Error(`Subtitle format mismatch: expected ${requestedExtension}, received ${extension}`);
  }
  const analysis = analyzeSubtitle(normalizedText, { requireArabic });
  if (!analysis.valid) throw new Error("Downloaded file is not a valid Arabic subtitle");
  return { buffer: Buffer.from(normalizedText, "utf8"), extension, encoding: decoded.encoding, analysis };
}
