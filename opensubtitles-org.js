import { limiterFor, safeFetch } from "../http.js";
import { referenceReleaseScore } from "./opensubtitles.js";

// Legacy OpenSubtitles.org REST search (the API used by many media-player
// plug-ins). It needs no key, supports moviehash matching and exposes the
// "SubAutoTranslation" flag, which identifies machine translations. It is a
// different catalogue view from the opensubtitles.com v1 API, so both are used.
const API_HOSTS = ["rest.opensubtitles.org"];
const DOWNLOAD_HOSTS = ["dl.opensubtitles.org", "opensubtitles.org"];
const limiter = limiterFor("opensubtitles-org", { minIntervalMs: 300, concurrency: 2 });

function segment(name, value) {
  return `${name}-${encodeURIComponent(String(value).toLowerCase()).replace(/%20/g, "+")}`;
}

// Path parameters must be sorted alphabetically or the API ignores the query.
function searchPath(params) {
  return Object.keys(params).sort().map((key) => segment(key, params[key])).join("/");
}

function flag(value) {
  return value === true || value === "1" || value === 1;
}

function mapRow(row, context, extra = {}) {
  const id = String(row?.IDSubtitleFile || "");
  if (!/^\d+$/.test(id) || !row.SubDownloadLink) return null;
  if (String(row.SubLanguageID || "").toLowerCase() !== (extra.language || "ara")) return null;
  if (flag(row.SubForeignPartsOnly)) return null;
  const format = String(row.SubFormat || "srt").toLowerCase().replace(/[^a-z0-9]/g, "") || "srt";
  const fileName = String(row.SubFileName || `${row.MovieReleaseName || id}.${format}`);
  return {
    provider: "opensubtitles-org",
    fileId: id,
    downloadRef: row.SubDownloadLink,
    fileName,
    release: String(row.MovieReleaseName || ""),
    comment: String(row.SubAuthorComment || "").slice(0, 300),
    uploader: String(row.UserNickName || "").slice(0, 80),
    translator: String(row.SubTranslator || "").slice(0, 80),
    language: "ar",
    hashMatch: row.MatchedBy === "moviehash",
    catalogMatch: row.MatchedBy === "imdbid" || row.MatchedBy === "moviehash",
    episodeScoped: context.media.type === "series" && Number(row.SeriesEpisode) === Number(context.media.episode),
    fps: Number(row.MovieFPS) || undefined,
    rating: Number(row.SubRating) || 0,
    downloadCount: Number(row.SubDownloadsCnt) || 0,
    fromTrusted: flag(row.SubFromTrusted),
    hearingImpaired: flag(row.SubHearingImpaired),
    machineTranslated: flag(row.SubAutoTranslation),
    aiTranslated: false,
    flaggedBad: flag(row.SubBad),
    videoDurationMs: Number(row.MovieTimeMS) || undefined,
    featureDetails: {
      year: Number(row.MovieYear) || undefined,
      seasonNumber: Number(row.SeriesSeason) || undefined,
      episodeNumber: Number(row.SeriesEpisode) || undefined
    }
  };
}

export class OpenSubtitlesOrgProvider {
  constructor(config = {}) {
    this.id = "opensubtitles-org";
    this.config = { baseUrl: "https://rest.opensubtitles.org", ...config };
  }

  async query(params, signal) {
    const response = await safeFetch(`${this.config.baseUrl}/search/${searchPath(params)}`, {
      allowedHosts: API_HOSTS,
      headers: { "X-User-Agent": this.config.userAgent, Accept: "application/json" },
      signal,
      timeoutMs: 7000,
      limiter,
      label: "OpenSubtitles.org search",
      maxBytes: 6 * 1024 * 1024
    });
    const payload = response.json();
    return Array.isArray(payload) ? payload : [];
  }

  scope(context, language) {
    const params = { sublanguageid: language };
    // The API canonicalises to a 7-digit id via a redirect to a broken host
    // ("https://_/..."), so always send the padded form.
    if (context.media.imdbId) params.imdbid = String(Number(context.media.imdbId)).padStart(7, "0");
    if (context.media.type === "series") {
      params.season = String(context.media.season);
      params.episode = String(context.media.episode);
    }
    return params;
  }

  async search(context, _maxPages, { signal } = {}) {
    const jobs = [];
    if (context.extra.videoHash && context.extra.videoSize) {
      jobs.push(this.query({ moviebytesize: String(context.extra.videoSize), moviehash: context.extra.videoHash, sublanguageid: "ara" }, signal));
    }
    if (context.media.imdbId) jobs.push(this.query(this.scope(context, "ara"), signal));
    if (!jobs.length) return [];
    const settled = await Promise.allSettled(jobs);
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    if (!fulfilled.length) throw settled[0].reason;
    const unique = new Map();
    for (const row of fulfilled.flatMap((item) => item.value)) {
      const candidate = mapRow(row, context);
      if (!candidate || candidate.flaggedBad) continue;
      if (context.media.type === "series" && candidate.featureDetails.episodeNumber && candidate.featureDetails.episodeNumber !== Number(context.media.episode)) continue;
      const existing = unique.get(candidate.fileId);
      if (!existing || (candidate.hashMatch && !existing.hashMatch)) unique.set(candidate.fileId, candidate);
    }
    return [...unique.values()];
  }

  async findTimingReference(context, { signal } = {}) {
    if (context.extra.videoHash && context.extra.videoSize) {
      const rows = await this.query({ moviebytesize: String(context.extra.videoSize), moviehash: context.extra.videoHash, sublanguageid: "eng" }, signal).catch(() => []);
      const exact = rows.map((row) => mapRow(row, context, { language: "eng" })).filter((item) => item?.hashMatch && !item.machineTranslated)
        .sort((a, b) => b.downloadCount - a.downloadCount)[0];
      if (exact) return { ...exact, language: "en", timingReferenceKind: "exact-hash" };
    }
    if (!context.media.imdbId || !context.extra.filename) return null;
    const rows = await this.query(this.scope(context, "eng"), signal).catch(() => []);
    const best = rows.map((row) => mapRow(row, context, { language: "eng" })).filter((item) => item && !item.machineTranslated)
      .map((candidate) => ({ candidate, score: referenceReleaseScore(candidate, context) }))
      .filter((item) => item.score >= 45)
      .sort((a, b) => b.score - a.score || b.candidate.downloadCount - a.candidate.downloadCount)[0];
    return best ? { ...best.candidate, language: "en", timingReferenceKind: "release", timingReferenceReleaseScore: best.score } : null;
  }

  async download(ref, { signal } = {}) {
    const response = await safeFetch(String(ref), {
      allowedHosts: DOWNLOAD_HOSTS,
      headers: { "X-User-Agent": this.config.userAgent },
      signal,
      timeoutMs: 12000,
      limiter,
      label: "OpenSubtitles.org download",
      maxBytes: 12 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: "subtitle.srt.gz" };
  }
}
