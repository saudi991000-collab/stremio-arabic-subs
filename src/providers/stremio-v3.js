const API_BASE = "https://opensubtitles-v3.strem.io";

function allowedSubtitleUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" && (url.hostname === "strem.io" || url.hostname.endsWith(".strem.io"));
}

function releaseOf(row) {
  return row.subtitleFileName || row.movieReleaseName || `subtitle-${row.id}.srt`;
}

function mapRow(row, episodeScoped = false) {
  const url = String(row.url || "");
  if (!url || !allowedSubtitleUrl(url)) return null;
  return {
    provider: "stremio-v3",
    fileId: String(row.id || url),
    downloadRef: url,
    fileName: releaseOf(row),
    release: row.movieReleaseName || releaseOf(row),
    language: "ar",
    fps: Number(row.fpsMilli) > 0 ? Number(row.fpsMilli) / 1000 : undefined,
    rating: 0,
    downloadCount: 0,
    hashMatch: false,
    catalogMatch: true,
    episodeScoped,
    featureDetails: {
      seasonNumber: Number(row.season) || undefined,
      episodeNumber: Number(row.episode) || undefined
    }
  };
}

export class StremioV3Provider {
  constructor() {
    this.id = "stremio-v3";
    this.cache = new Map();
  }

  async rows(context) {
    const key = `${context.media.type}:${context.media.id}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.rows;
    const response = await fetch(
      `${API_BASE}/subtitles/${context.media.type}/${encodeURIComponent(context.media.id)}.json`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error(`Stremio OpenSubtitles v3 failed with HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  async search(context) {
    if (!context.media.imdbId) return [];
    const rows = await this.rows(context);
    return rows
      .filter((row) => ["ara", "ar", "arb"].includes(String(row.lang || "").toLowerCase()))
      .map((row) => mapRow(row, context.media.type === "series"))
      .filter(Boolean);
  }

  async download(ref) {
    let current = String(ref);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedSubtitleUrl(current)) throw new Error("Blocked Stremio subtitle URL");
      const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`Stremio subtitle download failed with HTTP ${response.status}`);
      const size = Number(response.headers.get("content-length"));
      if (size > 10 * 1024 * 1024) throw new Error("Stremio subtitle is too large");
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName: "subtitle.srt" };
    }
    throw new Error("Too many subtitle redirects");
  }
}
