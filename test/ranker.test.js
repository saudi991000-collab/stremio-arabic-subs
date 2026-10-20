import test from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, resultLabel } from "../src/ranker.js";

const context = {
  media: { type: "series", id: "tt1234567:2:6", imdbId: "1234567", season: 2, episode: 6 },
  extra: { videoHash: "abcd", videoSize: 1234, filename: "Show.Name.S02E06.1080p.WEB-DL.x265-GROUP.mkv" }
};

test("exact hash beats popularity", () => {
  const results = rankCandidates([
    { fileId: 1, fileName: "Show.Name.S02E06.HDTV.mkv.srt", language: "ar", hashMatch: true, fileSize: 1234, downloadCount: 2, featureDetails: { seasonNumber: 2, episodeNumber: 6 } },
    { fileId: 2, fileName: "Show.Name.S02E06.1080p.WEB-DL.x265-GROUP.srt", language: "ar", hashMatch: false, downloadCount: 100000, featureDetails: { seasonNumber: 2, episodeNumber: 6 } }
  ], context);
  assert.equal(results[0].fileId, 1);
  assert.equal(results[0].confidence, 100);
  assert.equal(resultLabel(results[0], { recommended: true }), "💪👍");
});

test("rejects the wrong episode", () => {
  const results = rankCandidates([
    { fileId: 3, fileName: "Show.Name.S02E07.srt", language: "ar", featureDetails: { seasonNumber: 2, episodeNumber: 7 } }
  ], context);
  assert.equal(results.length, 0);
});

test("machine translations are rejected by default", () => {
  const results = rankCandidates([
    { fileId: 4, fileName: "Show.Name.S02E06.srt", language: "ar", machineTranslated: true, featureDetails: { seasonNumber: 2, episodeNumber: 6 } }
  ], context, { allowMachineTranslated: false });
  assert.equal(results.length, 0);
});

test("AI-labelled translations are rejected by default", () => {
  const results = rankCandidates([
    { fileId: 41, fileName: "Show.Name.S02E06.srt", language: "ar", aiTranslated: true, featureDetails: { seasonNumber: 2, episodeNumber: 6 } }
  ], context, { allowMachineTranslated: false });
  assert.equal(results.length, 0);
});

test("human translations remain eligible when AI translations are rejected", () => {
  const results = rankCandidates([
    { fileId: 42, fileName: "Show.Name.S02E06.srt", language: "ar", aiTranslated: false, machineTranslated: false, featureDetails: { seasonNumber: 2, episodeNumber: 6 } }
  ], context, { allowMachineTranslated: false });
  assert.equal(results.length, 1);
});

test("prefers a subtitle from the same streaming platform", () => {
  const platformContext = {
    ...context,
    extra: { ...context.extra, videoHash: "", filename: "Show.Name.S02E06.1080p.NF.WEB-DL.mkv" }
  };
  const results = rankCandidates([
    { fileId: 5, fileName: "Show.Name.S02E06.1080p.Crunchyroll.WEB-DL.srt", language: "ar", featureDetails: { seasonNumber: 2, episodeNumber: 6 } },
    { fileId: 6, fileName: "Show.Name.S02E06.1080p.NETFLIX.WEB-DL.srt", language: "ar", featureDetails: { seasonNumber: 2, episodeNumber: 6 } }
  ], platformContext);
  assert.equal(results[0].fileId, 6);
  assert.ok(results[0].syncScore > results[1].syncScore);
});

test("prefers BluRay over resolution-only matches for a BD Remux video", () => {
  const bdContext = {
    ...context,
    extra: { videoHash: "", filename: "[neovzn] Show.Name.S02E06.BD.Remux.1080p.mkv" }
  };
  const results = rankCandidates([
    { fileId: 7, fileName: "Show.Name.S02E06.1080p.WEB-DL.srt", language: "ar", fromTrusted: true },
    { fileId: 8, fileName: "Show.Name.S02E06.BD.srt", language: "ar" }
  ], bdContext);
  assert.equal(results[0].fileId, 8);
  assert.equal(resultLabel(results[0]), "💪👍");
});

