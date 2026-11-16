import test from "node:test";
import assert from "node:assert/strict";
import { alignTimelines, mapTime, parseTimeline, retimeSubtitle, transformIsMonotonic, STANDARD_SCALES } from "../src/timing.js";
import { timingTransform } from "../src/server.js";
import { samplePositions, mapConcatenatedSegments, speechFromSilence } from "../src/companion.js";
import { arabicAss, dialogueTimes, srtFrom } from "./fixtures.js";

const reference = dialogueTimes(700, { start: 20, seed: 11 });
const shift = (cues, map) => cues.map((cue) => ({ start: map(cue.start), end: map(cue.end) }));

test("estimates a constant subtitle delay", () => {
  const result = alignTimelines(reference, shift(reference, (t) => t + 3.4));
  assert.equal(result.model, "linear");
  assert.ok(Math.abs(result.offset + 3.4) < 0.12, `offset ${result.offset}`);
  assert.ok(Math.abs(result.scale - 1) < 0.0005);
  assert.ok(result.confidence > 0.8);
});

test("detects 23.976 vs 25 fps (PAL speed-up) differences", () => {
  const ratio = 25 / 23.976;
  const result = alignTimelines(reference, shift(reference, (t) => t / ratio));
  assert.ok(STANDARD_SCALES.includes(result.scale));
  assert.ok(Math.abs(result.scale - ratio) < 1e-4, `scale ${result.scale}`);
  assert.ok(Math.abs(mapTime(4000 / ratio, result) - 4000) < 0.3);
});

test("corrects gradual drift combined with an offset", () => {
  const result = alignTimelines(reference, shift(reference, (t) => t * 1.0012 - 1.5));
  assert.ok(Math.abs(mapTime(4000 * 1.0012 - 1.5, result) - 4000) < 0.3);
  assert.ok(result.confidence > 0.75);
});

test("handles a different opening length with a safe piecewise model", () => {
  // The other release has a 30 s longer opening at 5 minutes; everything
  // after it is 30 s later while the cold open matches exactly.
  const candidate = shift(reference, (t) => (t < 300 ? t : t + 30));
  const result = alignTimelines(reference, candidate);
  assert.equal(result.model, "piecewise");
  assert.ok(Math.abs(mapTime(100, result) - 100) < 0.3);
  assert.ok(Math.abs(mapTime(2030, result) - 2000) < 0.3);
  assert.equal(transformIsMonotonic(result, candidate), true);
});

test("refuses to align unrelated timelines", () => {
  const result = alignTimelines(reference, dialogueTimes(700, { start: 20, seed: 99 }));
  assert.ok(result.confidence < 0.5);
});

test("aligns against sparse speech windows from five sample points", () => {
  const positions = samplePositions(4000, 30);
  assert.equal(positions.length, 5);
  assert.ok(positions[0] < 400 && positions[4] > 3500);
  const windows = positions.map((start) => ({ start, end: start + 30 }));
  const speech = reference.filter((cue) => windows.some((window) => cue.start >= window.start && cue.end <= window.end));
  const result = alignTimelines(speech, shift(reference, (t) => t - 2.2), { windows, kind: "audio-whisper" });
  assert.ok(Math.abs(result.offset - 2.2) < 0.15, `offset ${result.offset}`);
  assert.ok(result.inliers >= 3);
});

test("maps concatenated whisper samples back to the original timeline", () => {
  const mapped = mapConcatenatedSegments([{ start: 1, end: 2 }, { start: 19.5, end: 20.5 }, { start: 21, end: 22 }], [100, 500], 20);
  assert.deepEqual(mapped, [{ start: 101, end: 102 }, { start: 501, end: 502 }]);
  const speech = speechFromSilence("silence_start: 2.0\nsilence_end: 4.5\nsilence_start: 9\nsilence_end: 10", 600, 15);
  assert.deepEqual(speech.map((cue) => [cue.start, cue.end]), [[600, 602], [604.5, 609], [610, 615]]);
});

test("retimes plain SRT, drops cues pushed before zero and renumbers", () => {
  const source = srtFrom([{ start: 1, end: 2 }, { start: 5, end: 7 }, { start: 9, end: 11 }]);
  const result = retimeSubtitle(source, "srt", { scale: 1, offset: -3 });
  const cues = parseTimeline(result);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 2);
  assert.match(result, /^1\n00:00:02,000 --> 00:00:04,000/);
  assert.match(result, /\n\n2\n00:00:06,000/);
});

test("retimes colored ASS without touching styles or positioning", () => {
  const source = arabicAss(10, { styled: true });
  const result = retimeSubtitle(source, "ass", { scale: 1, offset: 2 });
  assert.match(result, /\\an8\\c&H00FFFF&/);
  assert.match(result, /\[V4\+ Styles\][\s\S]*Style: Top/);
  assert.equal(parseTimeline(result)[0].start.toFixed(2), (parseTimeline(source)[0].start + 2).toFixed(2));
});

test("scales ASS karaoke durations with the timeline", () => {
  const source = arabicAss(4, { karaoke: true });
  const result = retimeSubtitle(source, "ass", { scale: 25 / 23.976, offset: 0 });
  assert.match(source, /\\k25/);
  assert.match(result, /\\k26/);
  assert.match(result, /\\k31/);
  assert.doesNotMatch(result, /\\k25\b/);
});

test("never applies a low-confidence or exact-hash timing correction", () => {
  assert.equal(timingTransform({ timingScore: 0.4, timingModel: "linear", timingScale: 1, timingOffset: 3, reasons: [] }, 0.6), undefined);
  assert.equal(timingTransform({ timingScore: 0.95, timingModel: "linear", timingScale: 1, timingOffset: 3, reasons: ["exact-hash"] }, 0.6), undefined);
  assert.equal(timingTransform({ timingScore: 0.95, timingModel: "linear", timingScale: 1, timingOffset: 0.01, reasons: [] }, 0.6), undefined);
  const applied = timingTransform({ timingScore: 0.9, timingModel: "linear", timingScale: 1, timingOffset: 3, reasons: [] }, 0.6);
  assert.equal(applied.offset, 3);
});

test("rejects non-monotonic piecewise mappings", () => {
  const cues = [{ start: 10, end: 12 }, { start: 13, end: 15 }, { start: 20, end: 22 }];
  const unsafe = { segments: [{ start: -1e9, end: 12.5, scale: 1, offset: 5 }, { start: 12.5, end: 1e9, scale: 1, offset: -5 }] };
  assert.equal(transformIsMonotonic(unsafe, cues), false);
});
