const DEFAULT_BASE = "https://www.subkong.com";

function rowsOf(payload) {
  return Array.isArray(payload?.subtitles) ? payload.subtitles : [];
}

function safePath(value) {
  try {
    const url = new URL(String(value), DEFAULT_BASE);
    return url.protocol === "https:" && (url.hostname === "subkong.com" || url.hostname.endsWith(".subkong.com"));
  } catch {
    return false;
  }
}

function formatOf(row) {
  const value = String(row.SubFormat || row.format || row.name || "srt").toLowerCase();
  return value.match(/(?:^|\.)(srt|vtt|ass|ssa)(?:$|[?#])/)?.[1] || "srt";
}

export class SubKongProvider {
  constructor(config = {}) {
    this.id = "subkong";
    this.config = { baseUrl: DEFAULT_BASE, ...config };
  }

  async search(context) {
    if (!context.media.imdbId) return [];
    const params = new URLSearchParams({
      imdb_id: `tt${context.media.imdbId}`,
      language: "Arabic"
    });
    if (context.media.type === "series") {
      params.set("season", String(context.media.season));
      params.set("episode", String(context.media.episode));
    }
    const response = await fetch(`${this.config.baseUrl}/api/v1/subtitles?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) throw new Error(`SubKong search failed with HTTP ${response.status}`);
    const payload = await response.json();
    return rowsOf(payload).map((row, index) => {
      if (!row?.download || !safePath(row.download)) return null;
      const format = formatOf(row);
      const release = row.MovieReleaseName || row.name || `subkong-${index + 1}`;
      const source = String(row.source || "subkong");
      return {
        provider: "subkong",
        fileId: `${source}:${row.download}`,
        downloadRef: new URL(row.download, this.config.baseUrl).toString(),
        fileName: `${release}.${format}`.replace(new RegExp(`\\.${format}\\.${format}$`, "i"), `.${format}`),
        release,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        episodeScoped: context.media.type === "series",
        rating: source === "user" ? 2 : 0,
        downloadCount: Number(row.downloads) || 0,
        fromTrusted: source === "user",
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        featureDetails: {
          year: Number(row.MovieYear) || undefined,
          seasonNumber: context.media.type === "series" ? context.media.season : undefined,
          episodeNumber: context.media.type === "series" ? context.media.episode : undefined
        }
      };
    }).filter(Boolean);
  }

  async download(ref) {
    let current = String(ref);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!safePath(current)) throw new Error("Blocked SubKong download host");
      const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(18000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`SubKong download failed with HTTP ${response.status}`);
      const size = Number(response.headers.get("content-length"));
      if (size > 64 * 1024 * 1024) throw new Error("SubKong subtitle download is too large");
      const disposition = response.headers.get("content-disposition") || "";
      const fileName = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || "subtitle.zip";
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName: decodeURIComponent(fileName) };
    }
    throw new Error("Too many SubKong redirects");
  }
}
