import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSubtitle, assToSrt, normalizeSubtitle } from "../src/subtitle.js";

const arabicSrt = "1\n00:00:01,000 --> 00:00:03,000\nمرحباً بكم في الاختبار الحقيقي للترجمة العربية.\n";

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [fileName, text] of entries) {
    const name = Buffer.from(fileName);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

test("accepts valid UTF-8 Arabic SRT", () => {
  const normalized = normalizeSubtitle(Buffer.from(arabicSrt));
  assert.equal(normalized.extension, "srt");
  assert.equal(normalized.analysis.valid, true);
  assert.equal(normalized.encoding, "utf-8");
  assert.match(normalized.buffer.toString("utf8"), /مرحباً بكم/);
});

test("removes visible ASS override commands from a mislabeled SRT", () => {
  const source = Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n{\\an8}{\\c&H00FFFF&}لا أقدر. هيا بنا!\n");
  const normalized = normalizeSubtitle(source, { fileName: "episode.srt", outputExtension: "srt" });
  const text = normalized.buffer.toString("utf8");
  assert.doesNotMatch(text, /\\an8|\\c&H/i);
  assert.match(text, /لا أقدر/);
});

test("decodes a Windows-1256 Arabic SRT", () => {
  const prefix = Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n");
  const arabicBytes = Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7, 0x20, 0xc8, 0xdf, 0xe3, 0x20, 0xdd, 0xed, 0x20, 0xc7, 0xe1, 0xc7, 0xce, 0xca, 0xc8, 0xc7, 0xd1, 0x20, 0xc7, 0xe1, 0xcd, 0xde, 0xed, 0xde, 0xed, 0x2e]);
  const normalized = normalizeSubtitle(Buffer.concat([prefix, arabicBytes, Buffer.from("\n")]));
  assert.equal(normalized.encoding, "windows-1256");
  assert.match(normalized.buffer.toString("utf8"), /مرحبا/);
});

test("rejects non-subtitle text", () => {
  assert.equal(analyzeSubtitle("هذه جملة عربية لكنها ليست ملف ترجمة صالحاً").valid, false);
});

test("accepts WebVTT cues with timestamps that omit the hour", () => {
  const vtt = "WEBVTT\n\n00:01.000 --> 00:03.250\nمرحباً بكم في اختبار ترجمة عربية بصيغة ويب في تي.\n";
  const normalized = normalizeSubtitle(Buffer.from(vtt), { fileName: "episode.vtt", outputExtension: "vtt" });
  assert.equal(normalized.extension, "vtt");
  assert.equal(normalized.analysis.valid, true);
  assert.equal(normalized.analysis.durationSeconds, 3.25);
});

test("selects the requested episode from a season ZIP", () => {
  const archive = storedZip([
    ["Show - 01 Pilot.srt", arabicSrt.replace("مرحباً بكم", "هذه الحلقة الأولى")],
    ["Show - 07 Attack.srt", arabicSrt.replace("مرحباً بكم", "هذه الحلقة السابعة")]
  ]);
  const normalized = normalizeSubtitle(archive, { season: 1, episode: 7 });
  assert.match(normalized.buffer.toString("utf8"), /الحلقة السابعة/);
  assert.doesNotMatch(normalized.buffer.toString("utf8"), /الحلقة الأولى/);
});

test("preserves Arabic ASS styling by default and converts only for an SRT output", () => {
  const ass = `[Script Info]\nTitle: Arabic\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:02.50,English,,0,0,0,,English line\nDialogue: 0,0:00:02.50,0:00:04.00,Arabic,,0,0,0,,{\\an2}مرحباً\\Nبالعالم العربي`;
  const converted = assToSrt(ass);
  assert.match(converted, /00:00:02,500 --> 00:00:04,000/);
  assert.match(converted, /مرحباً\nبالعالم العربي/);
  assert.doesNotMatch(converted, /English line/);
  const preserved = normalizeSubtitle(Buffer.from(ass), { fileName: "styled.ass", outputExtension: "ass" });
  assert.equal(preserved.extension, "ass");
  assert.equal(preserved.analysis.durationSeconds, 4);
  assert.match(preserved.buffer.toString("utf8"), /\\an2/);
  const normalized = normalizeSubtitle(Buffer.from(ass), { fileName: "styled.ass", outputExtension: "srt" });
  assert.equal(normalized.extension, "srt");
  assert.doesNotMatch(normalized.buffer.toString("utf8"), /\\an2/);
  const preservedDespiteHint = normalizeSubtitle(Buffer.from(ass), {
    fileName: "unknown.srt",
    outputExtension: "srt",
    preserveFormat: true,
    allowFormatMismatch: true
  });
  assert.equal(preservedDespiteHint.extension, "ass");
  assert.match(preservedDespiteHint.buffer.toString("utf8"), /\\an2/);
});

test("converts WebVTT to SRT when the public URL promises SRT", () => {
  const vtt = "WEBVTT\n\n00:01.000 --> 00:03.250 align:middle\nمرحباً بكم في ترجمة عربية بشرية سليمة.\n";
  const normalized = normalizeSubtitle(Buffer.from(vtt), { fileName: "episode.vtt", outputExtension: "srt" });
  assert.equal(normalized.extension, "srt");
  assert.match(normalized.buffer.toString("utf8"), /00:00:01,000 --> 00:00:03,250/);
});

test("converts SBV, SAMI, TTML and MicroDVD text subtitles to SRT", () => {
  const fixtures = [
    ["episode.sbv", "0:00:01.000,0:00:03.000\nهذه ترجمة عربية بشرية سليمة للاختبار.\n", {}],
    ["episode.smi", "<SAMI><BODY><SYNC Start=1000><P>هذه ترجمة عربية بشرية سليمة للاختبار.<SYNC Start=3000><P>نهاية المشهد العربي.</BODY></SAMI>", {}],
    ["episode.ttml", "<tt><body><div><p begin=\"00:00:01.000\" end=\"00:00:03.000\">هذه ترجمة عربية بشرية سليمة للاختبار.</p></div></body></tt>", {}],
    ["episode.sub", "{25}{75}هذه ترجمة عربية بشرية سليمة للاختبار.\n", { fps: 25 }]
  ];
  for (const [fileName, source, extra] of fixtures) {
    const normalized = normalizeSubtitle(Buffer.from(source), { fileName, outputExtension: "srt", ...extra });
    assert.equal(normalized.extension, "srt", fileName);
    assert.equal(normalized.analysis.valid, true, fileName);
  }
});
