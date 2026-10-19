import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAddonServer } from "../src/server.js";
import { readConfig } from "../src/config.js";

async function withServer(provider, callback) {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "arabic-sync-test-"));
  const config = readConfig({ PORT: "7000", CACHE_DIRECTORY: cacheDirectory, URL_TOKEN_SECRET: "test-secret", OPENSUBTITLES_API_KEY: "mock" });
  const server = await createAddonServer({ config, provider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("serves a valid manifest", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/manifest.json`);
    const value = await response.json();
    assert.equal(value.id, "org.arabic.elitesubs.v3");
    assert.deepEqual(value.resources, [{ name: "subtitles", types: ["movie", "series"] }]);
  });
});

test("returns the exact hash result first in top-ten mode", async () => {
  const provider = {
    async search() {
      return [
        { fileId: 10, fileName: "Movie.2025.WEB-DL.srt", language: "ar", hashMatch: false, catalogMatch: true, downloadCount: 99999 },
        { fileId: 11, fileName: "Movie.2025.BluRay.srt", language: "ar", hashMatch: true, catalogMatch: true }
      ];
    }
  };
  await withServer(provider, async (base) => {
    const response = await fetch(`${base}/subtitles/movie/tt1234567/videoHash=abc&filename=Movie.2025.BluRay.mkv.json`);
    const value = await response.json();
    assert.equal(value.subtitles.length, 2);
    assert.equal(value.subtitles[0].label, "1 | ✅ موثوقة | SRT | مصدر");
    assert.equal(value.subtitles[0].lang, "ara");
  });
});

test("labels styled ASS subtitles and serves them without stripping styles", async () => {
  const ass = Buffer.from(`[Script Info]\nTitle: Styled Arabic\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:04.00,Top,,0,0,0,,{\\an8\\c&H00FFFF&}ترجمة عربية ملونة في أعلى الشاشة`);
  const provider = {
    async search() {
      return [{ fileId: 20, fileName: "Anime.S01E07.Styled.ass", language: "ar", featureDetails: { seasonNumber: 1, episodeNumber: 7 } }];
    },
    async download() {
      return { buffer: ass, fileName: "Anime.S01E07.Styled.ass" };
    }
  };
  await withServer(provider, async (base) => {
    const listing = await (await fetch(`${base}/subtitles/series/tt1234567:1:7/filename=Anime.S01E07.mkv.json`)).json();
    assert.match(listing.subtitles[0].label, /💪/);
    assert.match(listing.subtitles[0].url, /\.ass$/);
    const response = await fetch(listing.subtitles[0].url);
    assert.match(response.headers.get("content-type"), /text\/x-ssa/);
    assert.match(await response.text(), /\\an8\\c&H00FFFF&/);
  });
});

test("returns at most twenty-five labeled subtitle choices", async () => {
  const provider = {
    async search() {
      return Array.from({ length: 25 }, (_, index) => ({
        fileId: index + 1,
        fileName: `Show.S01E07.Release${String.fromCharCode(65 + index)}.srt`,
        language: "ar",
        featureDetails: { seasonNumber: 1, episodeNumber: 7 }
      }));
    }
  };
  await withServer(provider, async (base) => {
    const listing = await (await fetch(`${base}/subtitles/series/tt1234567:1:7/filename=Show.S01E07.mkv.json`)).json();
    assert.equal(listing.subtitles.length, 25);
    assert.match(listing.subtitles[0].label, /مطابقة|موثوقة/);
    assert.doesNotMatch(listing.subtitles[0].label, /\d+%/);
    assert.match(listing.subtitles[0].label, /SRT/);
    assert.doesNotMatch(listing.subtitles[0].label, /Show|Release/);
  });
});

test("falls back to another ranked subtitle when the selected download is invalid", async () => {
  const valid = Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nهذه ترجمة عربية صالحة للاختبار البديل.\n");
  const provider = {
    async search() {
      return [
        { fileId: 1, fileName: "Movie.2025.BluRay.srt", language: "ar", hashMatch: true, catalogMatch: true },
        { fileId: 2, fileName: "Movie.2025.WEB-DL.srt", language: "ar", hashMatch: false, catalogMatch: true }
      ];
    },
    async download(item) {
      return { buffer: item.ref === 1 ? Buffer.from("invalid") : valid, fileName: "subtitle.srt" };
    }
  };
  await withServer(provider, async (base) => {
    const listing = await (await fetch(`${base}/subtitles/movie/tt1234567/videoHash=abc&filename=Movie.2025.BluRay.mkv.json`)).json();
    const response = await fetch(listing.subtitles[0].url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ترجمة عربية صالحة/);
  });
});

test("rejects an implausibly long series subtitle and uses a sane fallback", async () => {
  const long = Buffer.from("1\n02:00:00,000 --> 02:00:02,000\nهذه ترجمة فيلم طويلة وليست حلقة صحيحة.\n");
  const short = Buffer.from("1\n00:01:00,000 --> 00:01:02,000\nهذه ترجمة الحلقة الصحيحة والقصيرة.\n");
  const provider = {
    async search() {
      return [
        { fileId: 1, fileName: "Show.S01E07.Bad.srt", language: "ar", hashMatch: true, featureDetails: { seasonNumber: 1, episodeNumber: 7 } },
        { fileId: 2, fileName: "Show.S01E07.Good.srt", language: "ar", featureDetails: { seasonNumber: 1, episodeNumber: 7 } }
      ];
    },
    async download(item) {
      return { buffer: item.ref === 1 ? long : short, fileName: "subtitle.srt" };
    }
  };
  await withServer(provider, async (base) => {
    const listing = await (await fetch(`${base}/subtitles/series/tt1234567:1:7/videoHash=abc&filename=Show.S01E07.mkv.json`)).json();
    const response = await fetch(listing.subtitles[0].url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /الحلقة الصحيحة/);
  });
});
