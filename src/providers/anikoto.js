import { parseReleaseName, titlesLikelyMatch } from "../media.js";
import { limiterFor, safeFetch } from "../http.js";

const DEFAULT_BASE = "https://watch.reyamika.eu.cc";
const ANILIST_API = "https://graphql.anilist.co";
// ARM ("anime relations mapping") maps IMDb/Kitsu ids to AniList ids. It
// replaced the AniList GraphQL search, which has been returning HTTP 403
// ("temporarily disabled") since 2026.
const ARM_API = "https://arm.haglund.dev/api/v2";
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const limiter = limiterFor("anikoto", { minIntervalMs: 250, concurrency: 2 });

function titleFor(context) {
  return context.media.releaseTitle
    || context.media.catalogTitle
    || context.media.title
    || parseReleaseName(context.extra.filename || "").title
    || "";
}

function cleanHeaders(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const key of ["User-Agent", "Referer", "Origin"]) {
    const item = String(source[key] || "");
    if (item && item.length <= 512 && !/[\r\n]/.test(item)) result[key] = item;
  }
  return result;
}

function safeSubtitleUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return false;
    if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) return false;
    return !url.hostname.includes(":") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function namesOf(media) {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native].filter(Boolean);
}

export class AniKotoProvider {
  constructor(config = {}) {
    this.id = "anikoto";
    this.config = { baseUrl: DEFAULT_BASE, ...config };
    this.mapping = new Map();
  }

  async json(url, { signal, timeoutMs = 6000, hosts, method, body, headers } = {}) {
    const response = await safeFetch(url, {
      allowedHosts: hosts,
      method,
      body,
      headers: { Accept: "application/json", ...headers },
      signal,
      timeoutMs,
      limiter,
      label: "AniKoto request",
      maxBytes: 4 * 1024 * 1024,
      okStatuses: [400, 403, 404]
    });
    return response.status === 200 ? response.json() : null;
  }

  async resolveTitle(context, signal) {
    const direct = titleFor(context);
    if (direct) return direct;
    if (!context.media.imdbId) return "";
    const payload = await this.json(`${CINEMETA_BASE}/meta/series/tt${context.media.imdbId}.json`, { signal, hosts: ["strem.io"], timeoutMs: 3500 }).catch(() => null);
    return payload?.meta?.name || "";
  }

  async armAnilistId(context, signal) {
    let rows = null;
    const kitsu = String(context.media.sourceId || "").match(/^kitsu:(\d+)/i)?.[1];
    if (kitsu) {
      const row = await this.json(`${ARM_API}/ids?source=kitsu&id=${kitsu}`, { signal, hosts: ["arm.haglund.dev"], timeoutMs: 3500 }).catch(() => null);
      rows = row ? [row] : null;
    }
    if (!rows && context.media.imdbId) {
      const imdb = `tt${String(context.media.imdbId).padStart(7, "0")}`;
      const payload = await this.json(`${ARM_API}/imdb?id=${imdb}`, { signal, hosts: ["arm.haglund.dev"], timeoutMs: 3500 }).catch(() => null);
      rows = Array.isArray(payload) ? payload : null;
    }
    if (!rows?.length) return null;
    const season = Number(context.media.season) || 1;
    const tv = rows.filter((row) => row?.anilist && (!row.media || /tv|ona/i.test(row.media)));
    const bySeason = tv.find((row) => Number(row["thetvdb-season"] ?? row["themoviedb-season"]) === season);
    return (bySeason || (season === 1 ? tv[0] : null))?.anilist || null;
  }

  async anilistId(title, season, context = { media: {} }, signal) {
    const key = `${context.media.imdbId || ""}:${title}:${season || 1}`.toLowerCase();
    if (this.mapping.has(key)) return this.mapping.get(key);
    let id = await this.armAnilistId(context, signal).catch(() => null);
    if (!id) {
      const search = Number(season) > 1 ? `${title} Season ${season}` : title;
      const query = `query ($search: String) { Media(search: $search, type: ANIME) { id title { romaji english native } } }`;
      const payload = await this.json(ANILIST_API, {
        signal,
        hosts: ["graphql.anilist.co"],
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { search } }),
        timeoutMs: 4500
      }).catch(() => null);
      const media = payload?.data?.Media;
      if (media?.id && namesOf(media).some((name) => titlesLikelyMatch(title, name))) id = media.id;
    }
    if (id) this.mapping.set(key, id);
    return id || null;
  }

  async search(context, _maxPages, { signal } = {}) {
    if (context.media.type !== "series" || !Number.isInteger(Number(context.media.episode))) return [];
    const title = await this.resolveTitle(context, signal);
    if (!title) return [];
    const anilistId = await this.anilistId(title, context.media.season, context, signal);
    if (!anilistId) return [];
    const episode = Number(context.media.episode);
    const base = new URL(this.config.baseUrl);
    const hosts = [base.hostname];
    const catalog = await this.json(`${this.config.baseUrl}/episodes/anikoto/${anilistId}?map=true`, { signal, hosts, timeoutMs: 7000 });
    const row = (catalog?.episodes?.sub || []).find((item) => Number(item.number) === episode);
    if (!row?.id || !/^\/?watch\/[a-z0-9/_-]+$/i.test(String(row.id))) return [];
    const payload = await this.json(`${this.config.baseUrl}/${String(row.id).replace(/^\//, "")}`, { signal, hosts, timeoutMs: 9000 });
    const seen = new Set();
    const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
    return subtitles.filter((subtitle) => {
      const arabic = /arabic|العربية/i.test(String(subtitle.label || "")) || /\/ara[-_.]/i.test(String(subtitle.url || ""));
      if (!arabic || !safeSubtitleUrl(subtitle.url) || seen.has(subtitle.url)) return false;
      seen.add(subtitle.url);
      return true;
    }).map((subtitle, index) => {
      const ref = JSON.stringify({ url: subtitle.url, headers: cleanHeaders(subtitle.headers || payload.headers) });
      const fileName = `${title.replace(/\s+/g, ".")}.S${String(context.media.season || 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}.AniKoto.${index + 1}.vtt`;
      return {
        provider: "anikoto",
        fileId: `${anilistId}:${episode}:${index}`,
        downloadRef: ref,
        fileName,
        release: fileName,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: true,
        rating: 1,
        downloadCount: 0,
        fromTrusted: false,
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        featureDetails: { seasonNumber: Number(context.media.season) || 1, episodeNumber: episode }
      };
    });
  }

  async download(ref, { signal } = {}) {
    let payload;
    try { payload = JSON.parse(String(ref)); }
    catch { throw new Error("Invalid AniKoto subtitle reference"); }
    if (!safeSubtitleUrl(payload.url)) throw new Error("Blocked AniKoto subtitle URL");
    // Third-party CDN host: allowed only after DNS confirms it is public.
    const response = await safeFetch(payload.url, {
      allowedHosts: ["public"],
      headers: cleanHeaders(payload.headers),
      signal,
      timeoutMs: 12000,
      limiter,
      label: "AniKoto subtitle download",
      maxBytes: 8 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: "anikoto-arabic.vtt" };
  }
}
