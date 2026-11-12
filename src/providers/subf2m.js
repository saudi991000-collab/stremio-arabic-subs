import { parseReleaseName } from "../media.js";
import { limiterFor, safeFetch } from "../http.js";

const BASE = "https://subf2m.co";
const HOSTS = ["subf2m.co"];
// The /download route redirects to Subf2m's own file CDN.
const DOWNLOAD_HOSTS = ["subf2m.co", "isubcdn.com"];
const limiter = limiterFor("subf2m", { minIntervalMs: 400, concurrency: 2 });
const ORDINALS = [
  "specials", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"
];

function titleFor(context) {
  return context.media.releaseTitle
    || context.media.catalogTitle
    || context.media.title
    || parseReleaseName(context.extra.filename || "").title
    || "";
}

function slugify(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cleanHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function safeDetailPath(value) {
  const path = String(value || "");
  return /^\/subtitles\/[a-z0-9-]+\/arabic\/\d+(?:\/download)?$/i.test(path) ? path : null;
}

// "Show S01 1080p", "Show Season 1", "Show S01 01-11" (no single episode).
export function isSeasonPackName(name, season) {
  const value = String(name || "");
  const parsed = parseReleaseName(value);
  if (parsed.season != null && parsed.episode != null && !/\b\d{1,3}\s*[-~]\s*\d{1,3}\b/.test(value)) return false;
  if (/\bs\d{1,2}[ ._-]*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b/i.test(value)) return false;
  const found = value.match(/(?:^|[^a-z0-9])(?:season[ ._-]*|s)0*(\d{1,2})(?![0-9])/i);
  return Boolean(found) && Number(found[1]) === Number(season);
}

function parseRows(html, context, title) {
  const blocks = String(html).split(/(?=<li\s+class=["']item\b)/i).slice(1);
  const seen = new Set();
  const rows = [];
  for (const block of blocks) {
    const path = safeDetailPath(block.match(/<a\s+class=["'][^"']*download[^"']*["'][^>]*href=["']([^"']+)/i)?.[1]
      || block.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*download/i)?.[1]);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const scroll = block.match(/<ul\s+class=["'][^"']*scrolllist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1] || "";
    const releases = [...scroll.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => cleanHtml(match[1])).filter(Boolean);
    let release = releases[0] || `${title}.Subf2m.${path.split("/").pop()}`;
    let pack = false;
    if (context.media.type === "series") {
      const exact = releases.find((name) => {
        const parsed = parseReleaseName(name);
        return parsed.season === Number(context.media.season) && parsed.episode === Number(context.media.episode);
      });
      // Season pages also carry whole-season archives ("S01 1080p NF",
      // "S01 01-11"); they are opened later and kept only if the episode
      // is inside.
      const seasonPack = !exact && releases.find((name) => isSeasonPackName(name, context.media.season));
      if (!exact && !seasonPack) continue;
      release = exact || seasonPack;
      pack = !exact;
    }
    const rate = block.match(/<span\s+class=["'][^"']*rate\s+([^"']+)["']/i)?.[1] || "";
    const uploader = cleanHtml(block.match(/<p\s+class=["'][^"']*comment-owner[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || "").slice(0, 80);
    const comment = cleanHtml(block.match(/<p\s+class=["'][^"']*comment-text[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || "").slice(0, 300);
    rows.push({ path, release, pack, uploader, comment, rating: /good/i.test(rate) ? 8 : /neutral/i.test(rate) ? 4 : /bad/i.test(rate) ? 0 : 2 });
  }
  return rows;
}

async function fetchPage(path, signal) {
  const response = await safeFetch(`${BASE}${path}`, {
    allowedHosts: HOSTS,
    headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.8,ar;q=0.7" },
    signal,
    timeoutMs: 7000,
    limiter,
    label: "Subf2m page",
    maxBytes: 4 * 1024 * 1024,
    okStatuses: [404]
  });
  return response.status === 404 ? "" : response.text();
}

// Picks the title page from Subf2m search results: for a series, the page of
// the requested season ("...-first-season", "...--third-season").
export function pickTitlePath(html, title, context) {
  const wanted = slugify(title).replace(/^the-/, "");
  if (!wanted) return null;
  const paths = [...new Set([...String(html).matchAll(/href=["'](\/subtitles\/[a-z0-9-]+)["']/gi)].map((match) => match[1].toLowerCase()))]
    .filter((path) => !path.startsWith("/subtitles/searchbytitle"));
  const base = (path) => path.slice("/subtitles/".length).replace(/^the-/, "").replace(/-+/g, "-");
  if (context.media.type === "series") {
    const ordinal = ORDINALS[Number(context.media.season)];
    if (!ordinal) return null;
    return paths.find((path) => base(path) === `${wanted}-${ordinal}-season`) || null;
  }
  return paths.find((path) => base(path) === wanted) || null;
}

export class Subf2mProvider {
  constructor() { this.id = "subf2m"; }

  async search(context, _maxPages, { signal } = {}) {
    const title = titleFor(context);
    const slug = slugify(title);
    if (!slug) return [];
    const paths = context.media.type === "series"
      ? [`/subtitles/${slug}-${ORDINALS[Number(context.media.season)] || `${context.media.season}th`}-season/arabic`, `/subtitles/${slug}/arabic`]
      : [`/subtitles/${slug}/arabic`];
    const settled = await Promise.allSettled(paths.map((path) => fetchPage(path, signal)));
    if (settled.every((item) => item.status === "rejected")) throw settled[0].reason;
    const pages = settled.map((item) => item.status === "fulfilled" ? item.value : "");
    // Guessed addresses miss many titles ("the-king-of-queens--first-season"):
    // when none of them exists, ask Subf2m's own title search.
    if (pages.every((html) => !html)) {
      const found = await this.searchTitle(title, context, signal).catch(() => null);
      if (found) pages.push(await fetchPage(`${found}/arabic`, signal).catch(() => ""));
    }
    const seen = new Set();
    return pages.flatMap((html) => parseRows(html, context, title)).filter((row) => {
      if (seen.has(row.path)) return false;
      seen.add(row.path);
      return true;
    }).map((row) => ({
      provider: this.id,
      fileId: row.path,
      downloadRef: row.path,
      fileName: `${row.release.replace(/\.(?:zip|srt|vtt|ass|ssa)$/i, "")}.srt`,
      release: row.release,
      uploader: row.uploader,
      comment: row.comment,
      language: "ar",
      hashMatch: false,
      catalogMatch: true,
      episodeScoped: context.media.type === "series" && !row.pack,
      rating: row.rating,
      downloadCount: 0,
      fromTrusted: row.rating >= 8,
      hearingImpaired: false,
      aiTranslated: false,
      machineTranslated: false,
      featureDetails: {
        seasonNumber: context.media.type === "series" ? Number(context.media.season) : undefined,
        episodeNumber: context.media.type === "series" && !row.pack ? Number(context.media.episode) : undefined
      }
    }));
  }

  async searchTitle(title, context, signal) {
    const html = await fetchPage(`/subtitles/searchbytitle?query=${encodeURIComponent(title)}`, signal);
    return pickTitlePath(html, title, context);
  }

  async download(ref, { signal } = {}) {
    const path = safeDetailPath(ref);
    if (!path || path.endsWith("/download")) throw new Error("Invalid Subf2m subtitle reference");
    const detail = await fetchPage(path, signal);
    const downloadPath = safeDetailPath(detail.match(/<a[^>]+id=["']downloadButton["'][^>]+href=["']([^"']+)/i)?.[1]
      || detail.match(/<a[^>]+href=["']([^"']+)["'][^>]+id=["']downloadButton["']/i)?.[1]);
    if (!downloadPath || !downloadPath.endsWith("/download")) throw new Error("Subf2m download link is missing");
    const response = await safeFetch(`${BASE}${downloadPath}`, {
      allowedHosts: DOWNLOAD_HOSTS,
      headers: { Referer: `${BASE}${path}` },
      signal,
      timeoutMs: 15000,
      limiter,
      label: "Subf2m download",
      maxBytes: 32 * 1024 * 1024
    });
    let fileName = "subf2m.zip";
    try {
      fileName = decodeURIComponent(new URL(response.url).pathname.split("/").pop() || fileName);
    } catch {
      // keep the default
    }
    return { buffer: response.buffer, fileName: /\.[a-z0-9]{2,4}$/i.test(fileName) ? fileName : "subf2m.zip" };
  }
}
