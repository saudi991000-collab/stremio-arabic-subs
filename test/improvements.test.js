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

import { TimingMemory } from "../src/timing-memory.js";
import { detailedResultLabel } from "../src/server.js";

test("verified/corrected synced subtitles rank before unverified release matches and show [SYNC]", () => {
  const sorted = sortForDisplay([
    { provider: "subdl", fileId: 1, reasons: ["same-platform", "same-source"], deepAnalyzed: true },
    { provider: "wyzie", fileId: 2, reasons: ["timing-consensus"], timingScore: 0.85, timingReferenceKind: "consensus", deepAnalyzed: true }
  ]);
  assert.deepEqual(sorted.map((item) => item.fileId), [2, 1]);
  assert.match(detailedResultLabel(sorted[0], 0), /\[SYNC\]/);
});

test("TimingMemory shares saved timings between videoHash (PC) and filename (Mi Box/iPad)", async () => {
  const mem = new Map();
  const store = {
    async get(k) { return mem.get(k); },
    async set(k, v) { mem.set(k, v); return v; }
  };
  const memory = new TimingMemory(store);
  const item = { provider: "subdl", ref: "abc123" };
  await memory.rememberAuto(
    { media: { type: "series", imdbId: "0994314", season: 1, episode: 10 }, extra: { videoHash: "deadbeef12345678", videoSize: 500000, filename: "Code.Geass.10.mkv" } },
    item,
    { scale: 1, offset: -1.5, score: 0.9, reference: "audio-whisper" }
  );
  const foundOnTv = await memory.lookup(
    { media: { type: "series", imdbId: "0994314", season: 1, episode: 10 }, extra: { filename: "Code.Geass.10.mkv" } },
    item
  );
  assert.equal(foundOnTv.auto?.offset, -1.5);
});

import { parseTimeline } from "../src/timing.js";

test("parseTimeline dialogueOnly skips ASS signs, karaoke, and ads while keeping dialogue", () => {
  const lines = [
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(100,50)}لافتة جانبية",
    "Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,{\\k50}كاريوكي",
    "Dialogue: 0,0:00:09.00,0:00:12.00,Default,,0,0,0,,تابعونا على t.me/test",
    ...Array.from({ length: 16 }, (_, i) => {
      const s = 20 + i * 5;
      const e = s + 3;
      const fmt = (sec) => `0:${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}.00`;
      return `Dialogue: 0,${fmt(s)},${fmt(e)},Default,,0,0,0,,جملة حوار رقم ${i}`;
    })
  ].join("\n");
  const all = parseTimeline(lines);
  const dialogue = parseTimeline(lines, { dialogueOnly: true });
  assert.equal(all.length, 19);
  assert.equal(dialogue.length, 16);
});

test("deepAnalyzeCandidates respects skipProviders to protect OpenSubtitles daily quota", async () => {
  let downloaded = 0;
  const provider = {
    async download() {
      downloaded += 1;
      throw new Error("should not download skipped provider");
    }
  };
  const out = await deepAnalyzeCandidates(
    [{ provider: "opensubtitles", fileId: "99", downloadRef: "99", fileName: "Show.S01E01.srt", confidence: 85, reasons: ["series"] }],
    { media: { type: "series", season: 1, episode: 1 }, extra: {} },
    provider,
    {},
    { limit: 1, skipProviders: new Set(["opensubtitles"]) }
  );
  assert.equal(downloaded, 0);
  assert.equal(out[0].validationPending, true);
});

import { dropDuplicatesAndOutliers } from "../src/server.js";

test("MultiProvider early exit returns fast once enough candidates arrive", async () => {
  const fast = { id: "fast", async search() { return Array.from({ length: 10 }, (_, i) => ({ fileId: i + 1, fileName: `Show.S01E01.${i}.srt` })); } };
  const slow = { id: "slow", async search() { await new Promise((r) => setTimeout(r, 800)); return [{ fileId: 99, fileName: "Show.S01E01.slow.srt" }]; } };
  const provider = new MultiProvider([fast, slow]);
  const started = Date.now();
  const snap = await provider.searchSnapshot({}, 1, 2000, { earlyMinCandidates: 10, earlyAfterMs: 100 });
  const elapsed = Date.now() - started;
  assert.equal(snap.candidates.length, 10);
  assert.ok(elapsed < 500, `expected early exit < 500ms, got ${elapsed}ms`);
});

test("dropDuplicatesAndOutliers drops severely truncated cue-count outliers", () => {
  const candidates = [
    { provider: "a", fileId: "1", fileName: "ep1.a.srt", deepAnalyzed: true, cueCount: 300, subtitleDurationSeconds: 1400 },
    { provider: "b", fileId: "2", fileName: "ep1.b.srt", deepAnalyzed: true, cueCount: 310, subtitleDurationSeconds: 1410 },
    { provider: "c", fileId: "3", fileName: "ep1.c.srt", deepAnalyzed: true, cueCount: 295, subtitleDurationSeconds: 1390 },
    { provider: "d", fileId: "4", fileName: "ep1.d.srt", deepAnalyzed: true, cueCount: 305, subtitleDurationSeconds: 1405 },
    { provider: "e", fileId: "5", fileName: "ep1.short.srt", deepAnalyzed: true, cueCount: 90, subtitleDurationSeconds: 1350 }
  ];
  const kept = dropDuplicatesAndOutliers(candidates);
  assert.deepEqual(kept.map((c) => c.fileId), ["1", "2", "3", "4"]);
});

import { markLine } from "../src/polish.js";

test("markLine anchors trailing weak punctuation (., !, ...) with RLM so it stays on the left", () => {
  assert.equal(markLine("إن هذا أفضل بكثير."), "\u200Fإن هذا أفضل بكثير.\u200F");
  assert.equal(markLine("لبقية السناجب!"), "\u200Fلبقية السناجب!\u200F");
  assert.equal(markLine("<i>انتظر...</i>"), "<i>\u200Fانتظر...\u200F</i>");
});
