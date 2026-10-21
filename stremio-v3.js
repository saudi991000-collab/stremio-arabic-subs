import { limiterFor, safeFetch } from "../http.js";

const API_BASE = "https://opensubtitles-v3.strem.io";
const HOSTS = ["strem.io"];
const limiter = limiterFor("stremio-v3", { minIntervalMs: 100, concurrency: 4 });

function releaseOf(row) {
  return row.subtitleFileName || row.movieReleaseName || `subtitle-${row.id}.srt`;
}

function allowedSubtitleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "strem.io" || url.hostname.endsWith(".strem.io"));
  } catch {
    return false;
  }
}

function mapRow(row, episodeScoped = false) {
  const url = String(row.url || "");
  if (!url || !allowedSubtitleUrl(url)) return null;
  return {
    provider: "stremio-v3",
    fileId: String(row.id || url),
    downloadRef: url,
    fileName: releaseOf(row),
    release: row.movieReleaseName || releaseOf(row),
    language: "ar",
    fps: Number(row.fpsMilli) > 0 ? Number(row.fpsMilli) / 1000 : undefined,
    rating: 0,
    downloadCount: 0,
    hashMatch: false,
    catalogMatch: true,
    episodeScoped,
    featureDetails: {
      seasonNumber: Number(row.season) || undefined,
      episodeNumber: Number(row.episode) || undefined
    }
  };
}

export class StremioV3Provider {
  constructor() {
    this.id = "stremio-v3";
    this.cache = new Map();
  }

  async rows(context, signal) {
    const key = `${context.media.type}:${context.media.id}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.rows;
    const response = await safeFetch(`${API_BASE}/subtitles/${context.media.type}/${encodeURIComponent(context.media.id)}.json`, {
      allowedHosts: HOSTS,
      headers: { Accept: "application/json" },
      signal,
      timeoutMs: 6000,
      limiter,
      label: "Stremio OpenSubtitles v3",
      maxBytes: 4 * 1024 * 1024
    });
    const payload = response.json();
    const rows = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
    this.cache.set(key, { at: Date.now(), rows });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return rows;
  }

  async search(context, _maxPages, { signal } = {}) {
    if (!context.media.imdbId) return [];
    const rows = await this.rows(context, signal);
    return rows
      .filter((row) => ["ara", "ar", "arb"].includes(String(row.lang || "").toLowerCase()))
      .map((row) => mapRow(row, context.media.type === "series"))
      .filter(Boolean);
  }

  async download(ref, { signal } = {}) {
    const response = await safeFetch(String(ref), {
      allowedHosts: HOSTS,
      signal,
      timeoutMs: 12000,
      limiter,
      label: "Stremio subtitle download",
      maxBytes: 10 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: "subtitle.srt" };
  }
}
