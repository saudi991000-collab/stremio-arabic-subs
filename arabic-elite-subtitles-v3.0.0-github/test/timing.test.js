import test from "node:test";
import assert from "node:assert/strict";
import { compareSpeechActivity, compareTimelines, inspectStyling, parseTimeline, retimeSubtitle } from "../src/timing.js";
import { deepAnalyzeCandidates, sortDeepCandidates } from "../src/deep-analyzer.js";

function makeSrt(offset = 0, scale = 1) {
  return Array.from({ length: 30 }, (_, index) => {
    const start = offset + (index * 4 * scale);
    const end = start + 2;
    const stamp = (value) => {
      const hours = Math.floor(value / 3600);
      const minutes = Math.floor((value % 3600) / 60);
      const seconds = Math.floor(value % 60);
      const milliseconds = Math.round((value % 1) * 1000);
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
    };
    return `${index + 1}\n${stamp(start)} --> ${stamp(end)}\nسطر ترجمة رقم ${index + 1}`;
  }).join("\n\n");
}

test("matches subtitle timelines even with a constant offset", () => {
  const reference = parseTimeline(makeSrt(0));
  const shifted = parseTimeline(makeSrt(3.5));
  const comparison = compareTimelines(reference, shifted);
  assert.ok(comparison.score > 0.9);
  assert.ok(Math.abs(comparison.offset + 3.5) < 0.1);
});

test("detects ASS colors, positioning and karaoke", () => {
  const ass = `[Script Info]\n[V4+ Styles]\nStyle: Default,Arial,50,&H00FFFFFF\nStyle: Sign,Arial,42,&H0000FFFF\nStyle: Song,Arial,40,&H00FF00FF\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Sign,,0,0,0,,{\\an8\\c&H00FFFF&\\pos(400,80)}نص ملون\nDialogue: 0,0:00:04.00,0:00:06.00,Song,,0,0,0,,{\\k20}غناء`;
  const style = inspectStyling(ass, "ass");
  assert.equal(style.styled, true);
  assert.deepEqual(style.features, ["color", "position", "karaoke", "multiple-styles"]);
});

test("puts a trustworthy styled subtitle before plain uncalibrated candidates", () => {
  const results = sortDeepCandidates([
    { fileId: 1, tier: 2, confidence: 82, syncScore: 100, qualityScore: 5, reasons: [], styled: false },
    { fileId: 2, tier: 2, confidence: 72, syncScore: 80, qualityScore: 4, reasons: [], styled: true, styleStrength: 3 }
  ]);
  assert.equal(results[0].fileId, 2);
});

test("never puts styling above an exact video hash", () => {
  const results = sortDeepCandidates([
    { fileId: 1, tier: 4, confidence: 100, syncScore: 1000, qualityScore: 2, reasons: ["exact-hash"], styled: false },
    { fileId: 2, tier: 2, confidence: 78, syncScore: 80, qualityScore: 4, reasons: [], styled: true, styleStrength: 4 }
  ]);
  assert.equal(results[0].fileId, 1);
});

test("deep analysis verifies candidates from different providers and demotes failed downloads", async () => {
  const requested = [];
  const provider = {
    async download(item) {
      requested.push(item.provider);
      if (item.provider === "opensubtitles") throw new Error("download unavailable");
      return { buffer: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nمرحبا بالعالم\n"), fileName: "episode.srt" };
    }
  };
  const cache = { async getFile() { return null; }, async setFile() {} };
  const candidates = [
    { provider: "opensubtitles", fileId: 1, confidence: 90, tier: 2, syncScore: 10, qualityScore: 1, reasons: ["single-episode"], fileName: "Show.S01E01.srt" },
    { provider: "opensubtitles", fileId: 2, confidence: 89, tier: 2, syncScore: 9, qualityScore: 1, reasons: ["single-episode"], fileName: "Show.S01E01.alt.srt" },
    { provider: "subsource", fileId: 3, confidence: 80, tier: 2, syncScore: 8, qualityScore: 1, reasons: ["single-episode"], fileName: "Show.S01E01.srt" }
  ];
  const results = await deepAnalyzeCandidates(candidates, {
    media: { type: "series", season: 1, episode: 1 },
    extra: { videoHash: "" }
  }, provider, cache, { limit: 2, timeoutMs: 2000 });
  assert.deepEqual(requested.sort(), ["opensubtitles", "subsource"]);
  assert.equal(results[0].provider, "subsource");
  assert.equal(results.at(-1).downloadFailed, true);
});

test("matches subtitle activity to locally transcribed speech with an offset", () => {
  const starts = [60, 64, 71, 79, 83, 94, 101, 109, 116, 121, 133, 141];
  const reference = starts.map((start, index) => ({ start, end: start + 1.2 + (index % 3) * 0.6 }));
  const candidate = reference.map((cue) => ({ start: cue.start + 5, end: cue.end + 5 }));
  const result = compareSpeechActivity(reference, candidate);
  assert.ok(result.score > 0.85);
  assert.ok(Math.abs(result.offset + 5) < 0.6);
});

test("retimes SRT cues without changing their text", () => {
  const source = "1\n00:00:05,000 --> 00:00:07,000\nمرحبا بالعالم\n";
  const result = retimeSubtitle(source, "srt", { scale: 1, offset: -2.5 });
  assert.match(result, /00:00:02,500 --> 00:00:04,500/);
  assert.match(result, /مرحبا بالعالم/);
});

test("retimes ASS dialogue while preserving colors and positioning", () => {
  const source = "Dialogue: 0,0:00:05.00,0:00:07.00,Top,,0,0,0,,{\\an8\\c&H00FFFF&}نص ملون";
  const result = retimeSubtitle(source, "ass", { scale: 1, offset: -2.5 });
  assert.match(result, /0:00:02\.50,0:00:04\.50/);
  assert.match(result, /\\an8\\c&H00FFFF&/);
});
