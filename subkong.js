import { fileNameFromDisposition, limiterFor, safeFetch } from "../http.js";

const DEFAULT_BASE = "https://www.subkong.com";
const HOSTS = ["subkong.com"];
const limiter = limiterFor("subkong", { minIntervalMs: 250, concurrency: 2 });

function rowsOf(payload) {
  return Array.isArray(payload?.subtitles) ? payload.subtitles : [];
}

function safePath(value) {
  try {
    const url = new URL(String(value), DEFAULT_BASE);
    return url.protocol === "https:" && (url.hostname === "subkong.com" || url.hostname.endsWith(".subkong.com"));
  } catch {
    return false;
  }
}

function formatOf(row) {
  const value = String(row.SubFormat || row.format || row.name || "srt").toLowerCase();
  return value.match(/(?:^|\.)(srt|vtt|ass|ssa)(?:$|[?#])/)?.[1] || "srt";
}

export class SubKongProvider {
  constructor(config = {}) {
    this.id = "subkong";
    this.config = { baseUrl: DEFAULT_BASE, ...config };
  }

  async search(context, _maxPages, { signal } = {}) {
    if (!context.media.imdbId) return [];
    const params = new URLSearchParams({
      imdb_id: `tt${context.media.imdbId}`,
      language: "Arabic"
    });
    if (context.media.type === "series") {
      params.set("season", String(context.media.season));
      params.set("episode", String(context.media.episode));
    }
    const response = await safeFetch(`${this.config.baseUrl}/api/v1/subtitles?${params}`, {
      allowedHosts: HOSTS,
      headers: { Accept: "application/json" },
      signal,
      timeoutMs: 7000,
      limiter,
      label: "SubKong search",
      maxBytes: 4 * 1024 * 1024
    });
    return rowsOf(response.json()).map((row, index) => {
      if (!row?.download || !safePath(row.download)) return null;
      const format = formatOf(row);
      const release = row.MovieReleaseName || row.name || `subkong-${index + 1}`;
      const source = String(row.source || "subkong");
      return {
        provider: "subkong",
        fileId: `${source}:${row.download}`,
        downloadRef: new URL(row.download, this.config.baseUrl).toString(),
        fileName: `${release}.${format}`.replace(new RegExp(`\\.${format}\\.${format}$`, "i"), `.${format}`),
        release,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: context.media.type === "series",
        rating: source === "user" ? 2 : 0,
        downloadCount: Number(row.downloads) || 0,
        fromTrusted: source === "user",
        hearingImpaired: false,
        aiTranslated: /^(?:ai|machine|auto)\b/i.test(source),
        machineTranslated: /^(?:machine|auto)\b/i.test(source),
        featureDetails: {
          year: Number(row.MovieYear) || undefined,
          seasonNumber: context.media.type === "series" ? context.media.season : undefined,
          episodeNumber: context.media.type === "series" ? context.media.episode : undefined
        }
      };
    }).filter(Boolean);
  }

  async download(ref, { signal } = {}) {
    const response = await safeFetch(String(ref), {
      allowedHosts: HOSTS,
      signal,
      timeoutMs: 15000,
      limiter,
      label: "SubKong download",
      maxBytes: 32 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: fileNameFromDisposition(response.headers, "subtitle.zip") };
  }
}
