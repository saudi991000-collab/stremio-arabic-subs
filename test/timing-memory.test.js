import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TimingMemory, addOffset, episodeKey, itemId, videoKey } from "../src/timing-memory.js";
import { JsonStore } from "../src/store.js";
import { consensusAlignment, transformDistance } from "../src/deep-analyzer.js";
import { mapTime, parseTimeline } from "../src/timing.js";
import { extractArchive, normalizeSubtitle } from "../src/subtitle.js";
import { isSeasonPackName, pickTitlePath } from "../src/providers/subf2m.js";
import { createAddonServer, seasonPackForEpisode } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { arabicSrt, dialogueTimes, zipStore } from "./fixtures.js";

const shift = (cues, map) => cues.map((cue) => ({ start: map(cue.start), end: map(cue.end) }));
const series = { type: "series", imdbId: "0165581", season: 1, episode: 1 };

async function memory() {
  return new TimingMemory(new JsonStore({ directory: await mkdtemp(path.join(tmpdir(), "timing-memory-")), namespace: "timing", ttlSeconds: 3600 }));
}

test("identifies the playing video by hash first, then file name", () => {
  assert.equal(videoKey({ videoHash: "ABCDEF0123456789", videoSize: 1000, filename: "x.mkv" }), "h:abcdef0123456789:1000");
  assert.equal(videoKey({ filename: "C:/Videos/The.King.of.Queens.S01E01.mkv" }), "f:the.king.of.queens.s01e01.mkv");
  assert.equal(videoKey({}), "");
  assert.equal(episodeKey(series), "tt0165581:1:1");
  assert.equal(itemId({ provider: "subdl", ref: "a" }), itemId({ provider: "subdl", downloadRef: "a" }));
});

test("adds a manual shift to linear and piecewise corrections", () => {
  assert.deepEqual(addOffset(undefined, -2), { scale: 1, offset: -2 });
  assert.deepEqual(addOffset({ scale: 1.04, offset: 1 }, -2), { scale: 1.04, offset: -1 });
  const piecewise = addOffset({ segments: [{ start: -1e9, end: 300, scale: 1, offset: 0 }, { start: 300, end: 1e9, scale: 1, offset: -30 }] }, 1.5);
  assert.deepEqual(piecewise.segments.map((segment) => segment.offset), [1.5, -28.5]);
});

test("keeps the strongest automatic correction for a video", async () => {
  const store = await memory();
  const context = { media: series, extra: { filename: "The.King.of.Queens.S01E01.mkv" } };
  const item = { provider: "subdl", ref: "1" };
  await store.rememberAuto(context, item, { scale: 1, offset: 2, score: 0.9, reference: "audio-whisper" });
  await store.rememberAuto(context, item, { scale: 1, offset: 5, score: 0.95, reference: "release" });
  assert.equal((await store.lookup(context, item)).auto.offset, 2);
  // Another file name is another video: nothing is shared with it.
  assert.deepEqual(await store.lookup({ ...context, extra: { filename: "Other.Release.mkv" } }, item), {});
  // Without a file name or hash the video cannot be identified.
  assert.equal(await store.rememberAuto({ media: series, extra: {} }, item, { scale: 1, offset: 1, score: 1 }), null);
});

test("a manual fix builds on what the viewer last saw and can be undone", async () => {
  const store = await memory();
  const context = { media: series, extra: { filename: "The.King.of.Queens.S01E01.mkv" } };
  const item = { provider: "subdl", ref: "1" };
  await store.recordServed(context, item, { scale: 1, offset: 3 }, "Netflix SubDL");
  const [recent] = await store.recent();
  assert.equal(recent.item, itemId(item));
  assert.equal(recent.season, 1);
  await store.fix(recent.key, recent.item, { seconds: -1.5 });
  assert.equal((await store.lookup(context, item)).manual.offset, 1.5);
  // Second correction on top of the first one that was then served.
  await store.recordServed(context, item, (await store.lookup(context, item)).manual, "Netflix SubDL");
  await store.fix(recent.key, recent.item, { seconds: 0.5 });
  assert.equal((await store.lookup(context, item)).manual.offset, 2);
  await store.fix(recent.key, recent.item, { reset: true });
  assert.equal((await store.lookup(context, item)).manual, undefined);
  await assert.rejects(store.fix("timing:v1:x|f:y", "0123456789abcdef", { seconds: 1 }), /Unknown subtitle/);
  await assert.rejects(store.fix("bad", "zz", { seconds: 1 }), /Unknown subtitle/);
});

