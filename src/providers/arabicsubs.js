import { normalizeName, parseReleaseName } from "../media.js";

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

function allowedUrl(value) {
  const url = new URL(value, "https://arabicsubs.com");
  return url.protocol === "https:" && (url.hostname === "arabicsubs.com" || url.hostname.endsWith(".arabicsubs.com"));
}

export class ArabicSubsProvider {
  constructor(config) {
    this.id = "arabicsubs";
    this.config = config;
  }

  headers() {
    return { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" };
  }

  async search(context) {
    if (!context.extra.filename) return [];
    const query = new URLSearchParams({ filename: context.extra.filename, limit: "25" });
    const response = await fetch(`${this.config.baseUrl}/subtitles/match?${query}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(12000)
    });
    if (response.status === 429) throw new Error("ArabicSubs request quota has been reached");
    if (!response.ok) throw new Error(`ArabicSubs search failed with HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.matches || []).map((subtitle) => {
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

  async download(ref) {
    let current = new URL(String(ref), this.config.baseUrl).toString();
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedUrl(current)) throw new Error("Blocked ArabicSubs redirect host");
      const response = await fetch(current, { headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`ArabicSubs download failed with HTTP ${response.status}`);
      const size = Number(response.headers.get("content-length"));
      if (size > 20 * 1024 * 1024) throw new Error("ArabicSubs subtitle download is too large");
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName: "subtitle.srt" };
    }
    throw new Error("Too many ArabicSubs redirects");
  }
}
