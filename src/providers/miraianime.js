import { normalizeName, parseReleaseName, titlesLikelyMatch } from "../media.js";

const DEFAULT_BASE = "https://miraianime.net";

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

  async search(context) {
    if (context.media.type !== "series" || !Number.isInteger(Number(context.media.episode))) return [];
    const title = titleFor(context);
    if (!title) return [];
    const params = new URLSearchParams({ search: title, per_page: "12" });
    const response = await fetch(`${this.config.baseUrl}/wp-json/wp/v2/search?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) throw new Error(`MiraiAnime search failed with HTTP ${response.status}`);
    const rows = await response.json();
    const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
      if (!row?.url || !safeMiraiUrl(row.url)) return false;
      const candidateTitle = decodeHtml(row.title || "");
      return titlesLikelyMatch(title, candidateTitle) || titlesLikelyMatch(context.extra.filename || title, candidateTitle);
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
      const page = await fetch(subtitlePage, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(7000) });
      if (!page.ok) return [];
      return archiveLinks(await page.text(), subtitlePage).map((url) => ({ row, url }));
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

  async download(ref) {
    const url = String(ref);
    if (!safeMiraiUrl(url) || !/\.zip(?:$|[?#])/i.test(url)) throw new Error("Blocked MiraiAnime download URL");
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`MiraiAnime download failed with HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 64 * 1024 * 1024) throw new Error("MiraiAnime archive is too large");
    return { buffer: Buffer.from(await response.arrayBuffer()), fileName: decodeURIComponent(new URL(url).pathname.split("/").pop() || "mirai.zip") };
  }
}
