import { limiterFor, safeFetch } from "../http.js";
import { titleSimilarity } from "../media.js";

// MovieSubtitles.org: an old public movie index with many Arabic files that
// also exist on OpenSubtitles.org. OpenSubtitles.org often answers 403 to the
// add-on's cloud server, so this site is a second road to the same files.
// Movies only. Search by title, pick the page with the same title and year,
// then read the "Arabic subtitles" block. Downloads are plain ZIP files.
const BASE = "https://www.moviesubtitles.org";
const HOSTS = ["moviesubtitles.org"];
const CINEMETA = "https://v3-cinemeta.strem.io";
const limiter = limiterFor("moviesubtitles", { minIntervalMs: 400, concurrency: 2 });
const metaCache = new Map();

function clean(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

// "King and Four Queens, The (1956)" -> { title: "The King and Four Queens", year: 1956 }
export function parseMovieTitle(value) {
  const text = clean(value);
  const year = Number(text.match(/\((\d{4})\)\s*$/)?.[1]) || undefined;
  let title = text.replace(/\s*\(\d{4}\)\s*$/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const article = title.match(/^(.*),\s*(The|A|An)$/i);
  if (article) title = `${article[2]} ${article[1]}`;
  return { title, year };
}

export function parseSearchResults(html) {
  return [...String(html).matchAll(/href="\/movie-(\d+)\.html"[^>]*>([^<]+)</g)]
    .map((match) => ({ id: match[1], ...parseMovieTitle(match[2]) }));
}

export function parseArabicRows(html) {
  const text = String(html);
  const start = text.search(/<b>\s*Arabic\s+subtitles:\s*<\/b>/i);
  if (start < 0) return [];
  // The Arabic block ends where the next language heading starts.
  const rest = text.slice(start + 10);
  const end = rest.search(/<b>\s*[A-Z][a-z]+(?:\s[A-Za-z]+)?\s+subtitles:\s*<\/b>/);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const rows = [];
  const seen = new Set();
  for (const match of block.matchAll(/<a href="\/subtitle-(\d+)\.html"><b>([^<]*)<\/b>/g)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    const name = clean(match[2]);
    const release = name.match(/\(([^()]+)\)\s*$/)?.[1] || "";
    const votes = block.slice(match.index, match.index + 600).match(/color:red">(\d+)<\/span>\/<span style="color:green">(\d+)/);
    rows.push({ id: match[1], name, release, bad: Number(votes?.[1]) || 0, good: Number(votes?.[2]) || 0 });
  }
  return rows;
}

async function page(path, signal, label) {
  const response = await safeFetch(`${BASE}${path}`, {
    allowedHosts: HOSTS,
    headers: { Accept: "text/html" },
    signal,
    timeoutMs: 7000,
    limiter,
    label,
    maxBytes: 3 * 1024 * 1024,
    okStatuses: [404]
  });
  return response.status === 404 ? "" : response.text();
}

async function movieMeta(imdb, signal) {
  if (metaCache.has(imdb)) return metaCache.get(imdb);
  const response = await fetch(`${CINEMETA}/meta/movie/${imdb}.json`, { signal: signal || AbortSignal.timeout(5000) });
  const meta = response.ok ? (await response.json())?.meta || {} : {};
  const value = { name: String(meta.name || ""), year: Number(String(meta.year || meta.releaseInfo || "").match(/\d{4}/)?.[0]) || undefined };
  metaCache.set(imdb, value);
  if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
  return value;
}

export class MovieSubtitlesProvider {
  constructor() {
    this.id = "moviesubtitles";
  }

  async search(context, _maxPages, { signal } = {}) {
    if (context.media.type !== "movie" || !context.media.imdbId) return [];
    const imdb = `tt${String(context.media.imdbId).replace(/^tt/, "").padStart(7, "0")}`;
    const meta = await movieMeta(imdb, signal).catch(() => ({}));
    const title = meta.name || context.media.catalogTitle || context.media.title || "";
    if (!title) return [];
    const results = parseSearchResults(await page(`/search.php?q=${encodeURIComponent(title)}`, signal, "MovieSubtitles search"));
    const match = results
      .map((item) => ({ item, similarity: titleSimilarity(item.title, title) }))
      .filter(({ item, similarity }) => similarity >= 0.85 && (!meta.year || !item.year || Math.abs(item.year - meta.year) <= 1))
      .sort((a, b) => b.similarity - a.similarity)[0]?.item;
    if (!match) return [];
    const rows = parseArabicRows(await page(`/movie-${match.id}.html`, signal, "MovieSubtitles page"));
    return rows.map((row) => ({
      provider: this.id,
      fileId: row.id,
      downloadRef: row.id,
      fileName: `${title}${meta.year ? ` ${meta.year}` : ""}${row.release ? ` ${row.release}` : ""}.srt`.replace(/\s+/g, "."),
      release: row.release || row.name,
      language: "ar",
      hashMatch: false,
      catalogMatch: true,
      episodeScoped: false,
      rating: row.good + row.bad > 0 ? Math.round((row.good / (row.good + row.bad)) * 10) : 0,
      downloadCount: row.good + row.bad,
      fromTrusted: row.good >= 10 && row.good > row.bad * 2,
      hearingImpaired: false,
      aiTranslated: false,
      machineTranslated: false,
      featureDetails: {}
    }));
  }

  async download(ref, { signal } = {}) {
    const id = String(ref || "");
    if (!/^\d{1,9}$/.test(id)) throw new Error("Invalid MovieSubtitles reference");
    const response = await safeFetch(`${BASE}/download-${id}.html`, {
      allowedHosts: HOSTS,
      headers: { Referer: `${BASE}/subtitle-${id}.html`, Accept: "application/zip,*/*" },
      signal,
      timeoutMs: 12000,
      limiter,
      label: "MovieSubtitles download",
      maxBytes: 10 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: `moviesubtitles-${id}.zip` };
  }
}
