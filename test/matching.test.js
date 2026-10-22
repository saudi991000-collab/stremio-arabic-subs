import test from "node:test";
import assert from "node:assert/strict";
import { looseEpisodeNumber, parseReleaseName } from "../src/media.js";
import { rankCandidates, releaseMatched, scoreCandidate } from "../src/ranker.js";
import { absoluteEpisodeFromVideos } from "../src/id-resolver.js";
import { findArabicTeam, compileTeams } from "../src/teams.js";

const movie = (filename, extra = {}) => ({ media: { type: "movie", imdbId: "10872600", ...extra }, extra: { filename } });
const series = (filename, season, episode, extra = {}) => ({ media: { type: "series", imdbId: "3581920", season, episode, ...extra }, extra: { filename } });

test("movies: matches the same film across slightly different release names", () => {
  const context = movie("Spider-Man.No.Way.Home.2021.1080p.BluRay.x264-SPARKS.mkv");
  const scored = scoreCandidate({ fileId: 1, fileName: "Spider.Man.No.Way.Home.2021.1080p.BluRay.x264-SPARKS.ar.srt" }, context);
  assert.ok(releaseMatched(scored));
  const near = scoreCandidate({ fileId: 2, fileName: "Spider-Man.No.Way.Home.2021.720p.BluRay.x264-GalaxyRG.srt" }, context);
  assert.ok(near && near.reasons.includes("same-title"));
});

test("movies: rejects partially similar but different titles and years", () => {
  const context = movie("Dune.Part.Two.2024.1080p.WEB-DL.mkv", { imdbId: "" });
  assert.equal(scoreCandidate({ fileId: 1, fileName: "Dune.1984.1080p.BluRay.srt" }, context), null);
  assert.equal(scoreCandidate({ fileId: 2, fileName: "Spider.Man.Homecoming.2017.srt" }, movie("Spider.Man.No.Way.Home.2021.mkv", { imdbId: "" })), null);
});

test("TV: keeps the requested episode and rejects other episodes and seasons", () => {
  const context = series("The.Last.of.Us.S01E03.1080p.WEB-DL.mkv", 1, 3);
  assert.ok(scoreCandidate({ fileId: 1, fileName: "The.Last.of.Us.S01E03.Long.Long.Time.1080p.AMZN.WEB-DL.srt" }, context));
  assert.equal(scoreCandidate({ fileId: 2, fileName: "The.Last.of.Us.S01E04.1080p.WEB-DL.srt" }, context), null);
  assert.equal(scoreCandidate({ fileId: 3, fileName: "The.Last.of.Us.S02E03.1080p.WEB-DL.srt" }, context), null);
  assert.equal(scoreCandidate({ fileId: 4, fileName: "x.srt", featureDetails: { seasonNumber: 1, episodeNumber: 5 } }, context), null);
});

test("rejects wrong-season files, other shows and extras even when the catalogue mislabels them", () => {
  const anime = series("Code.Geass.S01E01.1080p.BluRay.mkv", 1, 1, { imdbId: "0994314", catalogTitle: "Code Geass: Lelouch of the Rebellion" });
  const scoped = { featureDetails: { seasonNumber: 1, episodeNumber: 1 } };
  assert.equal(scoreCandidate({ fileId: 1, fileName: "[DeadFish] Code Geass R2 - 01 [BD][720p][AAC].srt", ...scoped }, anime), null);
  assert.ok(scoreCandidate({ fileId: 2, fileName: "[Memories] Code Geass - Hangyaku no Lelouch R1 - 01 [BD].ass", ...scoped }, anime));
  const tlou = series("The.Last.of.Us.S01E01.1080p.WEB-DL.mkv", 1, 1, { catalogTitle: "The Last of Us" });
  assert.equal(scoreCandidate({ fileId: 3, fileName: "Lost.S01E01.1080p.BluRay.x265.srt", ...scoped }, tlou), null);
  assert.equal(scoreCandidate({ fileId: 4, fileName: "The Last of Us Cinematic Playthrough- Episode 1.ass", ...scoped }, tlou), null);
  assert.ok(scoreCandidate({ fileId: 5, fileName: "The.Last.of.Us.S01E01.HMAX.WEB-SMURF.srt", ...scoped }, tlou));
  assert.equal(scoreCandidate({ fileId: 6, fileName: "The.Last.Days.of.Ptolemy.Grey.S01E01.720p.ATVP.WEB-DL.srt", ...scoped }, tlou), null);
  assert.equal(scoreCandidate({ fileId: 7, fileName: "Blood-C:.The.Last.Dark.S01E01.Mirai.1.ass", ...scoped }, tlou), null);
});

