import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "./logger.js";

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// Optional Upstash Redis (REST) backend. Render's free instances lose their
// disk on every restart or spin-down, so without a remote store every cold
// start begins with an empty cache. The backend is used only when both
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are configured.
export class UpstashKv {
  constructor({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 1500, prefix = "aes:" }) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("UPSTASH_REDIS_REST_URL must use HTTPS");
    this.url = parsed.toString().replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.prefix = prefix;
  }

  async command(args) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Upstash request failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error("Upstash command failed");
    return payload?.result;
  }

  async get(key) {
    const value = await this.command(["GET", `${this.prefix}${key}`]);
    return value == null ? undefined : JSON.parse(value);
  }

  async set(key, value, ttlSeconds) {
    await this.command(["SET", `${this.prefix}${key}`, JSON.stringify(value), "EX", String(Math.max(60, Math.round(ttlSeconds)))]);
  }
}

/**
 * Three-level JSON store: in-memory LRU -> local disk -> optional remote KV.
 * Values are immutable snapshots; callers must never mutate what they get.
 */
export class JsonStore {
  constructor({ directory, namespace, ttlSeconds, maxMemoryEntries = 2000, remote = null }) {
    this.directory = directory ? path.join(directory, namespace) : "";
    this.namespace = namespace;
    this.ttlMs = ttlSeconds * 1000;
    this.maxMemoryEntries = maxMemoryEntries;
    this.remote = remote;
    this.memory = new Map();
    this.ready = this.directory ? mkdir(this.directory, { recursive: true }).catch(() => null) : Promise.resolve();
    this.writes = new Set();
  }

  #remember(key, record) {
    this.memory.delete(key);
    this.memory.set(key, record);
    while (this.memory.size > this.maxMemoryEntries) this.memory.delete(this.memory.keys().next().value);
  }

  #filePath(key) {
    return path.join(this.directory, `${hashKey(key)}.json`);
  }

  async get(key) {
    const now = Date.now();
    let record = this.memory.get(key);
    if (!record && this.directory) {
      await this.ready;
      try {
        record = JSON.parse(await readFile(this.#filePath(key), "utf8"));
      } catch {
        record = undefined;
      }
    }
    if (!record && this.remote) {
      try {
        record = await this.remote.get(`${this.namespace}:${hashKey(key)}`);
      } catch (error) {
        logger.warn("remote cache read failed", { namespace: this.namespace, reason: error.message });
      }
    }
    if (!record || record.key !== key || record.expiresAt < now) {
      if (record) this.memory.delete(key);
      return undefined;
    }
    record = deepFreeze(record);
    this.#remember(key, record);
    return record.value;
  }

  async set(key, value, ttlSeconds = this.ttlMs / 1000) {
    const record = deepFreeze({ key, value, expiresAt: Date.now() + ttlSeconds * 1000, storedAt: Date.now() });
    this.#remember(key, record);
    const work = (async () => {
      if (this.directory) {
        await this.ready;
        const target = this.#filePath(key);
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(record));
          await rename(temporary, target);
        } catch (error) {
          logger.warn("disk cache write failed", { namespace: this.namespace, reason: error.message });
        }
      }
      if (this.remote) {
        await this.remote.set(`${this.namespace}:${hashKey(key)}`, record, ttlSeconds).catch((error) => {
          logger.warn("remote cache write failed", { namespace: this.namespace, reason: error.message });
        });
      }
    })();
    this.writes.add(work);
    work.finally(() => this.writes.delete(work));
    return record.value;
  }

  async flush() {
    await Promise.allSettled([...this.writes]);
  }
}

const STATUS_RANK = { ok: 3, empty: 3, partial: 2, timeout: 1, error: 0, skipped: 0 };

export function candidateKey(candidate) {
  return `${candidate.provider || "default"}:${String(candidate.downloadRef ?? candidate.fileId)}`;
}

/**
 * Merges a new provider snapshot into the previous cached search result.
 * - A provider that answered now replaces its own previous candidates.
 * - A provider that failed or timed out now keeps its previous candidates.
 * - The merged entry is complete only when every expected provider answered.
 */
export function mergeSearchEntries(previous, snapshot, expectedProviders = []) {
  const providers = { ...(previous?.providers || {}) };
  const byProvider = new Map();
  for (const candidate of previous?.candidates || []) {
    const id = candidate.provider || "default";
    if (!byProvider.has(id)) byProvider.set(id, []);
    byProvider.get(id).push(candidate);
  }
  for (const [id, status] of Object.entries(snapshot.providers || {})) {
    const fresh = status.status === "ok" || status.status === "empty";
    const old = providers[id];
    if (fresh) {
      byProvider.set(id, (snapshot.candidates || []).filter((candidate) => (candidate.provider || "default") === id));
      providers[id] = status;
    } else if (!old || (STATUS_RANK[status.status] ?? 0) >= (STATUS_RANK[old.status] ?? 0)) {
      // Keep any candidates the provider returned earlier; just record the
      // latest failure so the entry is refreshed again soon.
      providers[id] = { ...status, previousStatus: old?.status, previousCount: old?.count };
      if (!byProvider.has(id)) byProvider.set(id, []);
    } else {
      providers[id] = { ...old, lastFailure: status.status, lastFailureAt: status.at };
    }
  }
  const candidates = [...byProvider.values()].flat()
    .filter((candidate, index, all) => all.findIndex((item) => candidateKey(item) === candidateKey(candidate)) === index)
    .sort((a, b) => candidateKey(a).localeCompare(candidateKey(b)));
  const expected = expectedProviders.length ? expectedProviders : Object.keys(providers);
  const complete = expected.every((id) => {
    const status = providers[id]?.status;
    const lastFailure = providers[id]?.lastFailure;
    return (status === "ok" || status === "empty") && !lastFailure;
  });
  return deepFreeze({
    candidates,
    providers,
    complete,
    updatedAt: Date.now(),
    createdAt: previous?.createdAt || Date.now()
  });
}
