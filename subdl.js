import { HttpError, limiterFor, safeFetch } from "../http.js";

const API_HOSTS = ["api.subdl.com"];
const DOWNLOAD_HOSTS = ["subdl.com"];
const limiter = limiterFor("subdl", { minIntervalMs: 250, concurrency: 2 });

function allowedDownloadUrl(value) {
  try {
    const url = new URL(value, "https://dl.subdl.com");
    return url.protocol === "https:" && (url.hostname === "subdl.com" || url.hostname.endsWith(".subdl.com"));
  } catch {
    return false;
  }
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function mapSubtitle(parent, file, catalogMatch, episodeScoped = false) {
  const downloadRef = file.url || parent.url;
  if (!downloadRef || !allowedDownloadUrl(downloadRef)) return null;
  const language = String(file.language || parent.language || "AR").toUpperCase();
  if (!["AR", "ARA", "ARABIC"].includes(language)) return null;
  const release = file.release_name || parent.release_name || parent.name || file.name || "";
  return {
    provider: "subdl",
    fileId: file.file_n_id || parent.n_id || downloadRef,
    downloadRef,
    fileName: file.name || parent.name || `${release}.srt`,
    fileSize: positiveNumber(file.size || parent.size),
    release,
    comment: String(parent.comment || "").slice(0, 300),
    uploader: String(parent.author || "").slice(0, 80),
    language: "ar",
    hashMatch: false,
    catalogMatch,
    episodeScoped,
    fps: positiveNumber(file.fps || parent.fps),
    rating: Number(parent.rating) || 0,
    downloadCount: Number(parent.downloads) || 0,
    fromTrusted: false,
    hearingImpaired: Boolean(file.hi ?? parent.hi),
    aiTranslated: Boolean(file.ai_translated ?? parent.ai_translated),
    machineTranslated: Number(file.production_type ?? parent.production_type) === 3,
    featureDetails: {
      year: positiveNumber(file.year || parent.year),
      seasonNumber: positiveNumber(file.season ?? parent.season),
      episodeNumber: positiveNumber(file.episode ?? parent.episode)
    }
  };
}

export class SubDLProvider {
  constructor(config) {
    this.id = "subdl";
    this.config = config;
  }

  async search(context, _maxPages, { signal } = {}) {
    const common = {
      api_key: this.config.apiKey,
      type: context.media.type === "series" ? "tv" : "movie",
      languages: "AR",
      subs_per_page: "30",
      releases: "1",
      // Do not send hi=1: SubDL treats it as a filter and returns only
      // hearing-impaired files (1 result instead of 30 for a popular film).
      unpack: "1",
      client: "stremio"
    };
    const searches = [];
    if (context.media.imdbId) searches.push(new URLSearchParams({ ...common, imdb_id: `tt${context.media.imdbId}` }));
    if (context.extra.filename) searches.push(new URLSearchParams({ ...common, file_name: context.extra.filename }));
    if (!searches.length) return [];
    if (context.media.type === "series") {
      for (const params of searches) {
        params.set("season_number", String(context.media.season));
        params.set("episode_number", String(context.media.episode));
      }
    }
    const settled = await Promise.allSettled(searches.map(async (params) => {
      let response;
      try {
        response = await safeFetch(`${this.config.baseUrl}/subtitles?${params}`, {
          allowedHosts: API_HOSTS,
          headers: { Accept: "application/json" },
          signal,
          timeoutMs: 7000,
          limiter,
          label: "SubDL search",
          maxBytes: 4 * 1024 * 1024
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) throw new HttpError("SubDL request quota has been reached", { status: 429 });
        if (error instanceof HttpError && error.status) throw new HttpError(`SubDL search failed with HTTP ${error.status}`, { status: error.status });
        throw error;
      }
      const payload = response.json();
      if (payload?.status === false) throw new Error(`SubDL search failed: ${payload.error || "unknown error"}`);
      return payload;
    }));
    const payloads = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
    if (!payloads.length) throw settled[0].reason;
    const candidates = [];
    for (const payload of payloads) {
      for (const subtitle of payload.subtitles || []) {
        const files = subtitle.unpack_files?.length ? subtitle.unpack_files : [subtitle];
        for (const file of files) {
          const candidate = mapSubtitle(subtitle, file, Boolean(context.media.imdbId), context.media.type === "series");
          if (candidate) candidates.push(candidate);
        }
      }
    }
    return [...new Map(candidates.map((candidate) => [String(candidate.downloadRef), candidate])).values()];
  }

  async download(ref, { signal } = {}) {
    const url = new URL(String(ref), "https://dl.subdl.com").toString();
    const response = await safeFetch(url, {
      allowedHosts: DOWNLOAD_HOSTS,
      headers: { "X-API-Key": this.config.apiKey },
      signal,
      timeoutMs: 12000,
      limiter,
      label: "SubDL download",
      maxBytes: 20 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: "subtitle.zip" };
  }
}
