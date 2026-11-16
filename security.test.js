import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAddonServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { signSubtitleToken, verifySubtitleToken } from "../src/token.js";
import { CompanionRegistry, isAllowedCompanionOrigin, safeStremioStreamUrl, sanitizeCompanionPayload } from "../src/companion.js";
import { assertAllowedUrl, isPrivateAddress, safeFetch } from "../src/http.js";
import { arabicSrt } from "./fixtures.js";

async function withServer(provider, env, callback) {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "aes-security-"));
  const config = readConfig({ CACHE_DIRECTORY: cacheDirectory, URL_TOKEN_SECRET: "security-secret", BACKGROUND_VALIDATION: "false", ...env });
  const server = await createAddonServer({ config, provider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, server.address().port); }
  finally {
    await server.flushBackground();
    await new Promise((resolve) => server.close(resolve));
  }
}

function rawRequest(port, { method = "GET", path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: data }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("companion accepts only loopback Stremio Service stream URLs", () => {
  assert.ok(safeStremioStreamUrl("http://127.0.0.1:11470/abc/0"));
  assert.ok(safeStremioStreamUrl("http://localhost:11470/hlsv2/x/master.m3u8"));
  for (const value of ["http://evil.example:11470/x", "https://127.0.0.1:11470/x", "http://127.0.0.1:8080/x", "http://169.254.169.254:11470/latest", "file:///etc/passwd", "http://127.0.0.1.nip.io:11470/x"]) {
    assert.equal(safeStremioStreamUrl(value), null, value);
  }
  const registry = new CompanionRegistry();
  assert.throws(() => registry.register({ streamUrl: "https://example.com/video.mkv" }), /local Stremio Service/);
  const clean = sanitizeCompanionPayload({ duration: "1e12", filename: "C:\\Videos\\Movie.mkv", videoHash: "not-a-hash", fps: 23.976 });
  assert.equal(clean.duration, undefined);
  assert.equal(clean.filename, "Movie.mkv");
  assert.equal(clean.videoHash, undefined);
  assert.equal(clean.fps, 23.976);
});

test("companion endpoints reject foreign web origins", async () => {
  assert.equal(isAllowedCompanionOrigin("https://evil.example"), false);
  assert.equal(isAllowedCompanionOrigin("https://web.stremio.com"), true);
  assert.equal(isAllowedCompanionOrigin(undefined), true);
  await withServer({ async search() { return []; } }, {}, async (_base, port) => {
    const body = JSON.stringify({ streamUrl: "http://127.0.0.1:11470/abc/0" });
    const evil = await rawRequest(port, { method: "POST", path: "/companion/session", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body });
    assert.equal(evil.status, 403);
    const ok = await rawRequest(port, { method: "POST", path: "/companion/session", headers: { "Content-Type": "application/json" }, body });
    assert.equal(ok.status, 200);
    assert.notEqual(ok.headers["access-control-allow-origin"], "*");
    const external = await rawRequest(port, { method: "POST", path: "/companion/session", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ streamUrl: "https://example.com/x.mkv" }) });
    assert.equal(external.status, 400);
  });
});

test("signed subtitle tokens resist tampering, wrong secrets and expiry", () => {
  const token = signSubtitleToken({ items: [{ provider: "subdl", ref: "/subtitle/1" }], extension: "srt" }, "secret-a");
  assert.equal(verifySubtitleToken(token, "secret-a").items[0].ref, "/subtitle/1");
  assert.throws(() => verifySubtitleToken(token, "secret-b"), /signature/);
  const [body, signature] = token.split(".");
  const flipped = `${body.slice(0, -2)}${body.at(-2) === "A" ? "B" : "A"}${body.at(-1)}.${signature}`;
  assert.throws(() => verifySubtitleToken(flipped, "secret-a"), /signature/);
  assert.throws(() => verifySubtitleToken(`${body}.`, "secret-a"), /Invalid/);
  assert.throws(() => verifySubtitleToken(token, "secret-a", Date.now() + 8 * 86400 * 1000), /expired/);
});

test("an invalid token never proxies anything and still returns a subtitle body", async () => {
  let downloads = 0;
  await withServer({ async search() { return []; }, async download() { downloads += 1; return { buffer: Buffer.from(arabicSrt(20)) }; } }, {}, async (base) => {
    const forged = signSubtitleToken({ items: [{ provider: "x", ref: "https://169.254.169.254/" }], extension: "srt" }, "attacker-secret");
    const response = await fetch(`${base}/subtitle/${forged}.srt`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-subtitle-fallback"), "empty");
    assert.equal(downloads, 0);
  });
});

test("API keys never appear in listings, tokens, health or logs", async () => {
  const secretKey = "SUPER-SECRET-KEY-123";
  const writes = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  try {
    const provider = {
      async search() {
        return [{ provider: "subdl", fileId: 1, downloadRef: "/subtitle/1", fileName: "Movie.2024.1080p.WEB-DL.srt", language: "ar" }];
      },
      async download() { return { buffer: Buffer.from(arabicSrt(30)), fileName: "a.srt" }; }
    };
    await withServer(provider, { SUBDL_API_KEY: secretKey, OPENSUBTITLES_API_KEY: secretKey, OPENSUBTITLES_PASSWORD: secretKey }, async (base) => {
      const listing = await (await fetch(`${base}/subtitles/movie/tt1234567/filename=Movie.2024.1080p.WEB-DL.mkv.json`)).text();
      const health = await (await fetch(`${base}/health`)).text();
      assert.doesNotMatch(listing, new RegExp(secretKey));
      assert.doesNotMatch(health, new RegExp(secretKey));
      const url = JSON.parse(listing).subtitles[0].url;
      const token = url.match(/\/subtitle\/([^/]+)\//)[1];
      assert.doesNotMatch(JSON.stringify(verifySubtitleToken(token, "security-secret")), new RegExp(secretKey));
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.doesNotMatch(writes.join(""), /SUPER-SECRET-KEY-123/);
});

test("safeFetch blocks SSRF: HTTP, foreign hosts, private addresses and unsafe redirects", async () => {
  await assert.rejects(() => assertAllowedUrl("http://api.subdl.com/x", ["subdl.com"]), /HTTPS/);
  await assert.rejects(() => assertAllowedUrl("https://subdl.com.evil.example/x", ["subdl.com"]), /Blocked host/);
  await assert.rejects(() => assertAllowedUrl("https://user:pass@subdl.com/x", ["subdl.com"]), /Credentials/);
  await assert.rejects(() => assertAllowedUrl("https://10.0.0.5/x", ["public"]), /private/);
  await assert.rejects(() => assertAllowedUrl("https://internal.example/x", ["public"], { resolver: async () => [{ address: "192.168.1.10" }] }), /private/);
  await assertAllowedUrl("https://cdn.example/x", ["public"], { resolver: async () => [{ address: "93.184.216.34" }] });
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  await assert.rejects(() => safeFetch("https://dl.subdl.com/a", {
    allowedHosts: ["subdl.com"],
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } })
  }), /Blocked host/);
});

test("safeFetch enforces the download size limit while streaming", async () => {
  const big = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }
  });
  await assert.rejects(() => safeFetch("https://dl.subdl.com/a", {
    allowedHosts: ["subdl.com"], maxBytes: 256 * 1024, fetchImpl: async () => new Response(big, { status: 200 })
  }), /too large/);
});

test("configure page escapes a hostile Host header", async () => {
  await withServer({ async search() { return []; } }, {}, async (_base, port) => {
    const page = await rawRequest(port, { path: "/configure", headers: { Host: "evil\"><script>alert(1)</script>" } });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /<script>alert/);
  });
});