test("prefers an explicit episode release over a season pack", () => {
  const episodeContext = {
    ...context,
    extra: { videoHash: "", filename: "Show.Name.S02E06.BD.Remux.1080p.mkv" }
  };
  const results = rankCandidates([
    { fileId: 9, fileName: "Show Name S2 Complete BD 1080p.srt", language: "ar", rating: 10 },
    { fileId: 10, fileName: "Show Name Ep06 BluRay 720p.srt", language: "ar", rating: 1 }
  ], episodeContext);
  assert.equal(results[0].fileId, 10);
  assert.ok(results[0].confidence > results[1].confidence);
  assert.ok(results[0].syncScore > results[1].syncScore);
});

test("rejects anime releases that explicitly identify another season or episode", () => {
  const animeContext = {
    media: { type: "series", id: "tt0994314:1:8", imdbId: "0994314", season: 1, episode: 8 },
    extra: { videoHash: "", filename: "[neovzn] Code Geass S01E08 BD Remux 1080p.mkv" }
  };
  const results = rankCandidates([
    { fileId: 11, fileName: "Code Geass R2 1.srt", language: "ar" },
    { fileId: 12, fileName: "[gg]-Code-Geass-22-[C585981C].srt", language: "ar" },
    { fileId: 13, fileName: "[Memories] Code Geass R1 - 08 [BD].srt", language: "ar" }
  ], animeContext);
  assert.deepEqual(results.map((item) => item.fileId), [13]);
  assert.ok(results[0].confidence >= 70);
});

test("shows the compact emoji only for a strong release-name match", () => {
  const label = resultLabel({
    confidence: 84,
    fileName: "Anime.S01E08.Colored.ass",
    reasons: ["strong-release-match"]
  }, { recommended: true });
  assert.equal(label, "💪👍");
  assert.doesNotMatch(label, /\d+%/);
  assert.doesNotMatch(label, /SRT|ASS|OpenSubtitles|Anime/);
});

test("uses calibrated confidence before popularity inside the same tier", () => {
  const results = rankCandidates([
    { fileId: 14, fileName: "Code Geass Ep08 720p BluRay.srt", language: "ar", rating: 10, featureDetails: { seasonNumber: 1, episodeNumber: 8 } },
    { fileId: 15, fileName: "Code Geass R1 - 08 BD.srt", language: "ar", rating: 1, featureDetails: { seasonNumber: 1, episodeNumber: 8 } }
  ], {
    media: { type: "series", season: 1, episode: 8 },
    extra: { filename: "Code Geass S01E08 BD Remux 1080p.mkv" }
  });
  assert.equal(results[0].fileId, 15);
  assert.ok(results[0].confidence > results[1].confidence);
});

test("trusts a catalog-scoped single episode without inventing a percentage", () => {
  const results = rankCandidates([
    { fileId: 16, fileName: "Show.Name.S02E06.srt", language: "ar", catalogMatch: true }
  ], context);
  assert.equal(results.length, 1);
  assert.ok(results[0].confidence >= 70);
  assert.ok(results[0].reasons.includes("catalog-match"));
  assert.doesNotMatch(resultLabel(results[0], { recommended: true }), /\d+%/);
});

test("trusts an episode-scoped provider even when its filename is generic", () => {
  const results = rankCandidates([
    { fileId: 160, fileName: "Arabic subtitle.srt", language: "ar", catalogMatch: true, episodeScoped: true }
  ], context);
  assert.equal(results.length, 1);
  assert.ok(results[0].confidence >= 70);
  assert.ok(results[0].reasons.includes("episode-catalog"));
});

test("accepts a movie result scoped to the corrected catalog id", () => {
  const results = rankCandidates([
    { fileId: 17, fileName: "Dune.Part.Two.2024.srt", language: "ar", catalogMatch: true }
  ], {
    media: { type: "movie", id: "tt15239678", imdbId: "15239678" },
    extra: { filename: "Dune.Part.Two.2024.1080p.WEB-DL.mkv" }
  });
  assert.equal(results.length, 1);
  assert.ok(results[0].confidence >= 70);
});

test("leaves ordinary options without noisy text", () => {
  const label = resultLabel({ confidence: 55, reasons: [], fileName: "Show.S02E06.srt" });
  assert.equal(label, "");
  assert.doesNotMatch(label, /\d+%/);
});
