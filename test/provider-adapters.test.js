import test from "node:test";
import assert from "node:assert/strict";
import { SubDLProvider } from "../src/providers/subdl.js";
import { SubSourceProvider } from "../src/providers/subsource.js";
import { ArabicSubsProvider } from "../src/providers/arabicsubs.js";
import { OpenSubtitlesProvider } from "../src/providers/opensubtitles.js";
import { StremioV3Provider } from "../src/providers/stremio-v3.js";

const context = {
  media: { type: "series", imdbId: "994314", season: 1, episode: 7 },
  extra: { filename: "Code.Geass.S01E07.1080p.WEB-DL.mkv" }
};

async function withMockFetch(handler, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await callback(); }
  finally { globalThis.fetch = original; }
}

test("maps Arabic SubDL episode results", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ status: true, subtitles: [{ release_name: "Code.Geass.S01E07.WEB-DL", season: 1, episode: 7, unpack_files: [{ file_n_id: "f1", name: "Code.Geass.S01E07.srt", language: "AR", season: 1, episode: 7, url: "/subtitle/n1/f1" }] }] }), { status: 200 }), async () => {
    const provider = new SubDLProvider({ apiKey: "test", baseUrl: "https://api.subdl.com/api/v1" });
    const results = await provider.search(context);
    assert.equal(results[0].provider, "subdl");
    assert.equal(results[0].featureDetails.episodeNumber, 7);
  });
});

test("searches SubDL by the played filename when IMDb conflicts", async () => {
  let requested;
  await withMockFetch(async (url) => {
    requested = new URL(String(url));
    return new Response(JSON.stringify({ status: true, subtitles: [] }), { status: 200 });
  }, async () => {
    const provider = new SubDLProvider({ apiKey: "test", baseUrl: "https://api.subdl.com/api/v1" });
    await provider.search({ media: { type: "series", imdbId: "", season: 1, episode: 2 }, extra: { filename: "Wednesday.S01E02.2160p.NF.WEB-DL.mkv" } });
  });
  assert.equal(requested.searchParams.get("file_name"), "Wednesday.S01E02.2160p.NF.WEB-DL.mkv");
  assert.equal(requested.searchParams.has("imdb_id"), false);
});

test("uses the parent IMDb id for a series and only falls back to the filename when needed", async () => {
  const urls = [];
  await withMockFetch(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [], total_pages: 1 }), { status: 200 });
  }, async () => {
    const provider = new OpenSubtitlesProvider({ apiKey: "test", baseUrl: "https://api.opensubtitles.com/api/v1", userAgent: "test" });
    await provider.search(context, 2);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /parent_imdb_id=994314/);
    assert.match(urls[0], /type=episode/);
    assert.doesNotMatch(urls[0], /[?&]query=/);
    assert.match(urls[1], /[?&]query=code.geass.s01e07.1080p.web-dl/);
    assert.doesNotMatch(urls[1], /parent_imdb_id=/);
  });
});

test("uses imdb_id rather than parent_imdb_id for movies", async () => {
  const urls = [];
  await withMockFetch(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [{ attributes: { language: "ar", files: [{ file_id: 5, file_name: "Dune.Part.Two.2024.srt" }] } }], total_pages: 1 }), { status: 200 });
  }, async () => {
    const provider = new OpenSubtitlesProvider({ apiKey: "test", baseUrl: "https://api.opensubtitles.com/api/v1", userAgent: "test" });
    await provider.search({ media: { type: "movie", imdbId: "15239678" }, extra: { filename: "Dune.Part.Two.2024.mkv" } }, 1);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /imdb_id=15239678/);
    assert.doesNotMatch(urls[0], /parent_imdb_id=/);
    assert.match(urls[0], /type=movie/);
    assert.match(urls[1], /[?&]query=dune.part.two.2024/);
  });
});

