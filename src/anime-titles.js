import { limiterFor, safeFetch } from "./http.js";

// Arabic anime fansub sites list shows by their Japanese (romaji) names, e.g.
// "Sousou no Frieren 2nd Season" or "Code Geass: Hangyaku no Lelouch", while
// Stremio gives the English name. This finds every name of the right season:
// ARM maps IMDb/Kitsu ids to AniList/Kitsu ids per season, then AniList (or
// Kitsu as a fallback) gives the romaji, English and alternative titles.

const ARM_API = "https://arm.haglund.dev/api/v2";
const ANILIST_API = "https://graphql.anilist.co";
const KITSU_API = "https://kitsu.app/api/edge";
const limiter = limiterFor("anime-titles", { minIntervalMs: 150, concurrency: 3 });
const TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

async function getJson(url, { signal, hosts, method, body, timeoutMs = 4000 } = {}) {
  const response = await safeFetch(url, {
    allowedHosts: hosts,
    method,
    body,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    signal,
    timeoutMs,
    limiter,
    label: "Anime titles",
    maxBytes: 2 * 1024 * 1024,
    okStatuses: [400, 403, 404, 429]
  });
  return response.status === 200 ? response.json() : null;
}

// Latin-script names only: the sites are searched with them.
function latin(name) {
  const value = String(name || "").replace(/[`’]/g, "'").replace(/\s+/g, " ").trim();
  return value.length >= 2 && /^[\x20-\x7eÀ-ɏ‐-―]+$/.test(value) ? value : "";
}

export function pickArmRow(rows, season) {
  const tv = (Array.isArray(rows) ? rows : []).filter((row) => row && (!row.media || /tv|ona/i.test(row.media)));
  const wanted = Number(season) || 1;
  const bySeason = tv.find((row) => Number(row["thetvdb-season"] ?? row["themoviedb-season"]) === wanted);
  return bySeason || (wanted === 1 ? tv[0] : null) || null;
}

async function armRow(media, signal) {
  const kitsu = String(media.sourceId || "").match(/^kitsu:(\d+)/i)?.[1];
  if (kitsu) {
    const row = await getJson(`${ARM_API}/ids?source=kitsu&id=${kitsu}`, { signal, hosts: ["arm.haglund.dev"] }).catch(() => null);
    if (row) return row;
  }
  if (!media.imdbId) return null;
  const imdb = `tt${String(media.imdbId).replace(/^tt/, "").padStart(7, "0")}`;
  const rows = await getJson(`${ARM_API}/imdb?id=${imdb}`, { signal, hosts: ["arm.haglund.dev"] }).catch(() => null);
  return pickArmRow(rows, media.type === "series" ? media.season : 1);
}

async function anilistNames(id, signal) {
  const query = "query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english } synonyms } }";
  const payload = await getJson(ANILIST_API, {
    signal,
    hosts: ["graphql.anilist.co"],
    method: "POST",
    body: JSON.stringify({ query, variables: { id: Number(id) } })
  }).catch(() => null);
  const media = payload?.data?.Media;
  return media ? [media.title?.romaji, media.title?.english, ...(media.synonyms || [])] : [];
}

async function kitsuNames(id, signal) {
  const payload = await getJson(`${KITSU_API}/anime/${Number(id)}?fields[anime]=titles,canonicalTitle,abbreviatedTitles`, { signal, hosts: ["kitsu.app"] }).catch(() => null);
  const attributes = payload?.data?.attributes;
  if (!attributes) return [];
  return [attributes.titles?.en_jp, attributes.canonicalTitle, attributes.titles?.en, ...(attributes.abbreviatedTitles || [])];
}

// Returns { anilistId, kitsuId, names: [romaji first, then English, others] }.
export async function animeNames(media = {}, { signal } = {}) {
  const key = `${media.imdbId || media.sourceId || ""}:${media.type === "series" ? Number(media.season) || 1 : 0}`;
  if (key.startsWith(":")) return { names: [] };
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    const row = await armRow(media, signal);
    if (!row) return { names: [] };
    let names = row.anilist ? await anilistNames(row.anilist, signal) : [];
    if (!names.filter(latin).length && row.kitsu) names = await kitsuNames(row.kitsu, signal);
    const seen = new Set();
    const clean = names.map(latin).filter((name) => {
      const id = name.toLowerCase();
      if (!name || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return { anilistId: row.anilist || null, kitsuId: row.kitsu || null, names: clean.slice(0, 6) };
  })().catch(() => ({ names: [] }));
  inflight.set(key, work);
  try {
    const value = await work;
    // Failures are retried sooner than successes.
    cache.set(key, { value, until: Date.now() + (value.names.length ? TTL_MS : 10 * 60 * 1000) });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    inflight.delete(key);
  }
}
