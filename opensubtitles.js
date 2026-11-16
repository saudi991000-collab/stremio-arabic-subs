import { normalizeName, parseReleaseName } from "../media.js";
import { HttpError, limiterFor, safeFetch } from "../http.js";

const API_HOSTS = ["api.opensubtitles.com"];
const DOWNLOAD_HOSTS = ["opensubtitles.com", "opensubtitles.org"];
// OpenSubtitles allows about 5 requests per second per consumer; stay below.
const limiter = limiterFor("opensubtitles", { minIntervalMs: 220, concurrency: 3 });

function mapResults(payload) {
  const results = [];
  for (const row of payload?.data || []) {
    const attributes = row.attributes || {};
    for (const file of attributes.files || []) {
      results.push({
        provider: "opensubtitles",
        fileId: Number(file.file_id),
        downloadRef: Number(file.file_id),
        fileName: file.file_name || attributes.release || "subtitle.srt",
        fileSize: Number(file.file_size || attributes.file_size) || undefined,
        release: attributes.release || "",
        comment: String(attributes.comments || "").slice(0, 300),
        uploader: String(attributes.uploader?.name || "").slice(0, 80),
        language: attributes.language || "ar",
        hashMatch: Boolean(attributes.moviehash_match),
        fps: Number(attributes.fps) || undefined,
        rating: Number(attributes.ratings) || 0,
        downloadCount: Number(attributes.download_count) || 0,
        fromTrusted: Boolean(attributes.from_trusted),
        hearingImpaired: Boolean(attributes.hearing_impaired),
        aiTranslated: Boolean(attributes.ai_translated),
        machineTranslated: Boolean(attributes.machine_translated),
        featureDetails: {
          year: attributes.feature_details?.year,
          seasonNumber: attributes.feature_details?.season_number,
          episodeNumber: attributes.feature_details?.episode_number
        }
      });
    }
  }
  return results.filter((item) => Number.isInteger(item.fileId) && item.fileId > 0);
}

function scopedParams(context, language) {
  const params = {
    languages: language,
    order_by: "download_count",
    type: context.media.type === "series" ? "episode" : "movie"
  };
  if (context.media.type === "series" && context.media.imdbId) {
    // A Stremio series id is the parent show's IMDb id. OpenSubtitles expects
    // parent_imdb_id when season/episode are supplied; imdb_id means a specific
    // episode and silently returns no results for many shows.
    params.parent_imdb_id = context.media.imdbId;
    params.season_number = String(context.media.season);
    params.episode_number = String(context.media.episode);
  } else if (context.media.imdbId) {
    params.imdb_id = context.media.imdbId;
  }
  return params;
}

