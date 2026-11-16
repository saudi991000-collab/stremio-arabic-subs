import test from "node:test";
import assert from "node:assert/strict";
import {
  CompanionRegistry,
  isLoopbackAddress,
  parseFfmpegInputUrl,
  safeMediaAnalysisUrl,
  safeStremioStreamUrl
} from "../src/companion.js";

test("accepts only local Stremio Service stream URLs", () => {
  assert.equal(safeStremioStreamUrl("http://127.0.0.1:11470/hash/0"), "http://127.0.0.1:11470/hash/0");
  assert.equal(safeStremioStreamUrl("https://example.com/video.mkv"), null);
  assert.equal(safeStremioStreamUrl("http://127.0.0.1:7000/health"), null);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
});

test("parses a trusted Stremio ffmpeg input without widening the HTTP endpoint", () => {
  const remote = "https://media.example/video%20file.mkv?token=abc";
  assert.equal(parseFfmpegInputUrl(`ffmpeg.exe -ss 30 -i \"${remote}\" -map 0:v`), remote);
  assert.equal(safeMediaAnalysisUrl(remote), remote);
  assert.equal(safeMediaAnalysisUrl("http://192.168.1.8/private.mkv"), null);
});

test("stores a recent companion stream without exposing arbitrary URLs", async () => {
  const registry = new CompanionRegistry();
  registry.register({ streamUrl: "http://localhost:11470/infohash/2", duration: 1440, title: "Episode" });
  assert.equal((await registry.waitForRecent(10)).duration, 1440);
  assert.throws(() => registry.register({ streamUrl: "http://example.com/video" }));
  registry.registerTrusted({ streamUrl: "https://media.example/video.mkv", discoveredFrom: "test" });
  assert.equal(registry.latest().discoveredFrom, "test");
});
