import { normalizeName, parseReleaseName, titlesLikelyMatch } from "../media.js";
import { limiterFor, safeFetch } from "../http.js";
import { titleCoverage } from "../ranker.js";

const DEFAULT_BASE = "https://miraianime.net";
const HOSTS = ["miraianime.net"];
const limiter = limiterFor("miraianime", { minIntervalMs: 300, concurrency: 2 });

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&#039;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
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

  async search(context, _maxPages, { signal } = {}) {
    if (context.media.type !== "series" || !Number.isInteger(Number(context.media.episode))) return [];
    const title = titleFor(context);
    if (!title) return [];
    const params = new URLSearchParams({ search: title, per_page: "12" });
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
    const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
      if (!row?.url || !safeMiraiUrl(row.url)) return false;
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
    const matches = (exact.length ? exact : filtered).slice(0, 1);
    const pages = await Promise.all(matches.map(async (row) => {
      const subtitlePage = String(row.url).replace("/anime/", "/subtitle/");
      const page = await safeFetch(subtitlePage, {
        allowedHosts: HOSTS,
        headers: { Accept: "text/html" },
        signal,
        timeoutMs: 6000,
        limiter,
        label: "MiraiAnime page",
        maxBytes: 4 * 1024 * 1024,
        okStatuses: [404]
      }).catch(() => null);
      if (!page || page.status !== 200) return [];
      return archiveLinks(page.text(), subtitlePage).map((url) => ({ row, url }));
    }));
    const season = Number(context.media.season) || 1;
    const episode = Number(context.media.episode);
    return pages.flat().slice(0, 12).map(({ row, url }, index) => {
      const show = decodeHtml(row.title || title).replace(/\s+/g, ".");
      const fileName = `${show}.S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}.Mirai.${index + 1}.ass`;
      return {
        provider: "miraianime",
        fileId: url,
        downloadRef: url,
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
    const response = await safeFetch(url, {
      allowedHosts: HOSTS,
      signal,
      timeoutMs: 20000,
      limiter,
      label: "MiraiAnime download",
      maxBytes: 32 * 1024 * 1024
    });
    let fileName = "mirai.zip";
    try {
      fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || fileName);
    } catch {
      // keep the default
    }
    return { buffer: response.buffer, fileName };
  }
}
