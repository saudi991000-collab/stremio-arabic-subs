import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { USER_AGENT } from "./version.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, { status, retryable = false, rateLimited = false } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
    this.rateLimited = rateLimited;
  }
}

export function isPrivateAddress(address = "") {
  const value = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(value) === 6) {
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return /^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(value);
  }
  return false;
}

// Host allow-lists are exact names or dot-suffixes ("example.com" also allows
// "dl.example.com"). The special value "public" allows any host whose DNS
// answers are all public addresses, which protects against SSRF to internal
// services when a provider returns third-party CDN links.
export function hostAllowed(hostname, allowedHosts) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return allowedHosts.some((allowed) => allowed !== "public" && (host === allowed || host.endsWith(`.${allowed}`)));
}

async function assertPublicHost(hostname, resolver = lookup) {
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) {
    if (isPrivateAddress(hostname)) throw new HttpError("Blocked private network address");
    return;
  }
  if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw new HttpError("Blocked local host name");
  const answers = await resolver(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => isPrivateAddress(answer.address))) throw new HttpError("Blocked private network address");
}

export async function assertAllowedUrl(value, allowedHosts, { resolver } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new HttpError("Invalid URL");
  }
  if (url.protocol !== "https:") throw new HttpError("Only HTTPS URLs are allowed");
  if (url.username || url.password) throw new HttpError("Credentials in URLs are not allowed");
  if (hostAllowed(url.hostname, allowedHosts)) return url;
  if (allowedHosts.includes("public")) {
    await assertPublicHost(url.hostname, resolver);
    return url;
  }
  throw new HttpError(`Blocked host ${url.hostname}`);
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("aborted"));
    }, { once: true });
  });
}

export function backoffDelay(attempt, { baseMs = 400, maxMs = 4000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  // "Full jitter" keeps many concurrent requests from retrying in lockstep.
  return Math.round(exponential / 2 + random() * exponential / 2);
}

// A tiny per-host limiter: at most `concurrency` requests in flight and at
// least `minIntervalMs` between request starts. It is intentionally in-process;
// Render runs a single instance of this add-on.
export class RateLimiter {
  constructor({ minIntervalMs = 0, concurrency = 4 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.concurrency = concurrency;
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
    this.blockedUntil = 0;
  }

  pause(milliseconds) {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + milliseconds);
  }

  async run(task, signal) {
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      signal?.addEventListener("abort", () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(signal.reason || new Error("aborted"));
        }
      }, { once: true });
      this.#drain();
    });
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.#drain();
    }
  }

  #drain() {
    if (!this.queue.length || this.active >= this.concurrency) return;
    const wait = Math.max(this.lastStart + this.minIntervalMs, this.blockedUntil) - Date.now();
    if (wait > 0) {
      // Not unref'd: a queued request must keep the process alive.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#drain(), wait);
      return;
    }
    const next = this.queue.shift();
    this.active += 1;
    this.lastStart = Date.now();
    next.resolve();
    this.#drain();
  }
}

const limiters = new Map();
export function limiterFor(key, options) {
  if (!limiters.has(key)) limiters.set(key, new RateLimiter(options));
  return limiters.get(key);
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError("Response is too large");
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      await response.body.cancel?.().catch(() => null);
      throw new HttpError("Response is too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/**
 * Fetches a URL with the safety rules every provider needs:
 * - HTTPS only, and only to allow-listed hosts (re-checked on every redirect);
 * - bounded body size, read as a stream instead of trusting Content-Length;
 * - an independent timeout that also honours the caller's AbortSignal;
 * - limited retries with exponential backoff and jitter on 429/5xx/network errors;
 * - a per-provider rate limiter, paused when the server returns Retry-After.
 */
export async function safeFetch(value, {
  allowedHosts,
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs = 8000,
  maxBytes = DEFAULT_MAX_BYTES,
  retries = 1,
  maxRedirects = 4,
  limiter,
  resolver,
  fetchImpl = globalThis.fetch,
  label = "request",
  okStatuses = []
} = {}) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) throw new Error("safeFetch requires allowedHosts");
  let attempt = 0;
  for (;;) {
    try {
      const run = async () => {
        let current = (await assertAllowedUrl(value, allowedHosts, { resolver })).toString();
        let currentMethod = method;
        let currentBody = body;
        for (let redirects = 0; ; redirects += 1) {
          const response = await fetchImpl(current, {
            method: currentMethod,
            headers: { "User-Agent": USER_AGENT, ...headers },
            body: currentBody,
            redirect: "manual",
            signal: combineSignals(signal, timeoutMs)
          });
          if (REDIRECT_STATUSES.has(response.status)) {
            if (redirects >= maxRedirects) throw new HttpError(`${label}: too many redirects`);
            const location = response.headers.get("location");
            if (!location) throw new HttpError(`${label}: redirect without location`);
            current = (await assertAllowedUrl(new URL(location, current).toString(), allowedHosts, { resolver })).toString();
            if (response.status === 303) {
              currentMethod = "GET";
              currentBody = undefined;
            }
            continue;
          }
          if (!response.ok && !okStatuses.includes(response.status)) {
            const retryable = RETRY_STATUSES.has(response.status);
            if (response.status === 429) limiter?.pause(Math.min(30000, retryAfterMs(response) || 5000));
            await response.body?.cancel?.().catch(() => null);
            throw new HttpError(`${label} failed with HTTP ${response.status}`, {
              status: response.status,
              retryable,
              rateLimited: response.status === 429
            });
          }
          const buffer = await readLimited(response, maxBytes);
          return {
            status: response.status,
            url: current,
            headers: response.headers,
            buffer,
            text: () => buffer.toString("utf8"),
            json: () => JSON.parse(buffer.toString("utf8") || "null")
          };
        }
      };
      return limiter ? await limiter.run(run, signal) : await run();
    } catch (error) {
      const aborted = signal?.aborted;
      const network = error?.name === "TypeError" || error?.cause?.code === "ECONNRESET" || error?.cause?.code === "ETIMEDOUT";
      const retryable = !aborted && (error?.retryable || network) && attempt < retries;
      if (!retryable) throw error;
      await sleep(backoffDelay(attempt), signal);
      attempt += 1;
    }
  }
}

export function fileNameFromDisposition(headers, fallback) {
  const disposition = headers?.get?.("content-disposition") || "";
  const raw = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1] || disposition.match(/filename="?([^";]+)"?/i)?.[1];
  if (!raw) return fallback;
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw value
  }
  // Never let a server-provided name contain a path.
  return decoded.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f]/g, "").slice(0, 200) || fallback;
}
