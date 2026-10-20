const API_HOST = "api.thesubtitledb.org";

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

  async search(context) {
    if (!context.media.imdbId) return [];
    let path = `/by-imdb/tt${context.media.imdbId}`;
    if (context.media.type === "series") {
      path += `/season/${context.media.season}/episode/${context.media.episode}`;
    }
    const params = new URLSearchParams({ lang: "ar", limit: "100" });
    const response = await fetch(`${this.config.baseUrl}${path}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "ArabicEliteSubs/3.5.1" },
      signal: AbortSignal.timeout(9000)
    });
    if (response.status === 404) return [];
    if (response.status === 429) throw new Error("TheSubtitleDB rate limit reached");
    if (!response.ok) throw new Error(`TheSubtitleDB search failed with HTTP ${response.status}`);
    const payload = await response.json();
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
        aiTranslated: false,
        machineTranslated: false,
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

  async download(ref) {
    const id = safeSubtitleId(ref);
    if (!id) throw new Error("Invalid TheSubtitleDB subtitle id");
    const response = await fetch(`https://${API_HOST}/get/${id}`, {
      headers: { Accept: "text/plain,application/octet-stream,*/*", "User-Agent": "ArabicEliteSubs/3.5.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(`TheSubtitleDB download failed with HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 20 * 1024 * 1024) throw new Error("TheSubtitleDB subtitle is too large");
    const disposition = response.headers.get("content-disposition") || "";
    const fileName = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || `${id}.srt`;
    return { buffer: Buffer.from(await response.arrayBuffer()), fileName: decodeURIComponent(fileName) };
  }
}