test("trusts a correction more when two references agree", () => {
  const reference = dialogueTimes(700, { start: 20, seed: 11 });
  const candidate = shift(reference, (t) => t + 3.4);
  const one = consensusAlignment([{ timeline: reference, kind: "release" }], candidate);
  const two = consensusAlignment([{ timeline: reference, kind: "release" }, { timeline: shift(reference, (t) => t + 0.05), kind: "release" }], candidate);
  assert.equal(two.agreeing, 1);
  assert.equal(two.kind, "consensus");
  assert.ok(two.alignment.confidence >= one.alignment.confidence, `${two.alignment.confidence} vs ${one.alignment.confidence}`);
  // A weaker single match is lifted above the 0.6 correction threshold.
  const weak = consensusAlignment([{ timeline: reference, kind: "release" }, { timeline: reference, kind: "release" }], candidate);
  assert.ok(weak.alignment.confidence > 0.6);
  assert.ok(Math.abs(mapTime(1000, two.alignment) - 996.6) < 0.2);
});

test("refuses a correction when release references disagree", () => {
  const reference = dialogueTimes(700, { start: 20, seed: 11 });
  const candidate = shift(reference, (t) => t + 3.4);
  const result = consensusAlignment([
    { timeline: reference, kind: "release" },
    { timeline: shift(reference, (t) => t + 4), kind: "release" }
  ], candidate);
  assert.equal(result.conflicting, 1);
  assert.ok(result.alignment.confidence <= 0.45);
});

test("an English release file cannot overrule the video's own timing", () => {
  const reference = dialogueTimes(700, { start: 20, seed: 11 });
  const candidate = shift(reference, (t) => t + 3.4);
  const result = consensusAlignment([
    { timeline: shift(reference, (t) => t + 4), kind: "release" },
    { timeline: reference, kind: "exact-hash" }
  ], candidate);
  assert.equal(result.kind, "exact-hash");
  assert.equal(result.conflicting, 0);
  assert.ok(Math.abs(mapTime(1000, result.alignment) - 996.6) < 0.2);
  assert.ok(transformDistance({ scale: 1, offset: 0 }, { scale: 1, offset: 1 }, reference) === 1);
});

test("a season pack must contain the episode as a named file", () => {
  const single = Buffer.from(arabicSrt(30));
  assert.throws(() => normalizeSubtitle(single, { season: 1, episode: 1, requireEpisodeEntry: true }), /requested episode 1/);
  const lone = zipStore([{ name: "Arabic.srt", data: arabicSrt(30) }]);
  assert.throws(() => extractArchive(lone, { season: 1, episode: 1, requireEpisodeEntry: true }), /requested episode 1/);
  const pack = zipStore([
    { name: "Show.S01E01.srt", data: arabicSrt(30, { lines: ["الحلقة الأولى من الموسم."] }) },
    { name: "Show.S01E02.srt", data: arabicSrt(30, { lines: ["الحلقة الثانية من الموسم."] }) }
  ]);
  assert.match(normalizeSubtitle(pack, { season: 1, episode: 1, requireEpisodeEntry: true }).buffer.toString("utf8"), /الأولى/);
  // Single files stay accepted when the result is not a pack.
  assert.ok(normalizeSubtitle(single, { season: 1, episode: 1 }).buffer.length);
});

test("never picks an episode from another season's folder", () => {
  const archive = zipStore([
    { name: "Season 3/01 - Strike One.srt", data: arabicSrt(30, { lines: ["الموسم الثالث من المسلسل."] }) },
    { name: "Season 1/01 - Pilot.srt", data: arabicSrt(30, { lines: ["الموسم الأول من المسلسل."] }) }
  ]);
  assert.match(extractArchive(archive, { season: 1, episode: 1 }).buffer.toString("utf8"), /الأول/);
  const onlyThird = zipStore([
    { name: "Season 3/01.srt", data: arabicSrt(30) },
    { name: "Season 3/02.srt", data: arabicSrt(30) }
  ]);
  assert.throws(() => extractArchive(onlyThird, { season: 1, episode: 1 }), /requested episode 1/);
});

