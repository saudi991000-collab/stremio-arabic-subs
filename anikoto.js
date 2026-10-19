import { parseReleaseName, titlesLikelyMatch } from "../media.js";

const DEFAULT_BASE = "https://watch.reyamika.eu.cc";
const ANILIST_API = "https://graphql.anilist.co";
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";

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
    if (item && item.length <= 512) result[key] = item;
  }
  return result;
}

function safeSubtitleUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || !/\/subtitles\//i.test(url.pathname)) return false;
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

  async resolveTitle(context) {
    const direct = titleFor(context);
    if (direct) return direct;
    if (!context.media.imdbId) return "";
    const response = await fetch(`${CINEMETA_BASE}/meta/series/tt${context.media.imdbId}.json`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) return "";
    return (await response.json())?.meta?.name || "";
  }

  async anilistId(title, season) {
    const key = `${title}:${season || 1}`.toLowerCase();
    if (this.mapping.has(key)) return this.mapping.get(key);
    const search = Number(season) > 1 ? `${title} Season ${season}` : title;
    const query = `query ($search: String) { Media(search: $search, type: ANIME) { id title { romaji english native } } }`;
    const response = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { search } }),
      signal: AbortSignal.timeout(4500)
    });
    if (!response.ok) return null;
    const media = (await response.json())?.data?.Media;
    if (!media?.id || !namesOf(media).some((name) => titlesLikelyMatch(title, name))) return null;
    this.mapping.set(key, media.id);
    return media.id;
  }

  async search(context) {
    if (context.media.type !== "series" || !Number.isInteger(Number(context.media.episode))) return [];
    const title = await this.resolveTitle(context);
    if (!title) return [];
    const anilistId = await this.anilistId(title, context.media.season);
    if (!anilistId) return [];
    const episode = Number(context.media.episode);
    const catalogResponse = await fetch(`${this.config.baseUrl}/episodes/anikoto/${anilistId}?map=true`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000)
    });
    if (!catalogResponse.ok) return [];
    const catalog = await catalogResponse.json();
    const row = (catalog?.episodes?.sub || []).find((item) => Number(item.number) === episode);
    if (!row?.id) return [];
    const watchResponse = await fetch(`${this.config.baseUrl}/${String(row.id).replace(/^\//, "")}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000)
    });
    if (!watchResponse.ok) return [];
    const payload = await watchResponse.json();
    const seen = new Set();
    const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
    return subtitles.filter((subtitle) => {
      const Arabic = /arabic|العربية/i.test(String(subtitle.label || "")) || /\/ara[-_.]/i.test(String(subtitle.url || ""));
      if (!Arabic || !safeSubtitleUrl(subtitle.url) || seen.has(subtitle.url)) return false;
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

  async download(ref) {
    let payload;
    try { payload = JSON.parse(String(ref)); }
    catch { throw new Error("Invalid AniKoto subtitle reference"); }
    if (!safeSubtitleUrl(payload.url)) throw new Error("Blocked AniKoto subtitle URL");
    const response = await fetch(payload.url, {
      headers: cleanHeaders(payload.headers),
      redirect: "follow",
      signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(`AniKoto subtitle download failed with HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 8 * 1024 * 1024) throw new Error("AniKoto subtitle is too large");
    return { buffer: Buffer.from(await response.arrayBuffer()), fileName: "anikoto-arabic.vtt" };
  }
}
