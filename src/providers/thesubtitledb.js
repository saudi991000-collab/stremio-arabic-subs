import { fileNameFromDisposition, limiterFor, safeFetch } from "../http.js";

const HOSTS = ["api.thesubtitledb.org"];
// /get/{id} redirects to files.thesubtitledb.org.
const DOWNLOAD_HOSTS = ["thesubtitledb.org"];
const limiter = limiterFor("thesubtitledb", { minIntervalMs: 200, concurrency: 3 });

function rowsOf(payload) {
  return Array.isArray(payload?.subtitles?.items) ? payload.subtitles.items : [];
}

function safeSubtitleId(value) {
  const id = String(value || "");
  return /^\d+$/.test(id) && Number(id) > 0 ? id : null;
}

export class TheSubtitleDbProvider {
  constructor(config = {}) {
    this.id = "thesubtitledb";
    this.config = { baseUrl: "https://api.thesubtitledb.org/v1", ...config };
  }

  async search(context, _maxPages, { signal } = {}) {
    if (!context.media.imdbId) return [];
    let path = `/by-imdb/tt${context.media.imdbId}`;
    if (context.media.type === "series") {
      path += `/season/${context.media.season}/episode/${context.media.episode}`;
    }
    const params = new URLSearchParams({ lang: "ar", limit: "100" });
    const response = await safeFetch(`${this.config.baseUrl}${path}?${params}`, {
      allowedHosts: HOSTS,
      headers: { Accept: "application/json" },
      signal,
      timeoutMs: 7000,
      limiter,
      label: "TheSubtitleDB search",
      maxBytes: 4 * 1024 * 1024,
      okStatuses: [404]
    });
    if (response.status === 404) return [];
    const payload = response.json();
    return rowsOf(payload).map((row) => {
      const id = safeSubtitleId(row.id);
      if (!id || String(row.language || "").toLowerCase() !== "ar") return null;
      const format = String(row.format || "srt").toLowerCase().replace(/[^a-z0-9]/g, "") || "srt";
      const release = String(row.release_name || `Arabic.${id}`);
      return {
        provider: this.id,
        fileId: id,
        downloadRef: id,
        fileName: `${release.replace(/\.(?:srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i, "")}.${format}`,
        release,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: context.media.type === "series",
        rating: 0,
        downloadCount: 0,
        fromTrusted: false,
        hearingImpaired: Boolean(row.hearing_impaired),
        aiTranslated: Boolean(row.ai_translated || row.machine_translated),
        machineTranslated: Boolean(row.machine_translated),
        fps: Number(row.fps) || undefined,
        fileSize: Number(row.bytes) || undefined,
        featureDetails: {
          seasonNumber: context.media.type === "series" ? Number(context.media.season) : undefined,
          episodeNumber: context.media.type === "series" ? Number(context.media.episode) : undefined,
          year: Number(payload?.title?.year) || undefined
        }
      };
    }).filter(Boolean);
  }

  async download(ref, { signal } = {}) {
    const id = safeSubtitleId(ref);
    if (!id) throw new Error("Invalid TheSubtitleDB subtitle id");
    const response = await safeFetch(`https://${HOSTS[0]}/get/${id}`, {
      allowedHosts: DOWNLOAD_HOSTS,
      headers: { Accept: "text/plain,application/octet-stream,*/*" },
      signal,
      timeoutMs: 12000,
      limiter,
      label: "TheSubtitleDB download",
      maxBytes: 20 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: fileNameFromDisposition(response.headers, `${id}.srt`) };
  }
}
