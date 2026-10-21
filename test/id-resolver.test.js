import test from "node:test";
import assert from "node:assert/strict";
import { alignMediaToFilename, identityUnresolved, resolveVideoId } from "../src/id-resolver.js";

test("keeps normal IMDb episode ids unchanged", async () => {
  const media = await resolveVideoId("series", "tt2560140:1:1");
  assert.deepEqual(media, { type: "series", id: "tt2560140:1:1", imdbId: "2560140", season: 1, episode: 1 });
});

test("maps a Kitsu episode to its IMDb season and episode", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      meta: {
        name: "Attack on Titan",
        imdb_id: "tt2560140",
        videos: [{ id: "kitsu:7442:1", episode: 1, absoluteEpisode: 1, imdb_id: "tt2560140", imdbSeason: 1, imdbEpisode: 1 }]
      }
    })
  });
  const media = await resolveVideoId("series", "kitsu:7442:1", { fetchImpl });
  assert.equal(media.id, "tt2560140:1:1");
  assert.equal(media.imdbId, "2560140");
  assert.equal(media.season, 1);
  assert.equal(media.episode, 1);
});

test("falls back to the ARM mapping when the Kitsu add-on is unreachable", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("anime-kitsu")) throw new Error("connect timeout");
    if (String(url).includes("arm.haglund.dev")) return { ok: true, json: async () => ({ kitsu: 46299, imdb: "tt21423786", "thetvdb-season": 1 }) };
    if (String(url).includes("kitsu.app/api")) return { ok: true, json: async () => ({ data: { attributes: { canonicalTitle: "Boku no Kokoro no Yabai Yatsu", titles: { en_jp: "Boku no Kokoro no Yabai Yatsu", en: "The Dangers in My Heart" } } } }) };
    throw new Error(`unexpected ${url}`);
  };
  const media = await resolveVideoId("series", "kitsu:46299:3", { fetchImpl });
  assert.equal(media.id, "tt21423786:1:3");
  assert.equal(media.imdbId, "21423786");
  assert.equal(media.episode, 3);
  assert.equal(media.title, "Boku no Kokoro no Yabai Yatsu");
  assert.equal(media.catalogTitle, "The Dangers in My Heart");
  assert.equal(identityUnresolved(media), false);
  const unknown = await resolveVideoId("series", "kitsu:99999999:1", { fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(identityUnresolved(unknown), true);
});

test("accepts unknown catalog ids without risking an unscoped IMDb search", async () => {
  const media = await resolveVideoId("series", "custom:show:2:7");
  assert.equal(media.imdbId, "");
  assert.equal(media.season, 2);
  assert.equal(media.episode, 7);
});

test("trusts the played filename when it identifies a different work", async () => {
  const fetchImpl = async (url) => String(url).includes("/catalog/")
    ? { ok: true, json: async () => ({ metas: [{ id: "tt13443470", name: "Wednesday" }] }) }
    : { ok: true, json: async () => ({ meta: { name: "Death Note" } }) };
  const media = await alignMediaToFilename(
    { type: "series", id: "tt0877057:1:2", imdbId: "0877057", season: 1, episode: 2 },
    { filename: "Wednesday.S01E02.2160p.NF.WEB-DL.mkv" },
    { fetchImpl }
  );
  assert.equal(media.id, "tt13443470:1:2");
  assert.equal(media.imdbId, "13443470");
  assert.equal(media.identityCorrected, true);
  assert.equal(media.identityMismatch, false);
});

test("avoids a wrong IMDb search when the filename title cannot be resolved", async () => {
  const fetchImpl = async (url) => String(url).includes("/catalog/")
    ? { ok: true, json: async () => ({ metas: [] }) }
    : { ok: true, json: async () => ({ meta: { name: "Death Note" } }) };
  const media = await alignMediaToFilename(
    { type: "series", id: "tt0877057:1:2", imdbId: "0877057", season: 1, episode: 2 },
    { filename: "Unknown.Work.S01E02.1080p.WEB-DL.mkv" },
    { fetchImpl }
  );
  assert.equal(media.imdbId, "");
  assert.equal(media.identityMismatch, true);
});

test("uses the episode number in the played file when it conflicts with the catalog", async () => {
  const media = await alignMediaToFilename(
    { type: "series", id: "tt39123061:2:1", imdbId: "39123061", season: 2, episode: 1 },
    { filename: "[NanakoRaws] Koori no Jouheki - 04 (AT-X 1080p HEVC AAC).mkv" },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ meta: { name: "Koori no Jyouheki" } }) }) }
  );
  assert.equal(media.id, "tt39123061:2:4");
  assert.equal(media.episode, 4);
  assert.equal(media.imdbId, "39123061");
});
