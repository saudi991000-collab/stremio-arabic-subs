import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateRawSync } from "node:zlib";
import { extractArchive, normalizeSubtitle, safeArchiveEntryName, decodeArabic } from "../src/subtitle.js";
import { arabicAss, arabicSrt, englishSrt, zipStore } from "./fixtures.js";

test("selects the requested episode from a multi-file season ZIP", () => {
  const zip = zipStore([
    { name: "Show.S01E06.srt", data: arabicSrt(30, { lines: ["الحلقة السادسة هنا بالتأكيد."] }) },
    { name: "Show.S01E07.srt", data: arabicSrt(30, { lines: ["الحلقة السابعة هنا بالتأكيد."] }) },
    { name: "Show.S01E08.srt", data: arabicSrt(30, { lines: ["الحلقة الثامنة هنا بالتأكيد."] }) }
  ]);
  const result = normalizeSubtitle(zip, { season: 1, episode: 7, fileName: "pack.zip" });
  assert.match(result.buffer.toString("utf8"), /السابعة/);
});

test("rejects a season pack that does not contain the requested episode", () => {
  const zip = zipStore([
    { name: "Show.S01E01.srt", data: arabicSrt(20) },
    { name: "Show.S01E02.srt", data: arabicSrt(20) }
  ]);
  assert.throws(() => extractArchive(zip, { season: 1, episode: 9 }), /requested episode 9/);
});

test("ignores path-traversal and absolute entry names (Zip Slip)", () => {
  assert.equal(safeArchiveEntryName("../../etc/passwd.srt"), false);
  assert.equal(safeArchiveEntryName("/abs/file.srt"), false);
  assert.equal(safeArchiveEntryName("C:\\windows\\file.srt"), false);
  assert.equal(safeArchiveEntryName("__MACOSX/._Movie.srt"), false);
  assert.equal(safeArchiveEntryName("Subs/Movie.ar.srt"), true);
  const zip = zipStore([
    { name: "../evil.srt", data: arabicSrt(20, { lines: ["ملف خبيث يجب تجاهله تماما."] }) },
    { name: "Movie.ar.srt", data: arabicSrt(20, { lines: ["الملف الصحيح داخل الأرشيف."] }) }
  ]);
  const result = extractArchive(zip, {});
  assert.equal(result.fileName, "Movie.ar.srt");
});

test("prefers the Arabic file in a multi-language movie ZIP", () => {
  const zip = zipStore([
    { name: "Movie.2023.English.srt", data: englishSrt(30) },
    { name: "Movie.2023.Arabic.srt", data: arabicSrt(30) }
  ]);
  assert.equal(extractArchive(zip, {}).fileName, "Movie.2023.Arabic.srt");
});

test("blocks decompression bombs by ratio and size", () => {
  const huge = Buffer.alloc(5 * 1024 * 1024, 0x41);
  const compressed = deflateRawSync(huge);
  // Build a deflate entry by hand: method 8 with declared sizes.
  const zip = zipStore([{ name: "bomb.srt", data: compressed, declaredSize: huge.length }]);
  // zipStore writes method 0; patch both headers to method 8 (deflate).
  zip.writeUInt16LE(8, 8);
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt16LE(8, central + 10);
  assert.throws(() => extractArchive(zip, {}), /Unsafe ZIP compression ratio/);
});

test("refuses archives with too many entries and unsupported RAR/7z", () => {
  const many = zipStore(Array.from({ length: 501 }, (_, index) => ({ name: `f${index}.txt`, data: "x" })));
  assert.throws(() => extractArchive(many, {}), /too many files/);
  assert.throws(() => extractArchive(Buffer.from("Rar!\x1a\x07\x00rest"), {}), /RAR/);
});

test("opens one level of nested ZIP but no deeper", () => {
  const inner = zipStore([{ name: "Movie.ar.srt", data: arabicSrt(20) }]);
  const outer = zipStore([{ name: "inner.zip", data: inner }]);
  assert.equal(extractArchive(outer, {}).fileName, "Movie.ar.srt");
  const deepest = zipStore([{ name: "again.zip", data: outer }]);
  assert.throws(() => extractArchive(deepest, {}), /too deep|supported subtitle/);
});

test("decodes gzip, UTF-16 and Windows-1256 Arabic subtitles", () => {
  const text = arabicSrt(20);
  assert.match(normalizeSubtitle(gzipSync(Buffer.from(text)), { fileName: "a.srt.gz" }).buffer.toString("utf8"), /أين كنت/);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  assert.equal(decodeArabic(utf16).encoding, "utf-16le");
  assert.match(normalizeSubtitle(utf16, { fileName: "a.srt" }).buffer.toString("utf8"), /أين كنت/);
  // Windows-1256: "مرحبا" = E3 D1 CD C8 C7
  const cp1256 = Buffer.from(`1\n00:00:01,000 --> 00:00:03,000\n${"\u0000".repeat(0)}`, "latin1");
  const arabic = Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7, 0x20]);
  const body = Buffer.concat([cp1256, ...Array.from({ length: 5 }, () => arabic), Buffer.from("\n\n2\n00:00:04,000 --> 00:00:06,000\n", "latin1"), ...Array.from({ length: 5 }, () => arabic)]);
  const decoded = decodeArabic(body);
  assert.equal(decoded.encoding, "windows-1256");
  assert.match(decoded.text, /مرحبا/);
});

test("detects the real format from content rather than the extension", () => {
  const ass = arabicAss(20);
  const named = normalizeSubtitle(Buffer.from(ass), { fileName: "wrong-name.srt", allowFormatMismatch: true });
  assert.equal(named.extension, "ass");
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nأين كنت طوال هذا الوقت؟\n\n00:00:04.000 --> 00:00:06.000\nلم أتوقع أن أراك هنا الليلة.\n`;
  const converted = normalizeSubtitle(Buffer.from(vtt), { fileName: "file.srt", outputExtension: "srt", allowFormatMismatch: true });
  assert.equal(converted.extension, "srt");
  assert.match(converted.buffer.toString("utf8"), /00:00:01,000 --> 00:00:03,000/);
});
