import { parseReleaseName, parseVideoId, titlesLikelyMatch } from "./media.js";

const KITSU_META_BASE = "https://anime-kitsu.strem.fun";
const cache = new Map();
const metadataCache = new Map();
const titleSearchCache = new Map();

function asImdbId(value) {
  const match = String(value || "").match(/^tt(\d+)$/i);
  return match?.[1] || "";
}

function genericVideoId(type, id) {
  const parts = String(id).split(":");
  const numbers = parts.slice(2).map(Number).filter(Number.isInteger);
  const media = { type, id: String(id), sourceId: String(id), imdbId: "" };
  if (type === "series") {
    if (numbers.length >= 2) {
      media.season = numbers.at(-2);
      media.episode = numbers.at(-1);
    } else if (numbers.length === 1) {
      media.season = 1;
      media.episode = numbers[0];
    }
  }
  return media;
}

function selectKitsuVideo(videos, originalId, seasonHint, episodeHint) {
  const exact = videos.find((video) => video.id === originalId);
  if (exact) return exact;
  if (Number.isInteger(seasonHint) && Number.isInteger(episodeHint)) {
    const byImdbOrder = videos.find((video) => Number(video.imdbSeason) === seasonHint && Number(video.imdbEpisode) === episodeHint);
    if (byImdbOrder) return byImdbOrder;
  }
  if (Number.isInteger(episodeHint)) {
    return videos.find((video) => Number(video.absoluteEpisode) === episodeHint)
      || videos.find((video) => Number(video.episode) === episodeHint);
  }
  return null;
}

