import { gunzipSync, inflateRawSync } from "node:zlib";

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

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

export function extractArchive(buffer, selector = {}) {
  const hintedFileName = String(selector.fileName || "subtitle.srt");
  if (buffer.length > 20 * 1024 * 1024) throw new Error("Compressed subtitle is too large");
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const result = gunzipSync(buffer, { maxOutputLength: MAX_SUBTITLE_BYTES });
    return { buffer: result, fileName: hintedFileName.replace(/\.gz$/i, "") };
  }
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) return { buffer, fileName: hintedFileName };

  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("Invalid ZIP subtitle archive");
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const options = [];
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (/\.(srt|vtt|ass|ssa)$/i.test(fileName)) options.push({ method, compressedSize, uncompressedSize, localOffset, fileName });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  let entry = options[0];
  if (options.length > 1 && Number.isInteger(Number(selector.episode))) {
    const ranked = options
      .map((option) => ({ option, score: archiveEntryScore(option.fileName, selector) }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0]?.score <= 0) throw new Error(`ZIP does not contain requested episode ${selector.episode}`);
    entry = ranked[0].option;
  }
  if (!entry) throw new Error("ZIP does not contain a supported subtitle");
  if (entry.uncompressedSize > MAX_SUBTITLE_BYTES || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 150) {
    throw new Error("Unsafe ZIP compression ratio");
  }
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local entry");
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  const result = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_SUBTITLE_BYTES }) : null;
  if (!result) throw new Error("Unsupported ZIP compression method");
  return { buffer: result, fileName: entry.fileName };
}

function scoreDecoded(text) {
  const arabic = (text.match(/[\u0600-\u06ff]/g) || []).length;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const mojibake = (text.match(/[ØÙÃ]/g) || []).length;
  return arabic * 4 - replacement * 20 - mojibake * 5;
}

export function decodeArabic(buffer, options = {}) {
  const requireArabic = options.requireArabic !== false;
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
  const assTiming = /^Dialogue:\s*[^,]*,\s*\d+:(\d{2}):(\d{2})[.](\d{1,2}),\s*\d+:(\d{2}):(\d{2})[.](\d{1,2}),/gim;
  for (const match of text.matchAll(assTiming)) {
    const end = Number(match[4]) * 60 + Number(match[5]) + Number(match[6].padEnd(2, "0")) / 100;
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

export function normalizeSubtitle(buffer, selector = {}) {
  const extracted = extractArchive(buffer, selector);
  const requireArabic = selector.requireArabic !== false;
  const decoded = decodeArabic(extracted.buffer, { requireArabic });
  const originalAnalysis = analyzeSubtitle(decoded.text, { requireArabic });
  if (!originalAnalysis.valid) throw new Error("Downloaded file is not a valid Arabic subtitle");
  const hintedExtension = extracted.fileName.toLowerCase().match(/\.(srt|vtt|ass|ssa)$/)?.[1];
  const detectedAss = hintedExtension === "ass" || hintedExtension === "ssa" || /^\s*\ufeff?\[Script Info\]/i.test(decoded.text);
  const detectedVtt = /^\s*\ufeff?WEBVTT\b/i.test(decoded.text);
  const sourceExtension = detectedAss ? (hintedExtension === "ssa" ? "ssa" : "ass") : detectedVtt ? "vtt" : hintedExtension || "srt";
  const requestedExtension = String(selector.outputExtension || sourceExtension).toLowerCase();
  const shouldConvertAss = detectedAss && requestedExtension === "srt" && selector.preserveFormat !== true;
  // Some providers mislabel SRT files that contain ASS override commands such
  // as {\an8}. Stremio renders those commands as visible garbage because the
  // surrounding file is not actually ASS. Preserve real ASS/SSA files, but
  // remove override commands from plain SRT/VTT text.
  const normalizedText = shouldConvertAss
    ? assToSrt(decoded.text)
    : detectedAss
      ? decoded.text
      : decoded.text.replace(/\{\\[^{}]+\}/g, "");
  const extension = shouldConvertAss ? "srt" : sourceExtension;
  if (requestedExtension !== extension && selector.allowFormatMismatch !== true) {
    throw new Error(`Subtitle format mismatch: expected ${requestedExtension}, received ${extension}`);
  }
  const analysis = analyzeSubtitle(normalizedText, { requireArabic });
  if (!analysis.valid) throw new Error("Downloaded file is not a valid Arabic subtitle");
  return { buffer: Buffer.from(normalizedText, "utf8"), extension, encoding: decoded.encoding, analysis };
}
