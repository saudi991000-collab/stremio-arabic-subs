import { parseReleaseName, titleSimilarity, titleTokens } from "../media.js";
import { limiterFor, safeFetch } from "../http.js";

const IDENTIFIER = "mora25r";
const BASE = `https://archive.org/download/${IDENTIFIER}`;
// archive.org serves files from numbered storage nodes (ia800000.us.archive.org).
const HOSTS = ["archive.org"];
const limiter = limiterFor("mora", { minIntervalMs: 250, concurrency: 2 });

function titleFor(context) {
  return context.media.releaseTitle
    || context.media.catalogTitle
    || context.media.title
    || parseReleaseName(context.extra.filename || "").title
    || "";
}

function safeName(value) {
  const name = String(value || "");
  return name && !/[\\/]/.test(name) && /\.(?:srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i.test(name) ? name : null;
}

export class MoraProvider {
  constructor(config = {}) {
    this.id = "mora";
    this.config = { metadataUrl: `https://archive.org/metadata/${IDENTIFIER}`, ...config };
    this.index = null;
    this.indexExpiresAt = 0;
    this.indexPromise = null;
  }

  async files(signal) {
    if (this.index && Date.now() < this.indexExpiresAt) return this.index;
    // Single-flight: concurrent listings share one index download.
    if (!this.indexPromise) {
      this.indexPromise = (async () => {
        const response = await safeFetch(this.config.metadataUrl, {
          allowedHosts: HOSTS,
          headers: { Accept: "application/json" },
          timeoutMs: 12000,
          limiter,
          label: "Mora archive index",
          maxBytes: 24 * 1024 * 1024
        });
        const payload = response.json();
        this.index = (Array.isArray(payload?.files) ? payload.files : [])
          .filter((file) => safeName(file.name))
          .map((file) => ({ name: file.name, size: file.size }));
        this.indexExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
        return this.index;
      })().finally(() => {
        this.indexPromise = null;
      });
    }
    if (!signal) return this.indexPromise;
    return Promise.race([
      this.indexPromise,
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true }))
    ]);
  }

  async search(context, _maxPages, { signal } = {}) {
    const wantedTitle = titleFor(context);
    if (!wantedTitle) return [];
    const wantedYear = parseReleaseName(context.extra.filename || "").year || Number(context.media.year) || undefined;
    const wantedTokens = new Set(titleTokens(wantedTitle));
    const files = await this.files(signal);
    return files.map((file) => {
      const parsed = parseReleaseName(file.name);
      const similarity = titleSimilarity(wantedTitle, file.name);
      if (similarity < 0.55) return null;
      const candidateTokens = new Set(titleTokens(file.name));
      const sharedWanted = [...wantedTokens].filter((token) => candidateTokens.has(token)).length;
      if (wantedTokens.size >= 3 && sharedWanted / wantedTokens.size < 0.6) return null;
      if (wantedYear && parsed.year && Math.abs(wantedYear - parsed.year) > 1) return null;
      if (context.media.type === "series") {
        if (parsed.season !== Number(context.media.season) || parsed.episode !== Number(context.media.episode)) return null;
      }
      return {
        provider: this.id,
        fileId: file.name,
        downloadRef: file.name,
        fileName: file.name,
        release: file.name,
        language: "ar",
        hashMatch: false,
        catalogMatch: false,
        episodeScoped: context.media.type === "series",
        rating: 2,
        downloadCount: 0,
        fromTrusted: true,
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        fileSize: Number(file.size) || undefined,
        featureDetails: {
          seasonNumber: parsed.season,
          episodeNumber: parsed.episode,
          year: parsed.year
        }
      };
    }).filter(Boolean)
      .sort((a, b) => titleSimilarity(wantedTitle, b.fileName) - titleSimilarity(wantedTitle, a.fileName) || a.fileName.localeCompare(b.fileName))
      .slice(0, 50);
  }

  async download(ref, { signal } = {}) {
    const name = safeName(ref);
    if (!name) throw new Error("Invalid Mora subtitle name");
    const response = await safeFetch(`${BASE}/${encodeURIComponent(name)}`, {
      allowedHosts: HOSTS,
      signal,
      timeoutMs: 15000,
      limiter,
      label: "Mora subtitle download",
      maxBytes: 20 * 1024 * 1024,
      maxRedirects: 5
    });
    return { buffer: response.buffer, fileName: name };
  }
}
