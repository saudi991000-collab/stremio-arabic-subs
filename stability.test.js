import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAddonServer, dropDuplicatesAndOutliers } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { MultiProvider } from "../src/providers/multi.js";
import { JsonStore, mergeSearchEntries } from "../src/store.js";
import { safeFetch, RateLimiter } from "../src/http.js";
import { arabicAss, arabicSrt } from "./fixtures.js";

const LINES = (id) => [`هذه الترجمة رقم ${id} وهي ترجمة بشرية حقيقية.`, `سطر آخر مختلف في الترجمة رقم ${id}، أليس كذلك؟`, `نهاية المشهد في الترجمة ${id}.`];

function fakeProvider(id, count, { delayMs = 0, fail, names } = {}) {
  return {
    id,
    calls: 0,
    async search(_context, _pages, { signal } = {}) {
      this.calls += 1;
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      }
      if (fail) throw fail;
      return Array.from({ length: count }, (_, index) => ({
        provider: id,
        fileId: `${id}-${index}`,
        downloadRef: `${id}-${index}`,
        fileName: names ? names(index) : `Show.S01E07.1080p.WEB-DL.${id}${index}.srt`,
        language: "ar",
        featureDetails: { seasonNumber: 1, episodeNumber: 7 }
      }));
    },
    async download(ref) {
      if (String(ref).includes("styled")) return { buffer: Buffer.from(arabicAss(40)), fileName: `${ref}.ass` };
      return { buffer: Buffer.from(arabicSrt(40, { lines: LINES(ref) })), fileName: `${ref}.srt` };
    }
  };
}

