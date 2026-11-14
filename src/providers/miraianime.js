import { normalizeName, parseReleaseName, titlesLikelyMatch } from "../media.js";
import { limiterFor, safeFetch } from "../http.js";
import { titleCoverage } from "../ranker.js";
import { animeNames } from "../anime-titles.js";
import { rangeReader, slimRemoteZip } from "../remote-zip.js";
import { archiveEntryScore } from "../subtitle.js";

const DEFAULT_BASE = "https://miraianime.net";
const HOSTS = ["miraianime.net"];
const limiter = limiterFor("miraianime", { minIntervalMs: 300, concurrency: 2 });

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&#039;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

// Search results and season pages change rarely; keep them for 6 hours so
// every episode of a season does not ask the site again.
const memo = new Map();
const MEMO_MS = 6 * 60 * 60 * 1000;
function recall(key) {
  const hit = memo.get(key);
  return hit && hit.until > Date.now() ? hit.value : undefined;
}
function remember(key, value) {
  memo.set(key, { value, until: Date.now() + MEMO_MS });
  if (memo.size > 1000) memo.delete(memo.keys().next().value);
}

function plainTitle(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// "Shingeki no Kyojin 3" = "Shingeki no Kyojin Season 3", but
// "One Piece" != "One Piece: Heroines": only season words may differ.
const SEASON_WORDS = new Set(["season", "s", "st", "nd", "rd", "th", "part", "cour", "tv", "the"]);
export function sameShow(left, right) {
  const a = plainTitle(left).split(" ").filter(Boolean);
  const b = plainTitle(right).split(" ").filter(Boolean);
  if (!a.length || !b.length) return false;
  const extra = (x, y) => x.filter((word) => !y.includes(word));
  return [...extra(a, b), ...extra(b, a)].every((word) => SEASON_WORDS.has(word))
    && a.filter((word) => /^\d+$/.test(word)).join() === b.filter((word) => /^\d+$/.test(word)).join();
}

function titleFor(context) {
  return context.media.releaseTitle
    || context.media.catalogTitle
    || context.media.title
    || parseReleaseName(context.extra.filename || "").title
    || "";
}

function safeMiraiUrl(value) {
  try {
    const url = new URL(String(value), DEFAULT_BASE);
    return url.protocol === "https:" && (url.hostname === "miraianime.net" || url.hostname.endsWith(".miraianime.net"));
  } catch {
    return false;
  }
}

function archiveLinks(html, baseUrl) {
  const links = [];
  for (const match of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const value = decodeHtml(match[1]);
    if (!/\.(?:zip)(?:$|[?#])/i.test(value)) continue;
    const absolute = new URL(value, baseUrl).toString();
    if (safeMiraiUrl(absolute)) links.push(absolute);
  }
  return [...new Set(links)];
}

export class MiraiAnimeProvider {
  constructor(config = {}) {
    this.id = "miraianime";
    this.config = { baseUrl: DEFAULT_BASE, ...config };
  }

  async findRows(query, signal) {
    const known = recall(`search:${query.toLowerCase()}`);
    if (known) return known;
    const params = new URLSearchParams({ search: query, per_page: "20" });
    const response = await safeFetch(`${this.config.baseUrl}/wp-json/wp/v2/search?${params}`, {
      allowedHosts: HOSTS,
      headers: { Accept: "application/json" },
      signal,
      timeoutMs: 6000,
      limiter,
      label: "MiraiAnime search",
      maxBytes: 2 * 1024 * 1024
    });
    const rows = response.json();
    const found = (Array.isArray(rows) ? rows : []).filter((row) => row?.url && safeMiraiUrl(row.url) && /\/anime\//.test(row.url))
      .map((row) => ({ title: row.title, url: row.url }));
    remember(`search:${query.toLowerCase()}`, found);
    return found;
  }

  async search(context, _maxPages, { signal } = {}) {
    if (context.media.type !== "series" || !Number.isInteger(Number(context.media.episode))) return [];
    const title = titleFor(context);
    // The site uses Japanese (romaji) names; look them up for this season.
    // Not raced against the request: if it is slow, the result arrives late
    // and is merged, instead of an "empty" answer being cached.
    const anime = await (this.config.animeNames || animeNames)(context.media).catch(() => ({ names: [] }));
    signal?.throwIfAborted?.();
    const names = anime.names || [];
    if (!names.length && anime.final === false) throw new Error("Anime names lookup failed");
    let matches = [];
    if (names.length) {
      const wanted = names.map(plainTitle);
      const queries = [...new Set([names[0], names[0].split(/[:\-–]/)[0].trim(), ...names.slice(1, 3)])].filter((query) => query.length >= 3).slice(0, 3);
      let failures = 0;
      let lastError;
      for (const query of queries) {
        const rows = await this.findRows(query, signal).catch((error) => {
          failures += 1;
          lastError = error;
          return [];
        });
        // Same season only: "Code Geass" must not pick "Code Geass: Dakkan no Rozé".
        const exact = rows.filter((row) => wanted.includes(plainTitle(decodeHtml(row.title || ""))));
        const close = exact.length ? exact : rows.filter((row) => names.some((name) => sameShow(name, decodeHtml(row.title || ""))));
        if (close.length) {
          matches = close.slice(0, 1);
          break;
        }
      }
      if (!matches.length && failures === queries.length && lastError) throw lastError;
    } else if (title) {
      const rows = await this.findRows(title, signal);
      const filtered = rows.filter((row) => {
        const candidateTitle = decodeHtml(row.title || "");
        // Both directions must agree: "The Last of Us" must not pick
        // "Blood-C: The Last Dark" just because one word matches.
        const strong = (left) => titlesLikelyMatch(left, candidateTitle) && titleCoverage(left, candidateTitle) >= 0.6;
        return strong(title) || strong(context.extra.filename || title);
      }).sort((a, b) => {
        const aTitle = normalizeName(decodeHtml(a.title || ""));
        const bTitle = normalizeName(decodeHtml(b.title || ""));
        const wanted = normalizeName(title);
        return Number(bTitle === wanted) - Number(aTitle === wanted) || aTitle.length - bTitle.length;
      });
      const exact = filtered.filter((row) => normalizeName(decodeHtml(row.title || "")) === normalizeName(title));
      matches = (exact.length ? exact : filtered).slice(0, 1);
    }
    if (!matches.length) return [];
    const pages = await Promise.all(matches.map(async (row) => {
      const subtitlePage = String(row.url).replace("/anime/", "/subtitle/");
      // One page serves every episode of the season.
      const known = recall(subtitlePage);
      if (known) return known.map((url) => ({ row, url }));
      const page = await safeFetch(subtitlePage, {
        allowedHosts: HOSTS,
        headers: { Accept: "text/html" },
        signal,
        timeoutMs: 6000,
        limiter,
        label: "MiraiAnime page",
        maxBytes: 4 * 1024 * 1024,
        okStatuses: [404]
      });
      const links = page.status === 200 ? archiveLinks(page.text(), subtitlePage) : [];
      remember(subtitlePage, links);
      return links.map((url) => ({ row, url }));
    }));
    const season = Number(context.media.season) || 1;
    const episode = Number(context.media.episode);
    return pages.flat().slice(0, 12).map(({ row, url }, index) => {
      const show = decodeHtml(row.title || title).replace(/\s+/g, ".");
      const fileName = `${show}.S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}.Mirai.${index + 1}.ass`;
      const ref = `${url.split("#")[0]}#s=${season}&e=${episode}`;
      return {
        provider: "miraianime",
        fileId: ref,
        downloadRef: ref,
        fileName,
        release: fileName,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: true,
        rating: 3,
        downloadCount: 0,
        fromTrusted: true,
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        featureDetails: { seasonNumber: season, episodeNumber: episode }
      };
    });
  }

  async download(ref, { signal } = {}) {
    const url = String(ref);
    if (!safeMiraiUrl(url) || !/\.zip(?:$|[?#])/i.test(url)) throw new Error("Blocked MiraiAnime download URL");
    let fileName = "mirai.zip";
    // Season zips carry ~40 MB of fonts: fetch only the subtitle entries.
    // The ref ends in "#s=1&e=5" so only that episode is fetched.
    const wanted = new URLSearchParams(new URL(url).hash.slice(1));
    const episode = Number(wanted.get("e"));
    const season = Number(wanted.get("s")) || 1;
    const select = Number.isInteger(episode) && episode > 0 ? (entries) => {
      const scored = entries.map((entry) => ({ entry, score: archiveEntryScore(entry.fileName, { season, episode }) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored.length ? scored.slice(0, 2).map((item) => item.entry) : entries;
    } : undefined;
    const slim = await slimRemoteZip(rangeReader(url.split("#")[0], { allowedHosts: HOSTS, signal, timeoutMs: 15000, limiter, label: "MiraiAnime download" }, safeFetch), { select })
      .catch((error) => {
        // The directory was read: there is nothing usable (e.g. a RAR inside).
        if (/does not contain a supported subtitle/.test(error.message)) throw error;
        return null;
      });
    const response = slim ? { buffer: slim } : await safeFetch(url.split("#")[0], {
      allowedHosts: HOSTS,
      signal,
      timeoutMs: 20000,
      limiter,
      label: "MiraiAnime download",
      maxBytes: 32 * 1024 * 1024
    });
    try {
      fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || fileName);
    } catch {
      // keep the default
    }
    return { buffer: response.buffer, fileName };
  }
}
