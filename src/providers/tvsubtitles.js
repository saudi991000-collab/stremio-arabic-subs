import { limiterFor, safeFetch } from "../http.js";
import { titleSimilarity } from "../media.js";

// TVsubtitles.net: public TV-only index with an Arabic ("ar") track for many
// shows. Its search form is broken (404), so the full show list is read once
// and cached; then one season page per request. Download pages assemble the
// ZIP path from four JavaScript string parts (s1..s4), as the site does.
const BASE = "https://www.tvsubtitles.net";
const HOSTS = ["tvsubtitles.net"];
const CINEMETA = "https://v3-cinemeta.strem.io";
const limiter = limiterFor("tvsubtitles", { minIntervalMs: 350, concurrency: 2 });

function clean(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

export function parseShowList(html) {
  const shows = new Map();
  for (const match of String(html).matchAll(/href="\/?tvshow-(\d+)-\d+\.html"[^>]*>(?:<b>)?([^<]+)/g)) {
    if (!shows.has(match[1])) shows.set(match[1], clean(match[2]));
  }
  return [...shows].map(([id, name]) => ({ id, name }));
}

export function parseEpisodeRow(html, season, episode) {
  const label = `${season}x${String(episode).padStart(2, "0")}`;
  const row = String(html).split(/<tr/i).find((part) => new RegExp(`>\\s*${label}\\s*<`).test(part));
  if (!row) return null;
  const href = row.match(/href="\/?((?:episode-\d+-ar|subtitle-\d+)\.html)"[^>]*>\s*<img[^>]+flags\/ar\.gif/i)?.[1];
  return href || null;
}

export class TvSubtitlesProvider {
  constructor() {
    this.id = "tvsubtitles";
    this.shows = null;
    this.showsExpireAt = 0;
    this.showsPromise = null;
  }

  async page(path, signal, maxBytes = 3 * 1024 * 1024) {
    const response = await safeFetch(`${BASE}/${path.replace(/^\//, "")}`, {
      allowedHosts: HOSTS,
      headers: { Accept: "text/html" },
      signal,
      timeoutMs: 7000,
      limiter,
      label: "TVsubtitles page",
      maxBytes,
      okStatuses: [404]
    });
    return response.status === 404 ? "" : response.text();
  }

  async showList(signal) {
    if (this.shows && Date.now() < this.showsExpireAt) return this.shows;
    if (!this.showsPromise) {
      this.showsPromise = this.page("tvshows.html", undefined, 6 * 1024 * 1024).then((html) => {
        this.shows = parseShowList(html);
        this.showsExpireAt = Date.now() + 24 * 60 * 60 * 1000;
        return this.shows;
      }).finally(() => {
        this.showsPromise = null;
      });
    }
    if (!signal) return this.showsPromise;
    return Promise.race([this.showsPromise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true }))]);
  }

  async warm() {
    await this.showList();
  }

  async seriesTitle(context, signal) {
    if (context.media.catalogTitle || context.media.title) return context.media.catalogTitle || context.media.title;
    if (!context.media.imdbId) return "";
    const response = await safeFetch(`${CINEMETA}/meta/series/tt${String(context.media.imdbId).padStart(7, "0")}.json`, {
      allowedHosts: ["strem.io"], signal, timeoutMs: 3500, label: "Cinemeta", maxBytes: 4 * 1024 * 1024, okStatuses: [404]
    }).catch(() => null);
    return response?.status === 200 ? response.json()?.meta?.name || "" : "";
  }

  async search(context, _maxPages, { signal } = {}) {
    if (context.media.type !== "series" || !Number.isInteger(Number(context.media.episode))) return [];
    const [title, shows] = await Promise.all([this.seriesTitle(context, signal), this.showList(signal)]);
    if (!title || !shows.length) return [];
    const wanted = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const show = shows
      .map((item) => ({ ...item, exact: item.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === wanted, similarity: titleSimilarity(title, item.name) }))
      .filter((item) => item.exact || item.similarity >= 0.99)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.name.length - b.name.length)[0];
    if (!show) return [];
    const season = Number(context.media.season);
    const episode = Number(context.media.episode);
    const seasonPage = await this.page(`tvshow-${show.id}-${season}.html`, signal);
    const href = parseEpisodeRow(seasonPage, season, episode);
    if (!href) return [];
    // An episode page can list several Arabic versions (different releases).
    let entries = [];
    if (href.startsWith("subtitle-")) {
      entries = [{ id: href.match(/\d+/)[0], release: "" }];
    } else {
      const episodePage = await this.page(href, signal);
      for (const match of episodePage.matchAll(/href="\/?subtitle-(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/g)) {
        if (!entries.some((entry) => entry.id === match[1])) entries.push({ id: match[1], release: clean(match[2]).slice(0, 160) });
      }
    }
    const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    return entries.slice(0, 10).map((entry, index) => {
      const release = /[a-z]{3}/i.test(entry.release) ? entry.release : `${show.name}.${code}.TVsubtitles.${index + 1}`;
      return {
        provider: this.id,
        fileId: entry.id,
        downloadRef: entry.id,
        fileName: `${release.replace(/\s+/g, ".")}${new RegExp(code, "i").test(release) ? "" : `.${code}`}.srt`,
        release,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: true,
        rating: 0,
        downloadCount: 0,
        fromTrusted: false,
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        featureDetails: { seasonNumber: season, episodeNumber: episode }
      };
    });
  }

  async download(ref, { signal } = {}) {
    const id = String(ref || "");
    if (!/^\d{1,9}$/.test(id)) throw new Error("Invalid TVsubtitles subtitle id");
    const page = await this.page(`download-${id}.html`, signal);
    const parts = page.match(/var\s+s1\s*=\s*['"]([^'"]*)['"][\s\S]*?var\s+s2\s*=\s*['"]([^'"]*)['"][\s\S]*?var\s+s3\s*=\s*['"]([^'"]*)['"][\s\S]*?var\s+s4\s*=\s*['"]([^'"]*)['"]/);
    if (!parts) throw new Error("TVsubtitles download link is missing");
    const file = parts.slice(1).join("");
    if (!/^[a-z0-9/_.%\- ()\[\]]+\.zip$/i.test(file) || file.includes("..")) throw new Error("Unsafe TVsubtitles download path");
    const response = await safeFetch(`${BASE}/${encodeURI(file.replace(/^\//, ""))}`, {
      allowedHosts: HOSTS,
      headers: { Referer: `${BASE}/download-${id}.html` },
      signal,
      timeoutMs: 12000,
      limiter,
      label: "TVsubtitles download",
      maxBytes: 10 * 1024 * 1024
    });
    return { buffer: response.buffer, fileName: `tvsubtitles-${id}.zip` };
  }
}