test("keeps one copy of a file mirrored by the OpenSubtitles family", () => {
  const context = movie("Movie.2021.1080p.BluRay-EVO.mkv");
  const ranked = rankCandidates([
    { provider: "opensubtitles", fileId: 1, fileName: "Movie.2021.1080p.BluRay-EVO.srt" },
    { provider: "opensubtitles-org", fileId: "2", fileName: "Movie.2021.1080p.BluRay-EVO.srt" },
    { provider: "stremio-v3", fileId: "3", fileName: "Movie.2021.1080p.BluRay-EVO.srt" },
    { provider: "wyzie", fileId: "4", origin: "opensubtitles", fileName: "Movie.2021.1080p.BluRay-EVO.srt" },
    { provider: "subsource", fileId: 5, fileName: "Movie.2021.1080p.BluRay-EVO.srt" }
  ], context);
  assert.deepEqual(ranked.map((item) => item.provider).sort(), ["opensubtitles-org", "subsource"]);
});

test("anime without a filename matches the romaji and English catalogue titles", () => {
  const context = { media: { type: "series", imdbId: "21423786", season: 1, episode: 1, absoluteEpisode: 1, title: "Boku no Kokoro no Yabai Yatsu", catalogTitle: "The Dangers in My Heart" }, extra: { filename: "" } };
  const scoped = { featureDetails: { seasonNumber: 1, episodeNumber: 1 } };
  const romaji = scoreCandidate({ fileId: 1, fileName: "[Aiz-san Sub] Boku no Kokoro no Yabai Yatsu - 01.ass", ...scoped }, context);
  assert.ok(romaji && releaseMatched(romaji));
  const english = scoreCandidate({ fileId: 2, fileName: "The.Dangers.in.My.Heart.S01E01.1080p.WEB.srt", ...scoped }, context);
  assert.ok(english && releaseMatched(english));
  assert.equal(scoreCandidate({ fileId: 3, fileName: "Spy.x.Family.S01E01.1080p.srt", ...scoped }, context), null);
  // With only the English title known, romaji-named files are kept (not rejected).
  const englishOnly = { ...context, media: { ...context.media, title: undefined } };
  assert.ok(scoreCandidate({ fileId: 4, fileName: "[Aiz-san Sub] Boku no Kokoro no Yabai Yatsu - 01.ass", ...scoped }, englishOnly));
});

test("TV: season packs never receive the release-match badge", () => {
  const context = series("Show.S01E03.1080p.WEB-DL.mkv", 1, 3);
  const pack = scoreCandidate({ fileId: 1, fileName: "Show.S01.Complete.1080p.WEB-DL.srt" }, context);
  assert.ok(pack.reasons.includes("season-pack"));
  assert.equal(releaseMatched(pack), false);
});

test("anime: matches absolute episode numbers to Stremio season/episode", () => {
  const context = series("[SubsPlease] One Piece - 1085 (1080p).mkv", 21, 193, { imdbId: "0388629", absoluteEpisode: 1085 });
  assert.equal(parseReleaseName("[Erai-raws] One Piece - 1085 [1080p].ass").absoluteEpisode, 1085);
  const scored = scoreCandidate({ fileId: 1, fileName: "[3ASQ] One Piece - 1085 [1080p].ass" }, context);
  assert.ok(scored, "absolute number should be accepted");
  assert.ok(scored.reasons.includes("absolute-episode"));
  assert.equal(scoreCandidate({ fileId: 2, fileName: "[3ASQ] One Piece - 1086 [1080p].ass" }, context), null);
  const videos = [{ season: 0, episode: 1 }, { season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 2, episode: 1 }];
  assert.equal(absoluteEpisodeFromVideos(videos, 2, 1), 3);
});

test("exact video hash ranks first and is always badge-matched", () => {
  const context = { media: { type: "movie", imdbId: "1" }, extra: { filename: "Movie.2025.BluRay.mkv", videoHash: "8e245d9679d31e12" } };
  const ranked = rankCandidates([
    { provider: "a", fileId: 1, fileName: "Movie.2025.WEB-DL.srt", downloadCount: 99999 },
    { provider: "b", fileId: 2, fileName: "Movie.2025.Other.srt", hashMatch: true }
  ], context);
  assert.equal(ranked[0].fileId, 2);
  assert.equal(ranked[0].tier, 4);
  assert.ok(releaseMatched(ranked[0]));
});

