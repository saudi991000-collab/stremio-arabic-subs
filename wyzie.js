import { HttpError, fileNameFromDisposition, limiterFor, safeFetch } from "../http.js";

const DOWNLOAD_HOST = "sub.wyzie.io";
const HOSTS = [DOWNLOAD_HOST];
const NATIVE_FORMATS = new Set(["srt", "vtt", "ass", "ssa"]);
const limiter = limiterFor("wyzie", { minIntervalMs: 200, concurrency: 3 });

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "results", "subtitles", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return payload && typeof payload === "object" && payload.url ? [payload] : [];
}

function safeDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === DOWNLOAD_HOST || url.hostname.endsWith(`.${DOWNLOAD_HOST}`));
  } catch {
    return false;
  }
}

function convertedUrl(value, format) {
  const url = new URL(value);
  if (!NATIVE_FORMATS.has(format)) url.searchParams.set("to", "srt");
  return url.toString();
}

function mappedFormat(row) {
  const format = String(row.format || row.fileName || "srt").toLowerCase().match(/(?:^|\.)(srt|vtt|ass|ssa)$/)?.[1]
    || String(row.format || "srt").toLowerCase();
  return NATIVE_FORMATS.has(format) ? format : "srt";
}

function mapRow(row, context) {
  if (!row?.url || !safeDownloadUrl(row.url)) return null;
  if (row.ai === true || /^(?:ai|machine|auto)/i.test(String(row.source || ""))) return null;
  if (row.language && String(row.language).toLowerCase() !== "ar") return null;
  const originalFormat = String(row.format || "srt").toLowerCase();
  const format = mappedFormat(row);
  const ref = convertedUrl(row.url, originalFormat);
  const release = row.release || row.matchedRelease || row.releases?.[0] || row.media || "";
  const fileName = String(row.fileName || `${release || `wyzie-${row.id}`}.${format}`).replace(/\.[a-z0-9]+$/i, `.${format}`);
  return {
    provider: "wyzie",
    fileId: `${row.source || "source"}:${row.id || ref}`,
    downloadRef: ref,
    fileName,
    release,
    origin: String(row.source || "").slice(0, 40),
    language: "ar",
    hashMatch: false,
    catalogMatch: true,
    episodeScoped: context.media.type === "series",
    rating: Number(row.rating || row.score) || 0,
    downloadCount: Number(row.downloadCount) || 0,
    fromTrusted: false,
    hearingImpaired: Boolean(row.isHearingImpaired),
    aiTranslated: false,
    machineTranslated: false,
    featureDetails: {
      seasonNumber: context.media.type === "series" ? context.media.season : undefined,
      episodeNumber: context.media.type === "series" ? context.media.episode : undefined
    }
  };
}

export class WyzieProvider {
  constructor(config) {
    this.id = "wyzie";
    this.config = config;
  }

  async search(context, _maxPages, { signal } = {}) {
    if (!this.config.apiKey || !context.media.imdbId) return [];
    const params = new URLSearchParams({
      id: `tt${context.media.imdbId}`,
      language: "ar",
      source: "all",
      limit: "200",
      key: this.config.apiKey
    });
    if (context.media.type === "series") {
      params.set("season", String(context.media.season));
      params.set("episode", String(context.media.episode));
    }
    let response;
    try {
      response = await safeFetch(`${this.config.baseUrl}/search?${params}`, {
        allowedHosts: HOSTS,
        headers: { Accept: "application/json" },
        signal,
        timeoutMs: 8000,
        limiter,
        label: "Wyzie search",
        maxBytes: 4 * 1024 * 1024,
        okStatuses: [400]
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new HttpError("Wyzie daily request limit has been reached", { status: 429 });
      if (error instanceof HttpError && error.status === 402) throw new HttpError("Wyzie paid request balance has been reached", { status: 402 });
      if (error instanceof HttpError && error.status) throw new HttpError(`Wyzie search failed with HTTP ${error.status}`, { status: error.status });
      throw error;
    }
    if (response.status === 400) return [];
    return rowsOf(response.json()).map((row) => mapRow(row, context)).filter(Boolean);
  }

  async download(ref, { signal } = {}) {
    const response = await safeFetch(String(ref), {
      allowedHosts: HOSTS,
      signal,
      timeoutMs: 12000,
      limiter,
      label: "Wyzie subtitle download",
      maxBytes: 20 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: fileNameFromDisposition(response.headers, "subtitle.srt") };
  }
}
