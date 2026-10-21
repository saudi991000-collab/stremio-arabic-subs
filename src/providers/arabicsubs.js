import { normalizeName, parseReleaseName } from "../media.js";
import { HttpError, limiterFor, safeFetch } from "../http.js";

const HOSTS = ["arabicsubs.com"];
const limiter = limiterFor("arabicsubs", { minIntervalMs: 250, concurrency: 2 });

const IGNORED_MOVIE_TOKENS = new Set([
  "the", "a", "an", "and", "of", "in", "on", "to", "ar", "ara", "arabic", "srt", "ass", "ssa", "vtt",
  "mkv", "mp4", "avi", "2160p", "1080p", "720p", "480p", "web", "webdl", "dl", "webrip", "bluray", "brrip",
  "remux", "hdtv", "x264", "x265", "h264", "h265", "hevc", "av1", "aac", "dts", "dd", "ddp", "atmos",
  "hdr", "hdr10", "dv", "proper", "repack", "extended", "unrated", "51", "71"
]);

function movieTitleTokens(value) {
  return [...new Set(normalizeName(value).split(" ").filter((token) =>
    token.length >= 2 && !/^\d{4}$/.test(token) && !IGNORED_MOVIE_TOKENS.has(token)
  ))];
}

function movieFilenameMatches(requested, candidate) {
  const wanted = parseReleaseName(requested);
  const actual = parseReleaseName(candidate);
  if (wanted.year && actual.year && wanted.year !== actual.year) return false;
  const wantedTokens = movieTitleTokens(requested);
  const candidateTokens = new Set(movieTitleTokens(candidate));
  if (!wantedTokens.length) return false;
  const shared = wantedTokens.filter((token) => candidateTokens.has(token));
  return shared.length >= Math.min(2, wantedTokens.length);
}

export class ArabicSubsProvider {
  constructor(config) {
    this.id = "arabicsubs";
    this.config = config;
  }

  headers() {
    return { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" };
  }

  async search(context, _maxPages, { signal } = {}) {
    if (!context.extra.filename) return [];
    const query = new URLSearchParams({ filename: context.extra.filename, limit: "25" });
    let response;
    try {
      response = await safeFetch(`${this.config.baseUrl}/subtitles/match?${query}`, {
        allowedHosts: HOSTS,
        headers: this.headers(),
        signal,
        timeoutMs: 7000,
        limiter,
        label: "ArabicSubs search",
        maxBytes: 2 * 1024 * 1024
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new HttpError("ArabicSubs request quota has been reached", { status: 429 });
      if (error instanceof HttpError && error.status) throw new HttpError(`ArabicSubs search failed with HTTP ${error.status}`, { status: error.status });
      throw error;
    }
    const payload = response.json();
    return (payload?.matches || []).map((subtitle) => {
      const fileName = subtitle.originalFilename || `arabic-${subtitle.id}.srt`;
      const parsed = parseReleaseName(fileName);
      const declaredSeason = Number(subtitle.seasonNumber ?? subtitle.season ?? subtitle.episode?.seasonNumber) || undefined;
      const declaredEpisode = Number(subtitle.episodeNumber ?? subtitle.episode_number ?? subtitle.episode?.episodeNumber) || undefined;
      const seasonNumber = declaredSeason ?? parsed.season;
      const episodeNumber = declaredEpisode ?? parsed.episode;
      if (context.media.type === "series") {
        if (episodeNumber !== context.media.episode) return null;
        if (seasonNumber != null && seasonNumber !== context.media.season) return null;
      } else if (!movieFilenameMatches(context.extra.filename, fileName)) {
        return null;
      }
      return {
        provider: "arabicsubs",
        fileId: subtitle.id,
        downloadRef: subtitle.downloadUrl || `/subtitles/${subtitle.id}/download`,
        fileName,
        release: subtitle.releaseLabel || fileName,
        uploader: String(subtitle.translator || subtitle.uploader || "").slice(0, 80),
        language: "ar",
        hashMatch: false,
        rating: Number(subtitle.rating) || 0,
        downloadCount: Number(subtitle.downloads) || 0,
        fromTrusted: false,
        hearingImpaired: Boolean(subtitle.hearingImpaired),
        aiTranslated: Boolean(subtitle.aiTranslated),
        machineTranslated: Boolean(subtitle.machineTranslated),
        featureDetails: { seasonNumber, episodeNumber }
      };
    }).filter((candidate) => candidate?.fileId != null);
  }

  async download(ref, { signal } = {}) {
    const response = await safeFetch(new URL(String(ref), this.config.baseUrl).toString(), {
      allowedHosts: HOSTS,
      headers: this.headers(),
      signal,
      timeoutMs: 12000,
      limiter,
      label: "ArabicSubs download",
      maxBytes: 20 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: "subtitle.srt" };
  }
}
