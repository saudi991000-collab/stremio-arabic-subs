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
  if (response.status === 200) return response.json();
  if (response.status === 404) return null;
  // 403/429: busy or blocked right now; not an answer.
  throw new Error(`Anime titles HTTP ${response.status}`);
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

// Throws when ARM cannot be reached (retried later); null = not an anime.
async function armRow(media, signal) {
  const kitsu = String(media.sourceId || "").match(/^kitsu:(\d+)/i)?.[1];
  if (kitsu) {
    const row = await getJson(`${ARM_API}/ids?source=kitsu&id=${kitsu}`, { signal, hosts: ["arm.haglund.dev"], timeoutMs: 6000 });
    if (row) return row;
  }
  if (!media.imdbId) return null;
  const imdb = `tt${String(media.imdbId).replace(/^tt/, "").padStart(7, "0")}`;
  const rows = await getJson(`${ARM_API}/imdb?id=${imdb}`, { signal, hosts: ["arm.haglund.dev"], timeoutMs: 6000 });
  return pickArmRow(rows, media.type === "series" ? media.season : 1);
}

async function anilistNames(id, signal) {
  const query = "query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english } synonyms } }";
  const payload = await getJson(ANILIST_API, {
    signal,
    hosts: ["graphql.anilist.co"],
    method: "POST",
    body: JSON.stringify({ query, variables: { id: Number(id) } }),
    timeoutMs: 6000
  }).catch(() => null);
  const media = payload?.data?.Media;
  return media ? [media.title?.romaji, media.title?.english, ...(media.synonyms || [])] : [];
}

async function kitsuNames(id, signal) {
  const payload = await getJson(`${KITSU_API}/anime/${Number(id)}?fields[anime]=titles,canonicalTitle,abbreviatedTitles`, { signal, hosts: ["kitsu.app"], timeoutMs: 6000 }).catch(() => null);
  const attributes = payload?.data?.attributes;
  if (!attributes) return [];
  return [attributes.titles?.en_jp, attributes.canonicalTitle, attributes.titles?.en, ...(attributes.abbreviatedTitles || [])];
}

let store = null;
// Optional shared store (Upstash): names survive restarts of the free server.
export function useAnimeNameStore(value) {
  store = value || null;
}

async function lookup(media, key) {
  const saved = store ? await store.get(`anime-names:v1:${key}`).catch(() => undefined) : undefined;
  if (saved?.names) return saved;
  // Not tied to the viewer's request: a slow first lookup still finishes and
  // is ready for the next request.
  const signal = AbortSignal.timeout(20000);
  const row = await armRow(media, signal);
  if (!row) return { names: [], final: true };
  // Lookups that failed for a reason other than "not found" are retried.
  const [anilist, kitsu] = await Promise.all([
    row.anilist ? anilistNames(row.anilist, signal) : [],
    row.kitsu ? kitsuNames(row.kitsu, signal) : []
  ]);
  const seen = new Set();
  // AniList romaji first, then Kitsu's romaji, then English and the rest.
  const ordered = [anilist[0], kitsu[0], kitsu[1], ...anilist.slice(1), ...kitsu.slice(2)];
  const names = ordered.map(latin).filter((name) => {
    const id = name.toLowerCase();
    if (!name || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 6);
  const value = { anilistId: row.anilist || null, kitsuId: row.kitsu || null, names, final: names.length > 0 };
  if (names.length) await store?.set(`anime-names:v1:${key}`, value).catch(() => null);
  return value;
}

// Returns { anilistId, kitsuId, names: [romaji first, then English, others] }.
export async function animeNames(media = {}, { signal } = {}) {
  const key = `${media.imdbId || media.sourceId || ""}:${media.type === "series" ? Number(media.season) || 1 : 0}`;
  if (key.startsWith(":")) return { names: [] };
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  let work = inflight.get(key);
  if (!work) {
    work = lookup(media, key).catch(() => ({ names: [], final: false })).then((value) => {
      // Only a definite answer is kept; a timeout is tried again next time.
      if (value.names.length || value.final) {
        cache.set(key, { value, until: Date.now() + (value.names.length ? TTL_MS : 30 * 60 * 1000) });
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
      }
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, work);
  }
  if (!signal) return work;
  if (signal.aborted) return { names: [] };
  return Promise.race([work, new Promise((resolve) => signal.addEventListener("abort", () => resolve({ names: [] }), { once: true }))]);
}