test("uses only Arabic results from Stremio v3", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ subtitles: [
    { id: "ar1", lang: "ara", url: "https://subs5.strem.io/ar.srt", subtitleFileName: "Show.S01E07.ar.srt", season: 1, episode: 7 },
    { id: "en1", lang: "eng", url: "https://subs5.strem.io/en.srt", subtitleFileName: "Show.S01E07.en.srt", season: 1, episode: 7 }
  ] }), { status: 200 }), async () => {
    const provider = new StremioV3Provider();
    const arabic = await provider.search(context);
    assert.equal(arabic.length, 1);
    assert.equal(arabic[0].language, "ar");
  });
});

test("uses an English release match as a timing reference when an exact hash reference is unavailable", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({
    data: [{
      attributes: {
        language: "en",
        release: "Code.Geass.S01E07.1080p.WEB-DL",
        feature_details: { season_number: 1, episode_number: 7 },
        files: [{ file_id: 777, file_name: "Code.Geass.S01E07.1080p.WEB-DL.en.srt" }]
      }
    }],
    total_pages: 1
  }), { status: 200 }), async () => {
    const provider = new OpenSubtitlesProvider({ apiKey: "test", baseUrl: "https://api.opensubtitles.com/api/v1", userAgent: "test" });
    const reference = await provider.findTimingReference(context);
    assert.equal(reference.fileId, 777);
    assert.equal(reference.timingReferenceKind, "release");
  });
});

test("maps Arabic SubSource results", async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    const payload = calls === 1
      ? { data: [{ movieId: 55 }] }
      : { data: [{ subtitleId: 77, movieId: 55, releaseInfo: ["Code.Geass.S01E07.WEB-DL"], rating: { good: 9, bad: 1 }, preview: "﻿[Script Info]\nTitle: Arabic" }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }, async () => {
    const provider = new SubSourceProvider({ apiKey: "test", baseUrl: "https://api.subsource.net/api/v1" });
    const results = await provider.search(context);
    assert.equal(results[0].provider, "subsource");
    assert.equal(results[0].fileId, 77);
    assert.match(results[0].fileName, /S01E07/);
    assert.match(results[0].fileName, /\.srt$/);
    assert.equal(results[0].featureDetails.episodeNumber, undefined);
  });
});

test("maps ArabicSubs filename matches", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ matches: [{ id: 88, originalFilename: "Code.Geass.S01E07.WEB-DL.srt", releaseLabel: "WEB-DL", downloadUrl: "/api/v1/subtitles/88/download" }] }), { status: 200 }), async () => {
    const provider = new ArabicSubsProvider({ apiKey: "test", baseUrl: "https://arabicsubs.com/api/v1" });
    const results = await provider.search(context);
    assert.equal(results[0].provider, "arabicsubs");
    assert.equal(results[0].fileId, 88);
  });
});

test("rejects unrelated ArabicSubs series matches", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ matches: [
    { id: 90, originalFilename: "House.Of.The.Dragon.S03E08.1080p.WEB-DL.srt" },
    { id: 91, originalFilename: "Unrelated.Movie.2026.srt" }
  ] }), { status: 200 }), async () => {
    const provider = new ArabicSubsProvider({ apiKey: "test", baseUrl: "https://arabicsubs.com/api/v1" });
    assert.deepEqual(await provider.search(context), []);
  });
});

test("keeps only ArabicSubs movie matches with the same title and year", async () => {
  const movieContext = {
    media: { type: "movie", imdbId: "15239678" },
    extra: { filename: "Dune.Part.Two.2024.1080p.WEB-DL.mkv" }
  };
  await withMockFetch(async () => new Response(JSON.stringify({ matches: [
    { id: 92, originalFilename: "Dune.Part.Two.2024.1080p.WEB-DL.ar.srt" },
    { id: 93, originalFilename: "House.Of.The.Dragon.2026.1080p.WEB-DL.ar.srt" }
  ] }), { status: 200 }), async () => {
    const provider = new ArabicSubsProvider({ apiKey: "test", baseUrl: "https://arabicsubs.com/api/v1" });
    const results = await provider.search(movieContext);
    assert.deepEqual(results.map((item) => item.fileId), [92]);
  });
});
