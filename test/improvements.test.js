import test from "node:test";
import assert from "node:assert/strict";
import { MultiProvider } from "../src/providers/multi.js";
import { JsonStore, UpstashKv, mergeSearchEntries } from "../src/store.js";
import { deepAnalyzeCandidates } from "../src/deep-analyzer.js";
import { sortForDisplay } from "../src/server.js";
import { polishSubtitle, wrapLongLines } from "../src/polish.js";
import { SubDLProvider } from "../src/providers/subdl.js";

test("circuit breaker skips repeatedly failing 403/500 providers and keeps cache complete", async () => {
  let calls = 0;
  const provider = new MultiProvider([
    { id: "ok", async search() { return [{ fileId: 1, fileName: "Movie.2024.srt" }]; } },
    {
      id: "blocked",
      async search() {
        calls += 1;
        throw Object.assign(new Error("HTTP 403"), { status: 403 });
      }
    }
  ], { circuitThreshold: 2, circuitCooldownMs: 60000 });

  const first = await provider.searchSnapshot({}, 1);
  assert.equal(first.complete, false);
  const second = await provider.searchSnapshot({}, 1);
  assert.equal(second.complete, false);
  assert.equal(calls, 2);

  // Third call should skip "blocked" immediately and mark the snapshot complete.
  const third = await provider.searchSnapshot({}, 1);
  assert.equal(calls, 2);
  assert.equal(third.providers.blocked.status, "skipped");
  assert.equal(third.complete, true);

  const merged = mergeSearchEntries(undefined, third, ["ok", "blocked"]);
  assert.equal(merged.complete, true);
});

test("UpstashKv.getMany and JsonStore.getMany batch-read keys in one MGET call", async () => {
  const commands = [];
  const kv = new UpstashKv({
    url: "https://example.upstash.io",
    token: "tok",
    fetchImpl: async (_url, init) => {
      const args = JSON.parse(init.body);
      commands.push(args);
      const now = Date.now();
      return new Response(JSON.stringify({
        result: [
          JSON.stringify({ key: "k1", value: { ok: true, cueCount: 10 }, expiresAt: now + 60000 }),
          null
        ]
      }), { status: 200 });
    }
  });
  const store = new JsonStore({ namespace: "verdicts", ttlSeconds: 3600, remote: kv });
  const map = await store.getMany(["k1", "k2"]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "MGET");
  assert.deepEqual(map.get("k1"), { ok: true, cueCount: 10 });
  assert.equal(map.has("k2"), false);
});

test("deepAnalyzeCandidates uses batch verdict getMany when available", async () => {
  let getManyCalls = 0;
  let getCalls = 0;
  const verdicts = {
    async getMany(keys) {
      getManyCalls += 1;
      return new Map(keys.map((k) => [k, { ok: true, actualFormat: "srt", styled: false, cueCount: 50, durationSeconds: 1200, quality: { humanScore: 0.9, reasons: [] } }]));
    },
    async get() {
      getCalls += 1;
      return undefined;
    }
  };
  const candidates = [
    { provider: "subdl", fileId: "1", downloadRef: "1", fileName: "Show.S01E01.srt", confidence: 80, reasons: ["series"] },
    { provider: "wyzie", fileId: "2", downloadRef: "2", fileName: "Show.S01E01.srt", confidence: 78, reasons: ["series"] }
  ];
  const out = await deepAnalyzeCandidates(candidates, { media: { type: "series", season: 1, episode: 1 }, extra: {} }, { async download() { throw new Error("should not download"); } }, {}, {
    limit: 2,
    maxDownloads: 0,
    verdicts
  });
  assert.equal(getManyCalls, 1);
  assert.equal(getCalls, 0);
  assert.equal(out.every((c) => c.deepAnalyzed), true);
});

test("sortForDisplay prioritizes series-chosen team over general source match, below exact release", () => {
  const sorted = sortForDisplay([
    { provider: "subdl", fileId: 1, reasons: ["same-source", "same-platform"], chosen: 0, deepAnalyzed: true },
    { provider: "wyzie", fileId: 2, reasons: [], chosen: 1, deepAnalyzed: true },
    { provider: "subsource", fileId: 3, reasons: ["exact-release"], chosen: 0, deepAnalyzed: true }
  ]);
  assert.deepEqual(sorted.map((item) => item.fileId), [3, 2, 1]);
});

test("wrapLongLines splits overly long single-line Arabic cues cleanly for TV screens", () => {
  const longLine = "هذه جملة ترجمة عربية طويلة جدا وقد تغطي عرض شاشة التلفاز بالكامل";
  const wrapped = wrapLongLines([longLine], 40);
  assert.equal(wrapped.length, 2);
  assert.ok(wrapped[0].length < longLine.length && wrapped[1].length < longLine.length);
  const srt = `1\n00:00:01,000 --> 00:00:05,000\n${longLine}\n`;
  const polished = polishSubtitle(srt, "srt");
  const lines = polished.trim().split("\n").slice(2);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith("\u200F")));
});

test("SubDL sends cleaned filename for bracketed anime and absolute episode query", async () => {
  const queries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    queries.push(new URL(String(url)).searchParams);
    return new Response(JSON.stringify({ status: true, subtitles: [] }), { status: 200 });
  };
  try {
    const provider = new SubDLProvider({ apiKey: "test", baseUrl: "https://api.subdl.com/api/v1" });
    await provider.search({
      media: { type: "series", imdbId: "0994314", season: 2, episode: 1, absoluteEpisode: 26 },
      extra: { filename: "[DeadFish] Code Geass - 26 [BD][720p][AAC].mkv" }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const fileNames = queries.map((q) => q.get("file_name")).filter(Boolean);
  assert.ok(fileNames.includes("[DeadFish] Code Geass - 26 [BD][720p][AAC].mkv"));
  assert.ok(fileNames.includes("Code Geass - 26"));
  assert.ok(queries.some((q) => q.get("season_number") === "1" && q.get("episode_number") === "26"));
});
