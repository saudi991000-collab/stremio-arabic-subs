import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { sameShow } from "../src/providers/miraianime.js";
import { pickArmRow } from "../src/anime-titles.js";
import { buildZip, slimRemoteZip } from "../src/remote-zip.js";
import { extractArchive } from "../src/subtitle.js";
import { timingCheck } from "../src/server.js";

test("MiraiAnime matches the same show and season only", () => {
  assert.equal(sameShow("Shingeki no Kyojin 3", "Shingeki no Kyojin Season 3"), true);
  assert.equal(sameShow("Code Geass: Hangyaku no Lelouch", "Code Geass: Hangyaku no Lelouch"), true);
  assert.equal(sameShow("ONE PIECE", "One Piece: Heroines"), false);
  assert.equal(sameShow("Boku no Hero Academia", "Boku no Hero Academia: More"), false);
  assert.equal(sameShow("Shingeki no Kyojin 3", "Shingeki no Kyojin Season 2"), false);
  assert.equal(sameShow("Code Geass", "Code Geass: Dakkan no Rozé"), false);
});

test("ARM row is picked by season", () => {
  const rows = [
    { anilist: 1, media: "TV", "thetvdb-season": 1 },
    { anilist: 9, media: "MOVIE" },
    { anilist: 2, media: "TV", "thetvdb-season": 2 }
  ];
  assert.equal(pickArmRow(rows, 2).anilist, 2);
  assert.equal(pickArmRow(rows, 1).anilist, 1);
  assert.equal(pickArmRow(rows, 3), null);
});

function entry(name, text) {
  const raw = Buffer.from(text, "utf8");
  return { nameBytes: Buffer.from(name), flags: 0x0800, method: 8, crc: 0, uncompressedSize: raw.length, data: deflateRawSync(raw) };
}

test("remote zip: only the wanted episode is fetched, fonts are skipped", async () => {
  const font = { nameBytes: Buffer.from("fonts/big.ttf"), flags: 0, method: 0, crc: 0, uncompressedSize: 300000, data: Buffer.alloc(300000, 7) };
  const cue = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  const zip = buildZip([
    font,
    entry("[Mugi] Show - 01 [CR].ass", `${cue}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,مرحبا واحد`),
    font,
    entry("[Mugi] Show - 02 [CR].ass", `${cue}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,مرحبا اثنان`)
  ]);
  let fetched = 0;
  const readRange = async (start, end) => {
    const from = start < 0 ? zip.length + start : start;
    const to = start < 0 ? zip.length - 1 : Math.min(end, zip.length - 1);
    fetched += to - from + 1;
    return { buffer: zip.subarray(Math.max(0, from), to + 1), total: zip.length };
  };
  const slim = await slimRemoteZip(readRange, { select: (entries) => entries.filter((item) => /- 02 /.test(item.fileName)) });
  assert.ok(fetched < zip.length / 2, `fetched ${fetched} of ${zip.length}`);
  const result = extractArchive(slim, { season: 1, episode: 2, requireEpisodeEntry: true });
  assert.match(result.buffer.toString("utf8"), /اثنان/);
});

test("timing check: 🎯 for video-matched or confirmed timing, ⚠️ for conflicts", () => {
  assert.equal(timingCheck({ reasons: ["exact-hash"] }), "verified");
  assert.equal(timingCheck({ reasons: ["timing-consensus"], timingScore: 0.9, timingReferenceKind: "release" }), "verified");
  assert.equal(timingCheck({ reasons: [], timingScore: 0.9, timingReferenceKind: "audio-whisper" }), "verified");
  assert.equal(timingCheck({ reasons: [], timingScore: 0.9, timingReferenceKind: "release" }), "");
  assert.equal(timingCheck({ reasons: ["timing-conflict", "exact-hash"] }), "conflict");
});
