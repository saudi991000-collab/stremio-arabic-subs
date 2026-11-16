// Fansub season zips often carry 30-40 MB of fonts next to a few hundred KB
// of subtitles. When the server supports byte ranges, read only the ZIP
// directory and the subtitle entries, and rebuild a small ZIP from them, so
// the normal archive extractor can pick the episode.

const TEXT_FORMAT = /\.(srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i;
const TAIL_BYTES = 66 * 1024;
const MERGE_GAP = 96 * 1024;
const LOCAL_SLACK = 1024;

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function parseDirectory(buffer, count) {
  const entries = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const entry = {
      flags: buffer.readUInt16LE(offset + 8),
      method: buffer.readUInt16LE(offset + 10),
      crc: buffer.readUInt32LE(offset + 16),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
      nameBytes: buffer.subarray(offset + 46, offset + 46 + nameLength)
    };
    entry.fileName = entry.nameBytes.toString("utf8");
    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.flags & 0x0800, 6);
    local.writeUInt16LE(file.method, 8);
    local.writeUInt32LE(file.crc >>> 0, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.uncompressedSize, 22);
    local.writeUInt16LE(file.nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.flags & 0x0800, 8);
    central.writeUInt16LE(file.method, 10);
    central.writeUInt32LE(file.crc >>> 0, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.uncompressedSize, 24);
    central.writeUInt16LE(file.nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file.nameBytes, file.data);
    centrals.push(central, file.nameBytes);
    offset += 30 + file.nameBytes.length + file.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// `readRange(start, endInclusive)` returns { buffer, total }.
// `select(entries)` may narrow the entries to fetch (e.g. one episode).
export async function slimRemoteZip(readRange, { maxBytes = 12 * 1024 * 1024, maxEntries = 500, select } = {}) {
  const probe = await readRange(-TAIL_BYTES);
  const total = probe.total;
  if (!Number.isFinite(total) || total <= 0) throw new Error("Server did not report the ZIP size");
  const tailStart = Math.max(0, total - probe.buffer.length);
  const tail = probe.buffer;
  const eocd = findEocd(tail);
  if (eocd < 0) throw new Error("Invalid ZIP subtitle archive");
  const count = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error("ZIP contains too many files");
  if (directorySize > 4 * 1024 * 1024 || directoryOffset + directorySize > total) throw new Error("Invalid ZIP directory");
  const directory = directoryOffset >= tailStart
    ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
    : (await readRange(directoryOffset, directoryOffset + directorySize - 1)).buffer;
  const usable = parseDirectory(directory, count)
    .filter((entry) => TEXT_FORMAT.test(entry.fileName) && !(entry.flags & 0x1) && (entry.method === 0 || entry.method === 8));
  const wanted = (select ? select(usable) : usable).sort((a, b) => a.localOffset - b.localOffset);
  if (!wanted.length) throw new Error("ZIP does not contain a supported subtitle");

  // Group neighbouring entries into few range requests.
  const spans = [];
  for (const entry of wanted) {
    const start = entry.localOffset;
    const end = Math.min(directoryOffset, start + 30 + entry.nameBytes.length + LOCAL_SLACK + entry.compressedSize) - 1;
    const last = spans.at(-1);
    if (last && start - last.end <= MERGE_GAP) {
      last.end = Math.max(last.end, end);
      last.entries.push(entry);
    } else spans.push({ start, end, entries: [entry] });
  }
  const bytes = spans.reduce((sum, span) => sum + span.end - span.start + 1, 0);
  if (bytes > maxBytes) throw new Error("Subtitle entries are too large");
  if (spans.length > 12) throw new Error("ZIP subtitles are too scattered");

  const files = [];
  for (const span of spans) {
    const { buffer } = await readRange(span.start, span.end);
    for (const entry of span.entries) {
      const at = entry.localOffset - span.start;
      if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) throw new Error("Invalid ZIP local entry");
      const dataStart = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
      if (dataStart + entry.compressedSize > buffer.length) throw new Error("Truncated ZIP entry");
      files.push({ ...entry, data: buffer.subarray(dataStart, dataStart + entry.compressedSize) });
    }
  }
  return buildZip(files);
}

// Range reader on top of safeFetch. Falls back (throws) when ranges are not
// honoured, so the caller can download the whole file instead.
export function rangeReader(url, fetchOptions, safeFetch) {
  return async (start, end) => {
    const range = start < 0 ? `bytes=${start}` : `bytes=${start}-${end}`;
    const expected = start < 0 ? -start : end - start + 1;
    const response = await safeFetch(url, {
      ...fetchOptions,
      headers: { ...(fetchOptions.headers || {}), Range: range },
      maxBytes: expected + 1024
    });
    if (response.status !== 206) throw new Error("Server ignored the byte range");
    const total = Number(String(response.headers?.get?.("content-range") || "").split("/")[1]);
    return { buffer: response.buffer, total };
  };
}
