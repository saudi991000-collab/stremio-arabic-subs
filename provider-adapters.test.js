import test from "node:test";
import assert from "node:assert/strict";
import { SubDLProvider } from "../src/providers/subdl.js";
import { SubSourceProvider } from "../src/providers/subsource.js";
import { ArabicSubsProvider } from "../src/providers/arabicsubs.js";
import { OpenSubtitlesProvider } from "../src/providers/opensubtitles.js";
import { StremioV3Provider } from "../src/providers/stremio-v3.js";
import { WyzieProvider } from "../src/providers/wyzie.js";
import { SubKongProvider } from "../src/providers/subkong.js";
import { MiraiAnimeProvider } from "../src/providers/miraianime.js";
import { AniKotoProvider } from "../src/providers/anikoto.js";
import { TheSubtitleDbProvider } from "../src/providers/thesubtitledb.js";
import { MoraProvider } from "../src/providers/mora.js";
import { Subf2mProvider } from "../src/providers/subf2m.js";
import { OpenSubtitlesOrgProvider } from "../src/providers/opensubtitles-org.js";
import { YifySubtitlesProvider } from "../src/providers/yifysubtitles.js";
import { isTransientError } from "../src/deep-analyzer.js";

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

test("maps episode-scoped human Arabic TheSubtitleDB results", async () => {
  let requested = "";
  await withMockFetch(async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ title: { year: 2006 }, subtitles: { items: [
      { id: 77, language: "ar", release_name: "[3ASQ] Code Geass S01E07", format: "ass", bytes: 4567 },
      { id: 78, language: "en", release_name: "English", format: "srt" }
    ] } }), { status: 200 });
  }, async () => {
    const results = await new TheSubtitleDbProvider().search(context);
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "thesubtitledb");
    assert.equal(results[0].episodeScoped, true);
    assert.equal(results[0].machineTranslated, false);
    assert.match(results[0].fileName, /\.ass$/);
  });
  assert.match(requested, /by-imdb\/tt994314\/season\/1\/episode\/7/);
  assert.match(requested, /lang=ar/);
});

test("finds matching Arabic subtitles in the Mora archive without unrelated titles", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ files: [
    { name: "Code.Geass.S01E07.3ASQ.srt", size: "1200" },
    { name: "Unrelated.Show.S01E07.srt", size: "1200" },
    { name: "cover.jpg", size: "100" }
  ] }), { status: 200 }), async () => {
    const results = await new MoraProvider().search(context);
    assert.deepEqual(results.map((item) => item.fileName), ["Code.Geass.S01E07.3ASQ.srt"]);
  });
});

test("does not confuse a short partial Mora title with a longer movie title", async () => {
  const movie = { media: { type: "movie", releaseTitle: "Spider Man No Way Home" }, extra: { filename: "Spider.Man.No.Way.Home.2021.mkv" } };
  await withMockFetch(async () => new Response(JSON.stringify({ files: [
    { name: "No.Man.of.God.2021.1080p.bluray.mora.25r.srt", size: "1200" },
    { name: "Home.Team.2022.1080p.WEBRip.mora.25r.srt", size: "1200" },
    { name: "Spider.Man.No.Way.Home.2021.1080p.BluRay.srt", size: "1200" }
  ] }), { status: 200 }), async () => {
    const results = await new MoraProvider().search(movie);
    assert.deepEqual(results.map((item) => item.fileName), ["Spider.Man.No.Way.Home.2021.1080p.BluRay.srt"]);
  });
});

test("parses exact Arabic episode releases from a Subf2m season page", async () => {
  await withMockFetch(async () => new Response(`<ul><li class="item"><a class="download" href="/subtitles/code-geass-first-season/arabic/777"></a><ul class="scrolllist"><li>Code.Geass.S01E07.ESPADAS.WEB-DL</li><li>Code.Geass.S01E08.ESPADAS.WEB-DL</li></ul><span class="rate good"></span></li></ul>`, { status: 200 }), async () => {
    const results = await new Subf2mProvider().search(context);
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "subf2m");
    assert.match(results[0].fileName, /S01E07/);
    assert.equal(results[0].fromTrusted, true);
  });
});

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
  assert.equal(requested.searchParams.has("hi"), false, "hi=1 filters SubDL down to hearing-impaired files only");
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

test("maps human Arabic Wyzie results and ignores AI translations", async () => {
  let requestedUrl = "";
  await withMockFetch(async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify([
      {
        id: "w1",
        url: "https://sub.wyzie.io/c/abc/id/w1?format=ass&tok=secret",
        format: "ass",
        language: "ar",
        source: "foxtrot",
        release: "Code.Geass.S01E07.BluRay",
        fileName: "Code.Geass.S01E07.ass",
        ai: false
      },
      {
        id: "w2",
        url: "https://sub.wyzie.io/c/abc/id/w2?format=srt&tok=secret",
        format: "srt",
        language: "ar",
        source: "ai",
        fileName: "generated.srt",
        ai: true
      }
    ]), { status: 200 });
  }, async () => {
    const provider = new WyzieProvider({ apiKey: "test-key", baseUrl: "https://sub.wyzie.io" });
    const results = await provider.search(context);
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "wyzie");
    assert.equal(results[0].episodeScoped, true);
    assert.match(results[0].fileName, /\.ass$/);
    assert.match(requestedUrl, /language=ar/);
    assert.match(requestedUrl, /source=all/);
    assert.match(requestedUrl, /season=1/);
    assert.match(requestedUrl, /episode=7/);
  });
});

