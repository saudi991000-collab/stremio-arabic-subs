import { normalizeName, parseReleaseName } from "../media.js";

const DOWNLOAD_HOSTS = ["opensubtitles.com", "opensubtitles.org"];

function allowedDownloadUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" && DOWNLOAD_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

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

function referenceReleaseScore(candidate, context) {
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
  }

  headers(extra = {}) {
    return {
      "Api-Key": this.config.apiKey,
      "User-Agent": this.config.userAgent,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra
    };
  }

  async request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: this.headers(options.headers), signal: AbortSignal.timeout(12000) });
    if (response.status === 429) throw new Error("OpenSubtitles download or request quota has been reached");
    if (!response.ok) throw new Error(`OpenSubtitles request failed with HTTP ${response.status}`);
    return response;
  }

  async login() {
    if (!this.config.username || !this.config.password) return;
    const response = await this.request(`${this.config.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.config.username, password: this.config.password })
    });
    const payload = await response.json();
    this.token = payload.token || "";
  }

  async searchPage(params, page) {
    const query = new URLSearchParams({ ...params, page: String(page) });
    const response = await this.request(`${this.config.baseUrl}/subtitles?${query}`);
    return response.json();
  }

  async search(context, maxPages = 2) {
    if (!this.config.apiKey) throw new Error("OPENSUBTITLES_API_KEY is missing");
    const common = scopedParams(context, "ar");
    const query = filenameQuery(context);
    const searches = [];
    if (context.extra.videoHash) {
      searches.push({
        ...common,
        moviehash: context.extra.videoHash,
        ...(context.extra.videoSize ? { moviebytesize: String(context.extra.videoSize) } : {}),
        ...(query ? { query } : {})
      });
    }
    if (context.media.imdbId) searches.push(common);

    const all = [];
    for (const params of searches) {
      for (let page = 1; page <= maxPages; page += 1) {
        const payload = await this.searchPage(params, page);
        all.push(...mapResults(payload).map((item) => ({ ...item, catalogMatch: Boolean(context.media.imdbId) })));
        const totalPages = Number(
          payload?.total_pages ??
          payload?.pagination?.total_pages ??
          (payload?.total_count && payload?.per_page ? Math.ceil(payload.total_count / payload.per_page) : 1)
        );
        if (!Number.isFinite(totalPages) || page >= totalPages) break;
      }
    }
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
      const payload = await this.searchPage(fallback, 1);
      all.push(...mapResults(payload).map((item) => ({ ...item, catalogMatch: false })));
    }
    const unique = new Map(all.map((item) => [item.fileId, item]));
    return [...unique.values()];
  }

  async findTimingReference(context) {
    if (!this.config.apiKey || !context.media.imdbId) return null;
    const common = scopedParams(context, "en");
    const query = filenameQuery(context);
    if (context.extra.videoHash) {
      const payload = await this.searchPage({
        ...common,
        moviehash: context.extra.videoHash,
        ...(context.extra.videoSize ? { moviebytesize: String(context.extra.videoSize) } : {}),
        ...(query ? { query } : {})
      }, 1);
      const exact = mapResults(payload)
        .filter((candidate) => candidate.hashMatch)
        .sort((a, b) => b.rating - a.rating || b.downloadCount - a.downloadCount)[0];
      if (exact) return { ...exact, provider: this.id, timingReferenceKind: "exact-hash" };
    }
    const payload = await this.searchPage(common, 1);
    const releaseMatched = mapResults(payload)
      .map((candidate) => ({ candidate, score: referenceReleaseScore(candidate, context) }))
      .filter((item) => item.score >= 45)
      .sort((a, b) => b.score - a.score || b.candidate.rating - a.candidate.rating || b.candidate.downloadCount - a.candidate.downloadCount)[0];
    return releaseMatched
      ? { ...releaseMatched.candidate, provider: this.id, timingReferenceKind: "release", timingReferenceReleaseScore: releaseMatched.score }
      : null;
  }

  async getDownloadLink(fileId) {
    const perform = () => this.request(`${this.config.baseUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId })
    });
    let response;
    try {
      response = await perform();
    } catch (error) {
      if (!this.token && this.config.username && this.config.password && /HTTP 401/.test(error.message)) {
        await this.login();
        response = await perform();
      } else {
        throw error;
      }
    }
    const payload = await response.json();
    if (!payload.link || !allowedDownloadUrl(payload.link)) throw new Error("Provider returned an unsafe download URL");
    return { url: payload.link, fileName: payload.file_name || "subtitle.srt" };
  }

  async download(fileId) {
    const { url, fileName } = await this.getDownloadLink(fileId);
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedDownloadUrl(current)) throw new Error("Blocked subtitle redirect host");
      const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`Subtitle download failed with HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > 20 * 1024 * 1024) throw new Error("Subtitle download is too large");
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName };
    }
    throw new Error("Too many subtitle redirects");
  }
}
