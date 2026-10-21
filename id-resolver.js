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
    signal: AbortSignal.timeout(5000)
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

export async function resolveVideoId(type, id, options = {}) {
  if (/^tt\d+(?::\d+:\d+)?$/i.test(String(id))) return parseVideoId(type, id);
  const key = `${type}:${id}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.value;
  let value;
  if (/^kitsu:/i.test(String(id))) {
    try {
      value = await resolveKitsu(type, id, options.fetchImpl || fetch);
    } catch {
      value = genericVideoId(type, id);
    }
  } else {
    value = genericVideoId(type, id);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
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

export async function alignMediaToFilename(media, extra, options = {}) {
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
