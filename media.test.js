import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseName, parseVideoId, releaseTitle, titleSimilarity, titlesLikelyMatch } from "../src/media.js";

test("parses a series release", () => {
  const value = parseReleaseName("Show.Name.S02E06.1080p.WEB-DL.x265-GROUP.mkv");
  assert.equal(value.season, 2);
  assert.equal(value.episode, 6);
  assert.equal(value.source, "web-dl");
  assert.equal(value.resolution, "1080p");
  assert.equal(value.group, "group");
});

test("parses a Stremio series id", () => {
  assert.deepEqual(parseVideoId("series", "tt1234567:3:9"), { type: "series", id: "tt1234567:3:9", imdbId: "1234567", season: 3, episode: 9 });
});

test("recognizes streaming release platforms", () => {
  assert.equal(parseReleaseName("Show.S01E07.1080p.NF.WEB-DL.mkv").platform, "netflix");
  assert.equal(parseReleaseName("Show.S01E07.Crunchyroll.WEB-DL.mkv").platform, "crunchyroll");
  assert.equal(parseReleaseName("Show.S01E07.AMZN.WEB-DL.mkv").platform, "amazon");
});

test("recognizes BD Remux and bracketed release groups", () => {
  const remux = parseReleaseName("[neovzn] Code Geass - S01E07v2 (BD Remux 1080p FLAC).mkv");
  assert.equal(remux.source, "remux");
  assert.equal(remux.group, "neovzn");
  assert.equal(parseReleaseName("[Memories-Fansub] Code Geass S01E07 [BD 1080p].srt").source, "bluray");
});

test("extracts the work title before episode and release metadata", () => {
  assert.equal(releaseTitle("Wednesday.S01E02.Woe.is.the.Loneliest.Number.2160p.NF.WEB-DL.mkv"), "wednesday");
  assert.equal(releaseTitle("[NanakoRaws] Koori no Jouheki - 04 (AT-X 1080p HEVC AAC).mkv"), "koori no jouheki");
  assert.equal(titlesLikelyMatch("Koori no Jouheki - 04.mkv", "Koori no Jyouheki"), true);
  assert.equal(titlesLikelyMatch("Wednesday.S01E02.mkv", "Death Note"), false);
  assert.ok(titleSimilarity("Boku no Hero Academia S07E03", "Boku no Hero Akademia 03") >= 0.45);
});