test("recognises season packs for the requested season only", () => {
  assert.equal(isSeasonPackName("The.King.of.Queens.S01.1080p.NF.WEB-DL.DUAL.AAC2.0.H.264-TURG", 1), true);
  assert.equal(isSeasonPackName("The King of Queens S01 01-11", 1), true);
  assert.equal(isSeasonPackName("The King of Queens Season 3", 3), true);
  assert.equal(isSeasonPackName("The.King.of.Queens.S03.NF", 1), false);
  assert.equal(isSeasonPackName("The.King.Of.Queens.S01E13.DVDRip", 1), false);
  assert.equal(isSeasonPackName("The King of Queens 01x14 - Dog Days", 1), false);
  const pack = (name, details) => ({ reasons: ["series", "season-pack"], fileName: name, featureDetails: details });
  assert.equal(seasonPackForEpisode(pack("Show.S01.1080p.NF.zip"), series), true);
  assert.equal(seasonPackForEpisode(pack("Show.S02.1080p.NF.zip"), series), false);
  assert.equal(seasonPackForEpisode(pack("Show.Complete.Series.zip"), series), false);
  assert.equal(seasonPackForEpisode(pack("Arabic.zip", { seasonNumber: 1 }), series), true);
});

test("finds the Subf2m season page from its title search", () => {
  const html = `<a href="/subtitles/king-of-queens">x</a><a href="/subtitles/the-king-of-queens--first-season">x</a>
    <a href="/subtitles/the-king-of-queens-third-season">x</a><a href="/subtitles/searchbytitle?query=x">x</a>`;
  assert.equal(pickTitlePath(html, "The King of Queens", { media: { type: "series", season: 1 } }), "/subtitles/the-king-of-queens--first-season");
  assert.equal(pickTitlePath(html, "The King of Queens", { media: { type: "series", season: 3 } }), "/subtitles/the-king-of-queens-third-season");
  assert.equal(pickTitlePath(html, "The King of Queens", { media: { type: "series", season: 2 } }), null);
  assert.equal(pickTitlePath(html, "King of Queens", { media: { type: "movie" } }), "/subtitles/king-of-queens");
});

async function withServer(provider, env, callback) {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "timing-server-"));
  const config = readConfig({ PORT: "7000", CACHE_DIRECTORY: cacheDirectory, URL_TOKEN_SECRET: "test-secret", OPENSUBTITLES_API_KEY: "mock", ...env });
  const server = await createAddonServer({ config, provider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, server); }
  finally {
    await server.flushBackground();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a timing fix from the /timing page reaches every later download", async () => {
  const srt = Buffer.from(arabicSrt(40, { start: 10 }));
  const provider = {
    async search() {
      return [{ fileId: 31, fileName: "The.King.of.Queens.S01E01.srt", language: "ar", featureDetails: { seasonNumber: 1, episodeNumber: 1 } }];
    },
    async download() {
      return { buffer: srt, fileName: "The.King.of.Queens.S01E01.srt" };
    }
  };
  await withServer(provider, { TIMING_FIX_KEY: "secret-key" }, async (base, server) => {
    const listing = await (await fetch(`${base}/subtitles/series/tt0165581:1:1/filename=The.King.of.Queens.S01E01.mkv.json`)).json();
    const url = listing.subtitles[0].url;
    const before = parseTimeline(await (await fetch(url)).text());
    await server.flushBackground();

    // From outside this computer (behind a proxy) the key is required.
    assert.equal((await fetch(`${base}/timing/recent`, { headers: { "X-Forwarded-For": "203.0.113.9" } })).status, 403);
    const recent = await (await fetch(`${base}/timing/recent`, { headers: { "X-Forwarded-For": "203.0.113.9", "X-Timing-Key": "secret-key" } })).json();
    assert.equal(recent.recent.length, 1);
    const fixed = await fetch(`${base}/timing/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9", "X-Timing-Key": "secret-key" },
      body: JSON.stringify({ key: recent.recent[0].key, item: recent.recent[0].item, seconds: -2 })
    });
    assert.equal(fixed.status, 200);

    const after = parseTimeline(await (await fetch(url)).text());
    assert.ok(Math.abs(after[0].start - (before[0].start - 2)) < 0.01, `${before[0].start} -> ${after[0].start}`);
    const page = await fetch(`${base}/timing`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /تصحيح توقيت الترجمة/);
    const bad = await fetch(`${base}/timing/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Timing-Key": "secret-key" },
      body: JSON.stringify({ key: recent.recent[0].key, item: recent.recent[0].item, seconds: 5000 })
    });
    assert.equal(bad.status, 400);
  });
});