test("parses frame rate, platform markers and release groups", () => {
  assert.equal(parseReleaseName("Movie.2020.23.976fps.1080p.WEB-DL.srt").fps, 23.976);
  assert.equal(parseReleaseName("Movie.2020.25fps.srt").fps, 25);
  assert.equal(parseReleaseName("Show.S01E01.1080p.NF.WEB-DL.DDP5.1.x264-NTb.mkv").platform, "netflix");
  assert.equal(parseReleaseName("Show.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv").platform, "crunchyroll");
  assert.equal(parseReleaseName("Show.S01E01.1080p.DSNP.WEB-DL.mkv").platform, "disney");
  assert.equal(parseReleaseName("Show.S01E01.1080p.AMZN.WEB-DL.mkv").platform, "amazon");
  // "Max" in a title is not a platform marker.
  assert.equal(parseReleaseName("Mad.Max.Fury.Road.2015.1080p.BluRay.mkv").platform, undefined);
  assert.equal(parseReleaseName("Show.S01E01.1080p.WEB-DL-NTb.mkv").group, "ntb");
});

test("same FPS adds sync evidence; different FPS does not", () => {
  const context = movie("Movie.2020.1080p.BluRay.23.976fps.mkv");
  const same = scoreCandidate({ fileId: 1, fileName: "Movie.2020.1080p.BluRay.srt", fps: 23.976 }, context);
  const other = scoreCandidate({ fileId: 2, fileName: "Movie.2020.1080p.BluRay.srt", fps: 25 }, context);
  assert.ok(same.reasons.includes("same-fps"));
  assert.ok(!other.reasons.includes("same-fps"));
  assert.ok(same.syncScore > other.syncScore);
});

test("Arabic teams come from the extensible configuration", () => {
  assert.equal(findArabicTeam({ fileName: "[3ASQ] Show - 07.ass" }), "3ASQ");
  assert.equal(findArabicTeam({ fileName: "Show.S01E07.Aboody.Subs.srt" }), "Aboody Subs");
  assert.equal(findArabicTeam({ provider: "miraianime", fileName: "x.ass" }), "Mirai Fansubs");
  assert.equal(findArabicTeam({ fileName: "Movie.2020.1080p.srt", uploader: "random" }), "");
  const custom = compileTeams({ teams: [{ name: "New Team", aliases: ["new team subs"] }] });
  assert.equal(findArabicTeam({ fileName: "Show.New.Team.Subs.S01E01.srt" }, custom), "New Team");
  // Regex-like aliases are treated as plain text (no ReDoS possible).
  const tricky = compileTeams({ teams: [{ name: "X", aliases: ["(a+)+$"] }] });
  assert.equal(findArabicTeam({ fileName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" }, tricky), "");
});

test("rejects season-pack files whose episode number is glued to the title", () => {
  const context = series("", 1, 10, { imdbId: "0994314", title: "Code Geass: Hangyaku no Lelouch", catalogTitle: "Code Geass: Lelouch of the Rebellion", absoluteEpisode: 10 });
  context.extra.filename = "";
  const scoped = { episodeScoped: true };
  for (const name of ["code-geass13.srt", "code-geass05.srt", "Code Geass 11.srt", "code-geass19.srt"]) {
    assert.equal(scoreCandidate({ fileId: name, fileName: name, ...scoped }, context), null, name);
  }
  assert.ok(scoreCandidate({ fileId: "ok", fileName: "code-geass10.srt", ...scoped }, context));
  assert.equal(looseEpisodeNumber("Show.1080p.WEB.x264.srt"), undefined);
  assert.equal(looseEpisodeNumber("Show.2160p.HEVC.DDP5.1.srt"), undefined);
  assert.equal(looseEpisodeNumber("SUBDL::show-arabic-3258002.zip"), undefined);
  // A number that is part of the title is not an episode number.
  const mob = series("", 1, 1, { imdbId: "5897304", title: "Mob Psycho 100" });
  mob.extra.filename = "";
  assert.ok(scoreCandidate({ fileId: "m", fileName: "Mob Psycho 100.srt", episodeScoped: true, featureDetails: { seasonNumber: 1, episodeNumber: 1 } }, mob));
});
