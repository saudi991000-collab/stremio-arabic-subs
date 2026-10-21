import test from "node:test";
import assert from "node:assert/strict";
import { assessSubtitle, explicitMachineLabel, looksLikeHtml } from "../src/quality.js";
import { normalizeSubtitle } from "../src/subtitle.js";
import { scoreCandidate } from "../src/ranker.js";
import { arabicAss, arabicSrt, englishSrt, machineSrt, srtFrom } from "./fixtures.js";

test("accepts a valid human Arabic subtitle from an unknown translator", () => {
  const result = assessSubtitle(arabicSrt(120), { fileName: "Some.Movie.2023.1080p.WEB-DL.srt" });
  assert.equal(result.verdict, "human");
  assert.equal(result.accepted, true);
  assert.ok(result.arabicRatio > 0.9);
  assert.ok(result.humanScore >= 0.7);
});

test("rejects an English subtitle that a provider labelled as Arabic", () => {
  const result = assessSubtitle(englishSrt(120), { fileName: "Movie.2023.ar.srt" });
  assert.equal(result.verdict, "not-arabic");
  assert.equal(result.accepted, false);
});

test("rejects explicitly labelled machine and AI translations", () => {
  for (const name of ["Movie.2023.AI.Translated.ar.srt", "Movie.2023.Google.Translate.srt", "Movie.2023.WhisperX.ar.srt", "Movie.2023.Machine-Translated.srt"]) {
    const result = assessSubtitle(arabicSrt(120), { fileName: name });
    assert.equal(result.verdict, "machine", name);
    assert.equal(result.accepted, false, name);
  }
  assert.equal(assessSubtitle(arabicSrt(120), { comment: "ترجمة آلية بواسطة جوجل" }).verdict, "machine");
  assert.equal(assessSubtitle(arabicSrt(120), { metadataMachineTranslated: true }).verdict, "machine");
  // Titles that merely contain "AI" are not machine labels.
  assert.equal(explicitMachineLabel("A.I.Artificial.Intelligence.2001.1080p.BluRay.srt"), "");
  assert.equal(explicitMachineLabel("Ai.no.Kusabi.S01E01.srt"), "");
});

test("detects repetition loops typical of automated transcription", () => {
  const result = assessSubtitle(machineSrt(120));
  assert.equal(result.verdict, "machine");
  assert.ok(result.reasons.includes("repetition-loop"));
});

test("allows machine translations only when explicitly enabled", () => {
  const result = assessSubtitle(arabicSrt(120), { fileName: "Movie.AI.Translated.srt", allowMachineTranslated: true });
  assert.equal(result.verdict, "machine");
  assert.equal(result.accepted, true);
});

test("ranker drops provider-flagged machine translations before download", () => {
  const context = { media: { type: "movie", imdbId: "1" }, extra: { filename: "Movie.2023.1080p.WEB-DL.mkv" } };
  assert.equal(scoreCandidate({ fileId: 1, fileName: "Movie.2023.1080p.WEB-DL.srt", machineTranslated: true }, context), null);
  assert.equal(scoreCandidate({ fileId: 2, fileName: "Movie.2023.1080p.WEB-DL.AI.translated.srt" }, context), null);
  assert.ok(scoreCandidate({ fileId: 3, fileName: "Movie.2023.1080p.WEB-DL.srt" }, context));
});

test("rejects HTML error pages returned instead of subtitles", () => {
  const page = Buffer.from("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>تحقق</body></html>");
  assert.equal(looksLikeHtml(page), true);
  assert.throws(() => normalizeSubtitle(page, { fileName: "subtitle.srt" }), /HTML/);
  assert.throws(() => normalizeSubtitle(Buffer.from('{"error":"quota"}'), { fileName: "subtitle.srt" }), /HTML or JSON/);
  // SAMI/TTML are markup subtitles, not error pages.
  assert.equal(looksLikeHtml(Buffer.from("<SAMI><BODY><SYNC Start=1000><P>مرحبا</SYNC></BODY></SAMI>")), false);
});

test("styled ASS content is assessed on its dialogue text", () => {
  const result = assessSubtitle(arabicAss(60));
  assert.equal(result.verdict, "human");
});

test("rejects forced or unfinished subtitles with very few cues for a long film", () => {
  // 65 cues spread over two hours.
  const sparse = Array.from({ length: 65 }, (_, index) => ({ start: 60 + index * 110, end: 62 + index * 110 }));
  const srt = srtFrom(sparse, ["نص عربي قصير في ترجمة جزئية.", "سطر آخر من الترجمة الجزئية."]);
  const result = assessSubtitle(srt);
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("partial-or-forced"));
});

test("flags subtitles much longer than the playing video", () => {
  const result = assessSubtitle(arabicSrt(400), { expectedDurationSeconds: 600 });
  assert.ok(result.reasons.includes("longer-than-video"));
  assert.ok(result.humanScore < 0.6);
});
