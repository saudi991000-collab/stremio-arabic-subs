import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signSubtitleToken, verifySubtitleToken } from "../src/token.js";

test("verifies seven-day signed tokens and rejects expiry", () => {
  const token = signSubtitleToken({ fileIds: [7], extension: "srt" }, "secret", 1000);
  assert.deepEqual(verifySubtitleToken(token, "secret", 2000).fileIds, [7]);
  assert.deepEqual(verifySubtitleToken(token, "secret", 604_800_000).fileIds, [7]);
  assert.throws(() => verifySubtitleToken(token, "secret", 604_802_000), /expired/);
});

test("compresses realistic multi-provider subtitle payloads for Stremio", () => {
  const item = {
    provider: "opensubtitles",
    ref: 1234567,
    fileId: 1234567,
    season: 1,
    episode: 2,
    fileName: "A.Very.Long.Anime.Release.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GROUP.Arabic.ass",
    extension: "ass",
    confidence: 91,
    reasons: ["catalog-match", "single-episode", "release-source", "release-group"],
    syncScore: 8,
    qualityScore: 7
  };
  const token = signSubtitleToken({
    items: Array.from({ length: 6 }, (_, index) => ({ ...item, ref: item.ref + index, fileId: item.fileId + index })),
    extension: "ass",
    context: { media: { id: "tt1234567:1:2", type: "series", season: 1, episode: 2 }, extra: { filename: item.fileName } }
  }, "secret", 1000);
  assert.ok(token.length < 1800, `compressed token is unexpectedly long: ${token.length}`);
  assert.equal(verifySubtitleToken(token, "secret", 2000).items.length, 6);
});

test("keeps accepting legacy uncompressed tokens", () => {
  const legacyPayload = { fileIds: [9], extension: "srt", exp: 999999 };
  const body = Buffer.from(JSON.stringify(legacyPayload)).toString("base64url");
  const signature = createHmac("sha256", "secret").update(body).digest("base64url");
  assert.deepEqual(verifySubtitleToken(`${body}.${signature}`, "secret", 2000).fileIds, [9]);
});