test("maps episode-scoped Arabic SubKong results", async () => {
  let requestedUrl = "";
  await withMockFetch(async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ subtitles: [
      { source: "user", name: "Code.Geass.S01E07.Styled", season: 1, episode: 7, format: "ass", download: "/api/v1/download/user/77" }
    ] }), { status: 200 });
  }, async () => {
    const provider = new SubKongProvider();
    const results = await provider.search(context);
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "subkong");
    assert.equal(results[0].episodeScoped, true);
    assert.match(results[0].fileName, /\.ass$/);
  });
  assert.match(requestedUrl, /language=Arabic/);
  assert.match(requestedUrl, /season=1/);
  assert.match(requestedUrl, /episode=7/);
});

test("discovers MiraiAnime ZIP packs for the requested anime episode", async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify([{ title: "Code Geass", url: "https://miraianime.net/anime/code-geass/" }]), { status: 200 });
    return new Response('<a class="download-file" href="https://miraianime.net/wp-content/uploads/code-geass.zip">Download</a>', { status: 200 });
  }, async () => {
    const provider = new MiraiAnimeProvider();
    const results = await provider.search(context);
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "miraianime");
    assert.equal(results[0].featureDetails.episodeNumber, 7);
    assert.match(results[0].fileName, /S01E07/);
  });
});

