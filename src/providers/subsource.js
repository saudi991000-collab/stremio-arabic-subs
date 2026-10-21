import { HttpError, limiterFor, safeFetch } from "../http.js";

const HOSTS = ["subsource.net"];
const limiter = limiterFor("subsource", { minIntervalMs: 300, concurrency: 2 });

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "results", "movies", "subtitles", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.[key]?.data)) return payload[key].data;
  }
  return [];
}

function movieIdOf(value) {
  return value?.id ?? value?.movieId ?? value?.movie_id;
}

function subtitleIdOf(value) {
  return value?.subtitleId ?? value?.subtitle_id ?? value?.id;
}

export class SubSourceProvider {
  constructor(config) {
    this.id = "subsource";
    this.config = config;
  }

  headers() {
    return { "X-API-Key": this.config.apiKey, Accept: "application/json" };
  }

  async json(path, signal) {
    try {
      const response = await safeFetch(`${this.config.baseUrl}${path}`, {
        allowedHosts: HOSTS,
        headers: this.headers(),
        signal,
        timeoutMs: 7000,
        limiter,
        label: "SubSource request",
        maxBytes: 4 * 1024 * 1024
      });
      return response.json();
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new HttpError("SubSource request quota has been reached", { status: 429 });
      if (error instanceof HttpError && error.status) throw new HttpError(`SubSource request failed with HTTP ${error.status}`, { status: error.status });
      throw error;
    }
  }

  async search(context, _maxPages, { signal } = {}) {
    if (!context.media.imdbId) return [];
    const movieQuery = new URLSearchParams({ searchType: "imdb", imdb: `tt${context.media.imdbId}` });
    const moviePayload = await this.json(`/movies/search?${movieQuery}`, signal);
    const movies = asArray(moviePayload);
    const movie = (context.media.type === "series"
      ? movies.find((item) => Number(item?.season) === Number(context.media.season))
      : null) || movies[0] || moviePayload?.data;
    const movieId = movieIdOf(movie);
    if (!movieId) return [];

    const subtitleQuery = new URLSearchParams({ movieId: String(movieId), language: "arabic", sort: "rating", limit: "100" });
    const payload = await this.json(`/subtitles?${subtitleQuery}`, signal);
    return asArray(payload).map((subtitle) => {
      const fileId = subtitleIdOf(subtitle);
      const releaseInfo = Array.isArray(subtitle.releaseInfo) ? subtitle.releaseInfo : [];
      const release = releaseInfo.join(" | ") || subtitle.releaseName || subtitle.release_name || subtitle.release || subtitle.title || subtitle.name || "";
      const rating = typeof subtitle.rating === "object"
        ? Number(subtitle.rating?.good || 0) - Number(subtitle.rating?.bad || 0)
        : Number(subtitle.rating || subtitle.score) || 0;
      return {
        provider: "subsource",
        fileId,
        downloadRef: fileId,
        fileName: subtitle.fileName || subtitle.file_name || `${release || `subtitle-${fileId}`}.srt`,
        release,
        comment: String(subtitle.commentary || subtitle.comment || "").slice(0, 300),
        uploader: String(subtitle.contributors?.[0]?.displayname || subtitle.uploader || "").slice(0, 80),
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        fps: Number(subtitle.fps || subtitle.frameRate || subtitle.framerate) || undefined,
        rating,
        downloadCount: Number(subtitle.downloads || subtitle.downloadCount) || 0,
        fromTrusted: Boolean(subtitle.trusted || subtitle.fromTrusted),
        hearingImpaired: Boolean(subtitle.hi || subtitle.hearingImpaired || subtitle.hearing_impaired),
        aiTranslated: Boolean(subtitle.aiTranslated || subtitle.ai_translated),
        machineTranslated: Boolean(subtitle.machineTranslated || subtitle.machine_translated),
        featureDetails: {
          seasonNumber: Number(subtitle.season || subtitle.seasonNumber) || undefined,
          episodeNumber: Number(subtitle.episode || subtitle.episodeNumber) || undefined
        }
      };
    }).filter((candidate) => candidate.fileId != null);
  }

  async download(ref, { signal } = {}) {
    const response = await safeFetch(`${this.config.baseUrl}/subtitles/${encodeURIComponent(ref)}/download`, {
      allowedHosts: HOSTS,
      headers: this.headers(),
      signal,
      timeoutMs: 12000,
      limiter,
      label: "SubSource download",
      maxBytes: 20 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: "subtitle.zip" };
  }
}