function filenameQuery(context) {
  const query = String(context.extra.filename || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .trim()
    .slice(0, 180);
  return query.length >= 3 ? query.toLowerCase() : "";
}

export function referenceReleaseScore(candidate, context) {
  const wanted = parseReleaseName(context.extra.filename || "");
  const actual = parseReleaseName(candidate.fileName || candidate.release || "");
  const wantedName = normalizeName(context.extra.filename || "");
  const actualName = normalizeName(candidate.fileName || candidate.release || "");
  let score = wantedName && actualName && wantedName === actualName ? 200 : 0;
  if (wanted.source && actual.source) {
    if (wanted.source === actual.source) score += 55;
    else if ([wanted.source, actual.source].every((value) => value === "remux" || value === "bluray")) score += 45;
  }
  if (wanted.platform && wanted.platform === actual.platform) score += 80;
  if (wanted.group && wanted.group === actual.group) score += 70;
  if (wanted.fps && candidate.fps && Math.abs(wanted.fps - candidate.fps) < 0.02) score += 65;
  if (wanted.edition && wanted.edition === actual.edition) score += 30;
  if (wanted.resolution && wanted.resolution === actual.resolution) score += 8;
  return score;
}

export class OpenSubtitlesProvider {
  constructor(config) {
    this.id = "opensubtitles";
    this.config = config;
    this.token = "";
    this.loginAttempted = false;
    this.loginPromise = null;
  }

  headers(extra = {}) {
    return {
      "Api-Key": this.config.apiKey,
      "User-Agent": this.config.userAgent,
      Accept: "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra
    };
  }

  async request(url, options = {}) {
    try {
      return await safeFetch(url, {
        ...options,
        allowedHosts: API_HOSTS,
        headers: this.headers(options.headers),
        timeoutMs: options.timeoutMs || 8000,
        limiter,
        retries: options.retries ?? 1,
        label: "OpenSubtitles request",
        maxBytes: 4 * 1024 * 1024
      });
    } catch (error) {
      // 406 is how /download reports "You have downloaded your allowed N
      // subtitles for 24h". It is a temporary quota, never a bad file.
      if (error instanceof HttpError && (error.status === 429 || error.status === 406)) {
        throw new HttpError("OpenSubtitles download or request quota has been reached", { status: error.status, rateLimited: true, retryable: false });
      }
      if (error instanceof HttpError && error.status) throw new HttpError(`OpenSubtitles request failed with HTTP ${error.status}`, { status: error.status });
      throw error;
    }
  }

  async login() {
    if (!this.config.username || !this.config.password) return;
    const response = await this.request(`${this.config.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
      retries: 0
    });
    this.token = response.json()?.token || "";
  }

  async ensureLogin() {
    if (this.token) return;
    if (this.loginPromise) {
      await this.loginPromise;
      return;
    }
    if (this.loginAttempted || !this.config.username || !this.config.password) return;
    this.loginAttempted = true;
    this.loginPromise = this.login().catch(() => null).finally(() => {
      this.loginPromise = null;
    });
    await this.loginPromise;
  }

  async searchPage(params, page, signal) {
    const query = new URLSearchParams({ ...params, page: String(page) });
    const response = await this.request(`${this.config.baseUrl}/subtitles?${query}`, { signal });
    return response.json();
  }

  async searchAllPages(params, maxPages, signal, extra = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const payload = await this.searchPage(params, page, signal);
      all.push(...mapResults(payload).map((item) => ({ ...item, ...extra })));
      const totalPages = Number(
        payload?.total_pages ??
        payload?.pagination?.total_pages ??
        (payload?.total_count && payload?.per_page ? Math.ceil(payload.total_count / payload.per_page) : 1)
      );
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    }
    return all;
  }

  async search(context, maxPages = 2, { signal } = {}) {
    if (!this.config.apiKey) throw new Error("OPENSUBTITLES_API_KEY is missing");
    const common = scopedParams(context, "ar");
    const query = filenameQuery(context);
    const scoped = { catalogMatch: Boolean(context.media.imdbId), episodeScoped: context.media.type === "series" };
    const jobs = [];
    if (context.extra.videoHash) {
      jobs.push(this.searchAllPages({
        ...common,
        moviehash: context.extra.videoHash,
        ...(context.extra.videoSize ? { moviebytesize: String(context.extra.videoSize) } : {}),
        ...(query ? { query } : {})
      }, 1, signal, scoped));
    }
    if (context.media.imdbId) jobs.push(this.searchAllPages(common, maxPages, signal, scoped));
    // New episodes are often searchable by their release filename before the
    // provider has attached them to the parent IMDb entry. Always merge one
    // filename search instead of using it only when the IMDb search is empty.
    if (query) {
      const fallback = {
        languages: "ar",
        order_by: "download_count",
        type: context.media.type === "series" ? "episode" : "movie",
        query
      };
      if (context.media.type === "series") {
        fallback.season_number = String(context.media.season);
        fallback.episode_number = String(context.media.episode);
      }
      jobs.push(this.searchAllPages(fallback, 1, signal, { catalogMatch: false, episodeScoped: false }));
    }
    // The searches are independent; run them together so the provider fits
    // inside the listing deadline. A failed sub-search does not discard the
    // others, but if every sub-search failed the provider reports an error.
    const settled = await Promise.allSettled(jobs);
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    if (!fulfilled.length && settled.length) throw settled[0].reason;
    const unique = new Map();
    for (const item of fulfilled.flatMap((result) => result.value)) {
      const existing = unique.get(item.fileId);
      // Keep the most informative copy (hash match / catalogue scoped first).
      if (!existing || (item.hashMatch && !existing.hashMatch) || (item.catalogMatch && !existing.catalogMatch && !existing.hashMatch)) unique.set(item.fileId, item);
    }
    return [...unique.values()];
  }

  async findTimingReference(context, { signal } = {}) {
    if (!this.config.apiKey || !context.media.imdbId) return null;
    const common = scopedParams(context, "en");
    const query = filenameQuery(context);
    if (context.extra.videoHash) {
      const payload = await this.searchPage({
        ...common,
        moviehash: context.extra.videoHash,
        ...(context.extra.videoSize ? { moviebytesize: String(context.extra.videoSize) } : {}),
        ...(query ? { query } : {})
      }, 1, signal);
      const exact = mapResults(payload)
        .filter((candidate) => candidate.hashMatch)
        .sort((a, b) => b.rating - a.rating || b.downloadCount - a.downloadCount)[0];
      if (exact) return { ...exact, provider: this.id, timingReferenceKind: "exact-hash" };
    }
    const payload = await this.searchPage(common, 1, signal);
    const releaseMatched = mapResults(payload)
      .map((candidate) => ({ candidate, score: referenceReleaseScore(candidate, context) }))
      .filter((item) => item.score >= 45)
      .sort((a, b) => b.score - a.score || b.candidate.rating - a.candidate.rating || b.candidate.downloadCount - a.candidate.downloadCount)[0];
    return releaseMatched
      ? { ...releaseMatched.candidate, provider: this.id, timingReferenceKind: "release", timingReferenceReleaseScore: releaseMatched.score }
      : null;
  }

  // True while the daily download quota is used up. Listings hide this
  // provider's results meanwhile, because every download would fail.
  isQuotaExhausted() {
    return Date.now() < (this.quotaUntil || 0);
  }

  async getDownloadLink(fileId, signal) {
    if (this.isQuotaExhausted()) {
      throw new HttpError("OpenSubtitles download or request quota has been reached", { status: 406, rateLimited: true });
    }
    // Authenticate before the first download whenever account credentials are
    // configured. Waiting for a 401 kept paid/VIP accounts on the anonymous
    // quota because quota exhaustion is normally reported as 429 instead.
    await this.ensureLogin();
    const perform = () => this.request(`${this.config.baseUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal,
      retries: 0
    });
    let response;
    try {
      response = await perform();
    } catch (error) {
      if (!this.token && this.config.username && this.config.password && /HTTP 401/.test(error.message)) {
        await this.login();
        response = await perform();
      } else {
        if (error?.rateLimited) {
          // OpenSubtitles resets quotas at 00:00 UTC. Pause until then (at
          // most 24 h), then try again.
          const now = new Date();
          const nextReset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
          this.quotaUntil = Math.min(nextReset, Date.now() + 24 * 3600 * 1000);
        }
        throw error;
      }
    }
    const payload = response.json();
    if (!payload?.link) throw new Error("Provider returned no download URL");
    if (Number(payload.remaining) <= 0) {
      const now = new Date();
      this.quotaUntil = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    }
    return { url: payload.link, fileName: payload.file_name || "subtitle.srt" };
  }

  async download(fileId, { signal } = {}) {
    const { url, fileName } = await this.getDownloadLink(fileId, signal);
    const response = await safeFetch(url, {
      allowedHosts: DOWNLOAD_HOSTS,
      signal,
      timeoutMs: 12000,
      label: "Subtitle download",
      maxBytes: 20 * 1024 * 1024
    }).catch((error) => {
      if (/Blocked host/.test(error.message)) throw new Error("Provider returned an unsafe download URL");
      throw error;
    });
    return { buffer: response.buffer, fileName };
  }
}
