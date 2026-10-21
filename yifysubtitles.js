import { limiterFor, safeFetch } from "../http.js";
import { normalizeName } from "../media.js";

// YIFY Subtitles: public movie subtitle index (movies only) with many
// community-made Arabic files. One listing page per movie IMDb id; the ZIP is
// fetched only when the subtitle is validated or played. The site requires the
// normal Referer header its own download button sends; no login or CAPTCHA.
const HOSTS = ["yifysubtitles.ch"];
const BASE = "https://yifysubtitles.ch";
const limiter = limiterFor("yifysubtitles", { minIntervalMs: 400, concurrency: 2 });

function clean(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function safeSlug(value) {
  const slug = String(value || "").match(/^\/subtitles\/([a-z0-9-]+)$/i)?.[1];
  return slug && slug.length <= 200 ? slug : null;
}

export function parseYifyRows(html) {
  const rows = [];
  for (const match of String(html).matchAll(/<tr[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const block = match[2];
    const language = clean(block.match(/class="sub-lang"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    if (!/^arabic$/i.test(language)) continue;
    const link = block.match(/<a[^>]+href="(\/subtitles\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const slug = safeSlug(link?.[1]);
    if (!slug) continue;
    const releases = String(link[2])
      .replace(/<span class="text-muted">[\s\S]*?<\/span>/i, "")
      .split(/<br\s*\/?>/i)
      .map(clean)
      .filter(Boolean);
    rows.push({
      id: match[1],
      slug,
      releases,
      rating: Number(clean(block.match(/class="rating-cell"[\s\S]*?>(-?\d+)</i)?.[1])) || 0,
      uploader: clean(block.match(/class="uploader-cell"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]).slice(0, 80)
    });
  }
  return rows;
}

export class YifySubtitlesProvider {
  constructor() {
    this.id = "yifysubtitles";
  }

  async search(context, _maxPages, { signal } = {}) {
    if (context.media.type !== "movie" || !context.media.imdbId) return [];
    const imdb = `tt${String(context.media.imdbId).padStart(7, "0")}`;
    const response = await safeFetch(`${BASE}/movie-imdb/${imdb}`, {
      allowedHosts: HOSTS,
      headers: { Accept: "text/html" },
      signal,
      timeoutMs: 7000,
      limiter,
      label: "YIFY search",
      maxBytes: 3 * 1024 * 1024,
      okStatuses: [404]
    });
    if (response.status === 404) return [];
    const wanted = new Set(normalizeName(context.extra.filename || "").split(" ").filter((token) => token.length >= 2));
    const overlap = (name) => normalizeName(name).split(" ").filter((token) => wanted.has(token)).length;
    return parseYifyRows(response.text()).map((row) => {
      // One YIFY file lists every release it was synced for; label it with the
      // one closest to the playing file.
      const release = [...row.releases].sort((a, b) => overlap(b) - overlap(a))[0] || row.slug;
      return {
        provider: this.id,
        fileId: row.id,
        downloadRef: row.slug,
        fileName: `${release.replace(/\.(?:srt|zip)$/i, "")}.srt`,
        release,
        alternativeReleases: row.releases.filter((item) => item !== release).slice(0, 12),
        uploader: row.uploader,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: false,
        rating: Math.max(0, Math.min(10, row.rating)),
        downloadCount: 0,
        fromTrusted: row.rating >= 5,
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        featureDetails: {}
      };
    });
  }

  async download(ref, { signal } = {}) {
    const slug = String(ref || "");
    if (!/^[a-z0-9-]{3,200}$/i.test(slug)) throw new Error("Invalid YIFY subtitle reference");
    const response = await safeFetch(`${BASE}/subtitle/${slug}.zip`, {
      allowedHosts: HOSTS,
      headers: { Referer: `${BASE}/subtitles/${slug}`, Accept: "application/zip,*/*" },
      signal,
      timeoutMs: 12000,
      limiter,
      label: "YIFY download",
      maxBytes: 10 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: `${slug}.zip` };
  }
}