async function withServer(provider, overrides, callback) {
  const cacheDirectory = overrides.CACHE_DIRECTORY || await mkdtemp(path.join(tmpdir(), "aes-stability-"));
  const config = readConfig({ CACHE_DIRECTORY: cacheDirectory, URL_TOKEN_SECRET: "stable-secret", LISTING_DEADLINE_MS: "6000", PROVIDER_SEARCH_TIMEOUT_MS: "1000", PROVIDER_HARD_TIMEOUT_MS: "4000", BACKGROUND_VALIDATION: "false", ...overrides });
  const server = await createAddonServer({ config, provider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`, server, cacheDirectory);
  } finally {
    await server.flushBackground();
    await new Promise((resolve) => server.close(resolve));
  }
}

const listing = async (base) => (await fetch(`${base}/subtitles/series/tt1234567:1:7/filename=Show.S01E07.1080p.WEB-DL.mkv.json`)).json();

test("a partial search never overwrites a more complete cached result", () => {
  const previous = mergeSearchEntries(undefined, {
    candidates: [{ provider: "a", fileId: 1 }, { provider: "a", fileId: 2 }, { provider: "b", fileId: 3 }],
    providers: { a: { status: "ok", count: 2 }, b: { status: "ok", count: 1 } }
  }, ["a", "b"]);
  assert.equal(previous.complete, true);
  const merged = mergeSearchEntries(previous, {
    candidates: [{ provider: "b", fileId: 4 }],
    providers: { a: { status: "timeout", count: 0 }, b: { status: "ok", count: 1 } }
  }, ["a", "b"]);
  assert.deepEqual(merged.candidates.map((item) => item.fileId).sort(), [1, 2, 4]);
  assert.equal(merged.complete, false, "a failed refresh marks the entry for another refresh");
  assert.ok(Object.isFrozen(merged.candidates));
});

test("returns an immutable snapshot and delivers late providers separately", async () => {
  const late = [];
  const multi = new MultiProvider([fakeProvider("fast", 2), fakeProvider("slow", 3, { delayMs: 250 })], { providerTimeoutMs: 2000 });
  const snapshot = await multi.searchSnapshot({ media: {}, extra: {} }, 1, 50, { onLate: (value) => late.push(value) });
  assert.equal(snapshot.candidates.length, 2);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.providers.slow.status, "partial");
  assert.throws(() => snapshot.candidates.push({}), TypeError);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(snapshot.candidates.length, 2, "background work must not mutate the returned snapshot");
  assert.equal(late.length, 1);
  assert.equal(late[0].providers.slow.status, "ok");
  assert.equal(late[0].candidates.length, 3);
});

test("aborts a provider at its own hard timeout and isolates its failure", async () => {
  const late = [];
  const hanging = fakeProvider("hanging", 1, { delayMs: 10000 });
  const broken = fakeProvider("broken", 1, { fail: new Error("boom") });
  const multi = new MultiProvider([fakeProvider("ok", 2), hanging, broken], { providerTimeoutMs: 200 });
  const snapshot = await multi.searchSnapshot({ media: {}, extra: {} }, 1, 50, { onLate: (value) => late.push(value) });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(snapshot.candidates.length, 2);
  assert.equal(snapshot.providers.broken.status, "error");
  assert.equal(late[0].providers.hanging.status, "timeout");
});

test("slow providers are merged into the cache so the next open is complete and stable", async () => {
  const provider = new MultiProvider([fakeProvider("fast", 3), fakeProvider("slow", 4, { delayMs: 1500 })], { providerTimeoutMs: 4000 });
  await withServer(provider, {}, async (base, server) => {
    const first = await listing(base);
    assert.equal(first.subtitles.length, 3);
    assert.equal(first.cacheMaxAge, 0, "partial lists are not client-cached");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await server.flushBackground();
    const second = await listing(base);
    assert.equal(second.subtitles.length, 7);
    const third = await listing(base);
    assert.deepEqual(third.subtitles.map((item) => [item.id, item.label]), second.subtitles.map((item) => [item.id, item.label]));
  });
});

test("results survive a restart (persistent cache) even when providers then fail", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aes-restart-"));
  const before = await withServer(new MultiProvider([fakeProvider("a", 5), fakeProvider("b", 4)]), { CACHE_DIRECTORY: directory }, async (base) => listing(base));
  assert.equal(before.subtitles.length, 9);
  const failing = new MultiProvider([fakeProvider("a", 0, { fail: new Error("cold start timeout") }), fakeProvider("b", 0, { fail: new Error("down") })]);
  const after = await withServer(failing, { CACHE_DIRECTORY: directory }, async (base) => listing(base));
  assert.deepEqual(after.subtitles.map((item) => item.label), before.subtitles.map((item) => item.label));
});

test("returns up to 25 valid results and never pads the list", async () => {
  const many = new MultiProvider(["a", "b", "c", "d", "e"].map((id) => fakeProvider(id, 8)));
  const full = await withServer(many, {}, async (base) => listing(base));
  assert.equal(full.subtitles.length, 25);
  assert.deepEqual(full.subtitles.map((item) => Number(item.label.split(" ")[0])), Array.from({ length: 25 }, (_, index) => index + 1));
  const few = await withServer(new MultiProvider([fakeProvider("a", 3)]), {}, async (base) => listing(base));
  assert.equal(few.subtitles.length, 3);
});

test("orders emoji badges 💪👍 → 🇸🇦 → 🎨 and sorts by badge count", async () => {
  const names = ["Other.Show.Pack.S01.srt", "Show.S01E07.1080p.WEB-DL.srt", "[3ASQ] Show.S01E07.1080p.WEB-DL.srt", "[3ASQ] Show.S01E07.1080p.WEB-DL.styled.ass"];
  const provider = new MultiProvider([{
    ...fakeProvider("mix", 4, { names: (index) => names[index] }),
    async search() {
      return names.map((fileName, index) => ({ provider: "mix", fileId: index, downloadRef: fileName.includes("styled") ? "styled" : `plain-${index}`, fileName, language: "ar", featureDetails: { seasonNumber: 1, episodeNumber: 7 } }));
    }
  }]);
  const result = await withServer(provider, {}, async (base) => listing(base));
  const labels = result.subtitles.map((item) => item.label);
  assert.equal(labels.length, 3, "the season pack is not listed");
  assert.match(labels[0], /^1 💪👍 🇸🇦 🎨 \| 3ASQ • mix • ASS • \[3ASQ\] Show\.S01E07/);
  assert.match(labels[1], /^2 💪👍 🇸🇦 \| 3ASQ • mix • SRT/);
  assert.match(labels[2], /^3 💪👍 \| mix • SRT/);
  for (const label of labels) assert.doesNotMatch(label, /🇸🇦 💪👍|🎨 🇸🇦|%/);
});

test("collapses mirrored files across providers and drops length outliers", () => {
  const base = { deepAnalyzed: true, reasons: [] };
  const kept = dropDuplicatesAndOutliers([
    { ...base, provider: "a", fileId: 1, fileName: "Movie.2021.1080p.BluRay-EVO.srt", cueCount: 1950, subtitleDurationSeconds: 8900 },
    { ...base, provider: "b", fileId: 2, fileName: "Movie.2021.1080p.BluRay-EVO.srt", cueCount: 1952, subtitleDurationSeconds: 8901 },
    { ...base, provider: "c", fileId: 3, fileName: "Movie.2021.720p.WEBRip.srt", cueCount: 1900, subtitleDurationSeconds: 8850 },
    { ...base, provider: "d", fileId: 4, fileName: "Movie.2021.Featurette.srt", cueCount: 90, subtitleDurationSeconds: 400 },
    { ...base, provider: "e", fileId: 5, fileName: "Movie.2021.WEB.srt", cueCount: 1990, subtitleDurationSeconds: 8950 }
  ]);
  assert.deepEqual(kept.map((item) => item.fileId), [1, 3, 5]);
});

test("retries rate-limited requests with backoff and pauses the limiter", async () => {
  let calls = 0;
  const limiter = new RateLimiter({ minIntervalMs: 0, concurrency: 1 });
  const response = await safeFetch("https://api.example.com/x", {
    allowedHosts: ["example.com"],
    limiter,
    retries: 2,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : new Response("ok", { status: 200 });
    }
  });
  assert.equal(response.text(), "ok");
  assert.equal(calls, 2);
  await assert.rejects(() => safeFetch("https://api.example.com/x", {
    allowedHosts: ["example.com"], retries: 0, fetchImpl: async () => new Response("", { status: 429 })
  }), (error) => error.rateLimited === true);
});

test("disk store returns immutable values and expires them", async () => {
  const store = new JsonStore({ directory: await mkdtemp(path.join(tmpdir(), "aes-store-")), namespace: "t", ttlSeconds: 60 });
  await store.set("k", { list: [1, 2] });
  const value = await store.get("k");
  assert.ok(Object.isFrozen(value.list));
  await store.set("short", { a: 1 }, -1);
  assert.equal(await store.get("short"), undefined);
  await store.flush();
});
