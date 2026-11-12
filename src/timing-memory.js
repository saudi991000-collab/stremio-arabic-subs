import { createHash } from "node:crypto";
import path from "node:path";
import { isIdentityTransform } from "./timing.js";

// Shared timing memory.
//
// TVs and tablets cannot let the add-on hear the video, so a timing correction
// found once (from an English reference, from Whisper on the PC, or typed in
// by the user on the /timing page) is stored per video and per subtitle and
// served to every device that plays the same video afterwards.

const KIND_RANK = { manual: 5, "audio-whisper": 4, embedded: 4, "embedded-sample": 4, "exact-hash": 4, consensus: 3, release: 2, vad: 1 };
const RECENT_KEY = "timing:v1:recent";
const MAX_RECENT = 40;
const MAX_ITEMS_PER_VIDEO = 60;

export function videoKey(extra = {}) {
  const hash = String(extra.videoHash || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 32);
  if (hash) return `h:${hash}:${Number(extra.videoSize) || ""}`;
  const name = path.basename(String(extra.filename || "")).toLowerCase().trim().slice(0, 240);
  return name ? `f:${name}` : "";
}

export function episodeKey(media = {}) {
  const id = media.imdbId ? `tt${String(media.imdbId).replace(/^tt/, "")}` : String(media.id || media.sourceId || "");
  if (!id) return "";
  return media.type === "series" ? `${id.split(":")[0]}:${media.season ?? ""}:${media.episode ?? ""}` : id;
}

export function itemId(item = {}) {
  const ref = String(item.ref ?? item.downloadRef ?? item.fileId ?? "");
  return createHash("sha1").update(`${item.provider || "opensubtitles"}:${ref}`).digest("hex").slice(0, 16);
}

// Moves every cue by `seconds` after the existing mapping.
export function addOffset(transform, seconds) {
  const delta = Number(seconds) || 0;
  if (!transform || (!transform.segments && isIdentityTransform(transform))) return { scale: 1, offset: delta };
  if (Array.isArray(transform.segments) && transform.segments.length) {
    return { segments: transform.segments.map((segment) => ({ ...segment, offset: Number(segment.offset) + delta })) };
  }
  return { scale: Number(transform.scale) || 1, offset: (Number(transform.offset) || 0) + delta };
}

function plain(transform) {
  if (!transform) return null;
  if (Array.isArray(transform.segments) && transform.segments.length) {
    return {
      segments: transform.segments.map((segment) => ({
        start: Number.isFinite(Number(segment.start)) ? Number(Number(segment.start).toFixed(3)) : -1e9,
        end: Number.isFinite(Number(segment.end)) ? Number(Number(segment.end).toFixed(3)) : 1e9,
        scale: Number(Number(segment.scale).toFixed(7)),
        offset: Number(Number(segment.offset).toFixed(3))
      }))
    };
  }
  return { scale: Number((Number(transform.scale) || 1).toFixed(7)), offset: Number((Number(transform.offset) || 0).toFixed(3)) };
}

function strength(entry) {
  if (!entry) return -1;
  return (KIND_RANK[entry.kind] || 2) + Math.max(0, Math.min(1, Number(entry.score) || 0));
}

export class TimingMemory {
  constructor(store) {
    this.store = store;
    this.locks = new Map();
  }

  #key(context) {
    const episode = episodeKey(context?.media);
    const video = videoKey(context?.extra);
    return episode && video ? `timing:v1:${episode}|${video}` : "";
  }

  // Serialises read-modify-write per key (two devices may save at once).
  #update(key, change) {
    const previous = this.locks.get(key) || Promise.resolve();
    const work = previous.then(async () => {
      const current = (await this.store.get(key)) || { items: {} };
      const next = change(structuredClone(current));
      if (next) {
        const ids = Object.keys(next.items || {});
        if (ids.length > MAX_ITEMS_PER_VIDEO) {
          ids.sort((a, b) => (next.items[a].at || 0) - (next.items[b].at || 0));
          for (const id of ids.slice(0, ids.length - MAX_ITEMS_PER_VIDEO)) delete next.items[id];
        }
        await this.store.set(key, next);
      }
      return next || current;
    });
    const settled = work.catch(() => null);
    this.locks.set(key, settled);
    settled.finally(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return work;
  }

  // Saves an automatic correction unless a stronger one is already known.
  async rememberAuto(context, item, transform) {
    const key = this.#key(context);
    if (!key || !transform) return null;
    const entry = { transform: plain(transform), kind: transform.reference || "release", score: Number(transform.score) || 0, at: Date.now() };
    return this.#update(key, (record) => {
      const id = itemId(item);
      const existing = record.items[id] || {};
      if (strength(existing.auto) > strength(entry)) return null;
      record.items[id] = { ...existing, auto: entry, at: Date.now() };
      return record;
    });
  }

  async lookup(context, item) {
    const key = this.#key(context);
    if (!key) return {};
    const record = await this.store.get(key).catch(() => undefined);
    const saved = record?.items?.[itemId(item)];
    if (!saved) return {};
    return {
      auto: saved.auto?.transform ? { ...saved.auto.transform, score: saved.auto.score, reference: saved.auto.kind } : undefined,
      manual: saved.manual?.transform ? { ...saved.manual.transform, score: 1, reference: "manual" } : undefined
    };
  }

  // Records what was actually served (the /timing page corrects from it) and
  // keeps a short list of recently played subtitles for that page.
  async recordServed(context, item, transform, label) {
    const key = this.#key(context);
    if (!key) return;
    const id = itemId(item);
    await this.#update(key, (record) => {
      record.items[id] = { ...(record.items[id] || {}), served: plain(transform) || { scale: 1, offset: 0 }, at: Date.now() };
      return record;
    });
    const media = context.media || {};
    const recent = {
      key,
      item: id,
      label: String(label || item.fileName || "").slice(0, 160),
      title: String(media.catalogTitle || media.title || media.releaseTitle || media.imdbId || "").slice(0, 120),
      season: media.season,
      episode: media.episode,
      at: Date.now()
    };
    await this.#update(RECENT_KEY, (record) => {
      const list = (record.list || []).filter((entry) => !(entry.key === key && entry.item === id));
      return { list: [recent, ...list].slice(0, MAX_RECENT) };
    });
  }

  async recent() {
    const record = await this.store.get(RECENT_KEY).catch(() => undefined);
    return record?.list || [];
  }

  // `seconds` > 0 shows the subtitle later, < 0 earlier, relative to what the
  // viewer last saw. `reset` removes the manual correction.
  async fix(key, id, { seconds = 0, reset = false } = {}) {
    if (!/^timing:v1:[^|]+\|[hf]:/.test(String(key)) || !/^[0-9a-f]{16}$/.test(String(id))) throw new Error("Unknown subtitle");
    let result;
    await this.#update(key, (record) => {
      const saved = record.items[id];
      if (!saved) throw new Error("Unknown subtitle");
      if (reset) {
        delete saved.manual;
        // What was served included the manual shift; forget it too.
        delete saved.served;
        result = { reset: true };
      } else {
        const base = saved.served || saved.manual?.transform || saved.auto?.transform;
        const transform = plain(addOffset(base, seconds));
        saved.manual = { transform, at: Date.now() };
        result = { transform };
      }
      saved.at = Date.now();
      return record;
    });
    return result;
  }
}