async function resolveKitsu(type, id, fetchImpl) {
  const match = String(id).match(/^kitsu:(\d+)(?::(\d+))?(?::(\d+))?$/i);
  if (!match) return null;
  const kitsuId = match[1];
  const seasonHint = match[3] ? Number(match[2]) : undefined;
  const episodeHint = Number(match[3] || match[2]) || undefined;
  const response = await fetchImpl(`${KITSU_META_BASE}/meta/${type}/kitsu:${kitsuId}.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`Kitsu metadata failed with HTTP ${response.status}`);
  const payload = await response.json();
  const meta = payload?.meta || {};
  const video = type === "series"
    ? selectKitsuVideo(Array.isArray(meta.videos) ? meta.videos : [], String(id), seasonHint, episodeHint)
    : null;
  const imdbId = asImdbId(video?.imdb_id || meta.imdb_id);
  if (!imdbId) return { ...genericVideoId(type, id), title: meta.name || "" };
  if (type === "movie") {
    return { type, id: `tt${imdbId}`, sourceId: String(id), imdbId, title: meta.name || "" };
  }
  const season = Number(video?.imdbSeason ?? seasonHint ?? 1);
  const episode = Number(video?.imdbEpisode ?? video?.episode ?? episodeHint);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) {
    return { ...genericVideoId(type, id), imdbId, title: meta.name || "" };
  }
  const absoluteEpisode = Number(video?.absoluteEpisode ?? (seasonHint == null ? episodeHint : undefined));
  return {
    type,
    id: `tt${imdbId}:${season}:${episode}`,
    sourceId: String(id),
    imdbId,
    season,
    episode,
    ...(Number.isInteger(absoluteEpisode) && absoluteEpisode > 0 ? { absoluteEpisode } : {}),
    title: meta.name || ""
  };
}

// Absolute episode number from Cinemeta's episode list (specials excluded),
// used to match anime files numbered "Title - 1085".
export function absoluteEpisodeFromVideos(videos, season, episode) {
  if (!Array.isArray(videos) || !Number.isInteger(season) || !Number.isInteger(episode) || season < 1) return undefined;
  const regular = videos
    .filter((video) => Number(video.season) >= 1 && Number(video.episode ?? video.number) >= 1)
    .map((video) => ({ season: Number(video.season), episode: Number(video.episode ?? video.number) }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const index = regular.findIndex((video) => video.season === season && video.episode === episode);
  return index >= 0 ? index + 1 : undefined;
}

// Fallback when the Kitsu add-on is unreachable (it does not always answer
// requests from cloud hosts): ARM maps a Kitsu id to IMDb and the TVDB season.
async function resolveKitsuWithArm(type, id, fetchImpl) {
  const match = String(id).match(/^kitsu:(\d+)(?::(\d+))?(?::(\d+))?$/i);
  if (!match) return null;
  const response = await fetchImpl(`https://arm.haglund.dev/api/v2/ids?source=kitsu&id=${match[1]}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) return null;
  const row = await response.json();
  const imdbId = asImdbId(row?.imdb);
  if (!imdbId) return null;
  if (type === "movie") return { type, id: `tt${imdbId}`, sourceId: String(id), imdbId, title: "" };
  const episode = Number(match[3] || match[2]);
  const season = Number(row["thetvdb-season"] ?? row["themoviedb-season"] ?? 1) || 1;
  if (!Number.isInteger(episode)) return null;
  return {
    type,
    id: `tt${imdbId}:${season}:${episode}`,
    sourceId: String(id),
    imdbId,
    season,
    episode,
    absoluteEpisode: episode,
    title: "",
    mappedBy: "arm"
  };
}

// Romaji and English titles straight from the Kitsu API. Anime subtitles are
// usually named by the romaji title, so both are used for matching.
async function kitsuTitles(id, fetchImpl) {
  const kitsuId = String(id).match(/^kitsu:(\d+)/i)?.[1];
  if (!kitsuId) return {};
  const response = await fetchImpl(`https://kitsu.app/api/edge/anime/${kitsuId}`, {
    headers: { Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) return {};
  const attributes = (await response.json())?.data?.attributes || {};
  const romaji = String(attributes.titles?.en_jp || attributes.canonicalTitle || "").slice(0, 200);
  const english = String(attributes.titles?.en || "").slice(0, 200);
  return { romaji, english: english !== romaji ? english : "" };
}

export async function resolveVideoId(type, id, options = {}) {
  if (/^tt\d+(?::\d+:\d+)?$/i.test(String(id))) return parseVideoId(type, id);
  const key = `${type}:${id}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.value.imdbId ? 24 * 60 * 60 * 1000 : 60 * 1000)) return cached.value;
  let value;
  const fetchImpl = options.fetchImpl || fetch;
  if (/^kitsu:/i.test(String(id))) {
    // All three lookups run in parallel with short timeouts: waiting for one
    // after another used most of the listing deadline on Render, leaving no
    // time to search the subtitle providers.
    const [addon, arm, titles] = await Promise.allSettled([
      resolveKitsu(type, id, fetchImpl),
      resolveKitsuWithArm(type, id, fetchImpl),
      kitsuTitles(id, fetchImpl)
    ]);
    const fromAddon = addon.status === "fulfilled" ? addon.value : null;
    const fromArm = arm.status === "fulfilled" ? arm.value : null;
    const names = titles.status === "fulfilled" ? titles.value : {};
    value = fromAddon?.imdbId ? fromAddon : fromArm || fromAddon || genericVideoId(type, id);
    const romaji = names.romaji || value.title || "";
    value = {
      ...value,
      ...(romaji ? { title: romaji } : {}),
      ...(names.english && !value.catalogTitle ? { catalogTitle: names.english } : {})
    };
  } else {
    value = genericVideoId(type, id);
  }
  // An unresolved identity is retried soon instead of being trusted for a day.
  cache.set(key, { at: Date.now(), value });
  return value;
}

// True when the request names a catalogue (Kitsu) whose IMDb identity could
// not be determined; searching then returns nothing and must never be cached
// as a complete result.
export function identityUnresolved(media) {
  return /^kitsu:/i.test(String(media?.sourceId || media?.id || "")) && !media?.imdbId;
}

async function cinemeta(imdbId, type, fetchImpl) {
  const key = `${type}:${imdbId}`;
  const cached = metadataCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.value;
  const response = await fetchImpl(`https://v3-cinemeta.strem.io/meta/${type}/tt${imdbId}.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`Cinemeta metadata failed with HTTP ${response.status}`);
  const value = (await response.json())?.meta || null;
  metadataCache.set(key, { at: Date.now(), value });
  return value;
}

async function findCinemetaByTitle(type, title, fetchImpl) {
  const key = `${type}:${title}`;
  const cached = titleSearchCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.value;
  const response = await fetchImpl(
    `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(title)}.json`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3000) }
  );
  if (!response.ok) throw new Error(`Cinemeta title search failed with HTTP ${response.status}`);
  const metas = (await response.json())?.metas;
  const value = (Array.isArray(metas) ? metas : []).find((candidate) => {
    const imdbId = String(candidate?.id || candidate?.imdb_id || "");
    return /^tt\d+$/i.test(imdbId) && titlesLikelyMatch(title, candidate?.name || "");
  }) || null;
  titleSearchCache.set(key, { at: Date.now(), value });
  return value;
}

// The filename-only part of alignMediaToFilename(): no network, so a cached
// listing can answer with it at once while the full check runs later.
export function alignMediaLocally(media, extra) {
  if (!extra?.filename) return media;
  const parsed = parseReleaseName(extra.filename);
  let aligned = { ...media, releaseTitle: parsed.title };
  if (media.type === "series" && Number.isInteger(parsed.episode) && parsed.episode !== media.episode) {
    aligned = {
      ...aligned,
      catalogSeason: media.season,
      catalogEpisode: media.episode,
      season: parsed.season ?? media.season ?? 1,
      episode: parsed.episode,
      numberingAdjusted: true
    };
    if (aligned.imdbId) aligned.id = `tt${aligned.imdbId}:${aligned.season}:${aligned.episode}`;
  }
  return aligned;
}

export async function alignMediaToFilename(media, extra, options = {}) {
  if (!extra?.filename) {
    // Stremio often sends no filename (debrid/HTTP streams). Still learn the
    // catalogue title and absolute episode so subtitles can be matched by
    // title instead of being ranked blind.
    if (!media.imdbId || (media.catalogTitle && media.absoluteEpisode != null)) return media;
    const meta = await cinemeta(media.imdbId, media.type, options.fetchImpl || fetch).catch(() => null);
    if (!meta) return media;
    const absolute = media.type === "series" && media.absoluteEpisode == null
      ? absoluteEpisodeFromVideos(meta.videos, media.season, media.episode)
      : undefined;
    return { ...media, catalogTitle: meta.name || media.catalogTitle || "", ...(absolute ? { absoluteEpisode: absolute } : {}) };
  }
  const parsed = parseReleaseName(extra.filename);
  let aligned = alignMediaLocally(media, extra);
  if (!aligned.imdbId || !parsed.title) return aligned;
  const fetchImpl = options.fetchImpl || fetch;
  // Run both checks together. Relying on the original catalogue lookup first
  // allowed a transient timeout to keep a known-wrong IMDb id (and therefore
  // return subtitles for the wrong show).
  const [metaResult, titleResult] = await Promise.allSettled([
    cinemeta(aligned.imdbId, aligned.type, fetchImpl),
    findCinemetaByTitle(aligned.type, parsed.title, fetchImpl)
  ]);
  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const replacement = titleResult.status === "fulfilled" ? titleResult.value : null;
  aligned.catalogTitle = meta?.name || aligned.title || "";
  if (aligned.type === "series") {
    if (aligned.numberingAdjusted && parsed.season == null) {
      // "Title - 105" may be the absolute number of the requested S05E03,
      // not episode 105 of season 1. Undo the renumbering in that case.
      const catalogAbsolute = absoluteEpisodeFromVideos(meta?.videos, aligned.catalogSeason, aligned.catalogEpisode);
      if (catalogAbsolute && catalogAbsolute === parsed.episode) {
        aligned = {
          ...aligned,
          season: aligned.catalogSeason,
          episode: aligned.catalogEpisode,
          absoluteEpisode: catalogAbsolute,
          numberingAdjusted: false,
          id: `tt${aligned.imdbId}:${aligned.catalogSeason}:${aligned.catalogEpisode}`
        };
      }
    }
    if (aligned.absoluteEpisode == null) {
      const absolute = absoluteEpisodeFromVideos(meta?.videos, aligned.season, aligned.episode);
      if (absolute) aligned.absoluteEpisode = absolute;
    }
  }
  const originalTitleMatches = Boolean(aligned.catalogTitle && titlesLikelyMatch(extra.filename, aligned.catalogTitle));
  const replacementImdbId = asImdbId(replacement?.id || replacement?.imdb_id);
  if (!originalTitleMatches && replacementImdbId) {
    const originalImdbId = aligned.imdbId;
    aligned = {
      ...aligned,
      catalogImdbId: originalImdbId,
      catalogTitle: replacement.name || parsed.title,
      imdbId: replacementImdbId,
      id: aligned.type === "series"
        ? `tt${replacementImdbId}:${aligned.season}:${aligned.episode}`
        : `tt${replacementImdbId}`,
      identityCorrected: replacementImdbId !== originalImdbId,
      identityMismatch: false
    };
  } else if (meta && !originalTitleMatches) {
    aligned = {
      ...aligned,
      catalogImdbId: aligned.imdbId,
      imdbId: "",
      id: aligned.sourceId || media.id,
      identityMismatch: true
    };
  }
  return aligned;
}
