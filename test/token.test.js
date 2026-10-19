import test from "node:test";
import assert from "node:assert/strict";
import { signSubtitleToken, verifySubtitleToken } from "../src/token.js";

test("verifies seven-day signed tokens and rejects expiry", () => {
  const token = signSubtitleToken({ fileIds: [7], extension: "srt" }, "secret", 1000);
  assert.deepEqual(verifySubtitleToken(token, "secret", 2000).fileIds, [7]);
  assert.deepEqual(verifySubtitleToken(token, "secret", 604_800_000).fileIds, [7]);
  assert.throws(() => verifySubtitleToken(token, "secret", 604_802_000), /expired/);
});