test("resolves AniKoto through the ARM id mapping and keeps only its Arabic subtitle track with playback headers", async () => {
  let calls = 0;
  await withMockFetch(async (url) => {
    calls += 1;
    if (String(url).startsWith("https://arm.haglund.dev/api/v2/imdb?id=tt0994314")) {
      return new Response(JSON.stringify([
        { anilist: 1575, media: "TV", "thetvdb-season": 1 },
        { anilist: 2904, media: "TV", "thetvdb-season": 2 }
      ]), { status: 200 });
    }
    if (String(url).includes("/episodes/anikoto/1575")) {
      return new Response(JSON.stringify({ episodes: { sub: [{ id: "watch/anikoto/1575/sub/anikoto-7", number: 7 }] } }), { status: 200 });
    }
    if (String(url).includes("/watch/anikoto/1575/sub/anikoto-7")) {
      return new Response(JSON.stringify({ subtitles: [
        { url: "https://cdn.example.com/anime/title/subtitles/ara-1.vtt", label: "Arabic", srclang: "en", headers: { Referer: "https://megaplay.buzz/", Origin: "https://megaplay.buzz" } },
        { url: "https://cdn.example.com/anime/title/subtitles/eng-1.vtt", label: "English", srclang: "en" }
      ] }), { status: 200 });
    }
    throw new Error(`Unexpected AniKoto test URL ${url}`);
  }, async () => {
    const provider = new AniKotoProvider();
    const results = await provider.search(context);
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "anikoto");
    assert.match(results[0].fileName, /\.vtt$/);
    const ref = JSON.parse(results[0].downloadRef);
    assert.equal(ref.headers.Referer, "https://megaplay.buzz/");
  });
  assert.equal(calls, 3);
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

test("treats the OpenSubtitles 406 daily download limit as a temporary quota, not a bad file", async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ message: "You have downloaded your allowed 5 subtitles for 24h." }), { status: 406 }), async () => {
    const provider = new OpenSubtitlesProvider({ apiKey: "test", baseUrl: "https://api.opensubtitles.com/api/v1", userAgent: "test" });
    await assert.rejects(() => provider.download(123), (error) => error.rateLimited === true && isTransientError(error));
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

test("maps OpenSubtitles.org Arabic rows, drops machine, forced and bad files", async () => {
  const urls = [];
  await withMockFetch(async (url, options = {}) => {
    urls.push({ url: String(url), ua: options.headers?.["X-User-Agent"] });
    return new Response(JSON.stringify([
      { IDSubtitleFile: "11", SubFileName: "Code.Geass.S01E07.WEB-DL.srt", SubLanguageID: "ara", SubFormat: "srt", MatchedBy: "imdbid", SeriesSeason: "1", SeriesEpisode: "7", SubDownloadsCnt: "900", SubFromTrusted: "1", SubTranslator: "3ASQ", SubDownloadLink: "https://dl.opensubtitles.org/en/download/src-api/vrf-1/filead/11.gz" },
      { IDSubtitleFile: "12", SubFileName: "Code.Geass.S01E07.auto.srt", SubLanguageID: "ara", SubAutoTranslation: "1", SeriesEpisode: "7", SubDownloadLink: "https://dl.opensubtitles.org/x/12.gz" },
      { IDSubtitleFile: "13", SubFileName: "forced.srt", SubLanguageID: "ara", SubForeignPartsOnly: "1", SeriesEpisode: "7", SubDownloadLink: "https://dl.opensubtitles.org/x/13.gz" },
      { IDSubtitleFile: "14", SubFileName: "english.srt", SubLanguageID: "eng", SeriesEpisode: "7", SubDownloadLink: "https://dl.opensubtitles.org/x/14.gz" },
      { IDSubtitleFile: "15", SubFileName: "Code.Geass.S01E08.srt", SubLanguageID: "ara", SeriesEpisode: "8", SubDownloadLink: "https://dl.opensubtitles.org/x/15.gz" }
    ]), { status: 200 });
  }, async () => {
    const provider = new OpenSubtitlesOrgProvider({ userAgent: "ArabicEliteSubs v3.6.0" });
    const results = await provider.search(context);
    // The machine-translated row is mapped but flagged; the ranker drops it.
    assert.deepEqual(results.map((item) => item.fileId).sort(), ["11", "12"]);
    assert.equal(results.find((item) => item.fileId === "12").machineTranslated, true);
    assert.equal(results.find((item) => item.fileId === "11").translator, "3ASQ");
  });
  assert.match(urls[0].url, /\/search\/episode-7\/imdbid-0994314\/season-1\/sublanguageid-ara$/);
  assert.equal(urls[0].ua, "ArabicEliteSubs v3.6.0");
});

test("parses Arabic rows from a YIFY movie page and picks the closest release", async () => {
  const page = `<table><tr data-id="1"><td class="rating-cell"><span class="label">7</span></td><td class="flag-cell"><span class="sub-lang">Arabic</span></td><td><a href="/subtitles/dune-2024-arabic-yify-1"><span class="text-muted">subtitle</span> Dune.Part.Two.2024.720p.WEBRip<br /> Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1</a></td><td class="uploader-cell"><a href="/user/x">Translator</a></td></tr>
  <tr data-id="2"><td class="rating-cell"><span class="label">3</span></td><td class="flag-cell"><span class="sub-lang">English</span></td><td><a href="/subtitles/dune-2024-english-yify-2">Dune.Part.Two.2024</a></td></tr></table>`;
  await withMockFetch(async () => new Response(page, { status: 200 }), async () => {
    const provider = new YifySubtitlesProvider();
    const results = await provider.search({ media: { type: "movie", imdbId: "15239678" }, extra: { filename: "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.mkv" } });
    assert.equal(results.length, 1);
    assert.equal(results[0].release, "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1");
    assert.equal(results[0].downloadRef, "dune-2024-arabic-yify-1");
    assert.equal(results[0].uploader, "Translator");
    assert.deepEqual(await provider.search({ media: { type: "series", imdbId: "1", season: 1, episode: 1 }, extra: {} }), []);
  });
  await assert.rejects(() => new YifySubtitlesProvider().download("../../etc/passwd"), /Invalid YIFY/);
});

test("finds the Arabic TVsubtitles track for the exact episode", async () => {
  const { TvSubtitlesProvider, parseEpisodeRow } = await import("../src/providers/tvsubtitles.js");
  const season = `<tr><td>1x06</td><td><a href="episode-1-ar.html"><img src="images/flags/ar.gif"></a></td></tr><tr><td>1x07</td><td><a href="episode-99-en.html"><img src="images/flags/en.gif"></a><a href="episode-99-ar.html"><img src="images/flags/ar.gif"></a></td></tr>`;
  assert.equal(parseEpisodeRow(season, 1, 7), "episode-99-ar.html");
  assert.equal(parseEpisodeRow(season, 1, 8), null);
  await withMockFetch(async (url) => {
    const value = String(url);
    if (value.endsWith("/tvshows.html")) return new Response(`<a href="/tvshow-55-1.html"><b>Code Geass</b></a><a href="/tvshow-56-1.html"><b>Code Geass R2</b></a>`, { status: 200 });
    if (value.endsWith("/tvshow-55-1.html")) return new Response(season, { status: 200 });
    if (value.endsWith("/episode-99-ar.html")) return new Response(`<a href="/subtitle-501.html">Code.Geass.S01E07.BluRay</a><a href="/subtitle-502.html">Code.Geass.S01E07.DVDRip</a>`, { status: 200 });
    throw new Error(`unexpected ${value}`);
  }, async () => {
    const results = await new TvSubtitlesProvider().search({ ...context, media: { ...context.media, catalogTitle: "Code Geass" } });
    assert.deepEqual(results.map((item) => item.downloadRef), ["501", "502"]);
    assert.match(results[0].fileName, /S01E07/);
  });
  await assert.rejects(() => new TvSubtitlesProvider().download("../x"), /Invalid TVsubtitles/);
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
