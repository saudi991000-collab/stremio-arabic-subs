const DOWNLOAD_HOST = "sub.wyzie.io";
const NATIVE_FORMATS = new Set(["srt", "vtt", "ass", "ssa"]);

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "results", "subtitles", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return payload && typeof payload === "object" && payload.url ? [payload] : [];
}

function safeDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === DOWNLOAD_HOST || url.hostname.endsWith(`.${DOWNLOAD_HOST}`));
  } catch {
    return false;
  }
}

function convertedUrl(value, format) {
  const url = new URL(value);
  if (!NATIVE_FORMATS.has(format)) url.searchParams.set("to", "srt");
  return url.toString();
}

function mappedFormat(row) {
  const format = String(row.format || row.fileName || "srt").toLowerCase().match(/(?:^|\.)(srt|vtt|ass|ssa)$/)?.[1]
    || String(row.format || "srt").toLowerCase();
  return NATIVE_FORMATS.has(format) ? format : "srt";
}

function mapRow(row, context) {
  if (!row?.url || !safeDownloadUrl(row.url)) return null;
  if (row.ai === true) return null;
  if (row.language && String(row.language).toLowerCase() !== "ar") return null;
  const originalFormat = String(row.format || "srt").toLowerCase();
  const format = mappedFormat(row);
  const ref = convertedUrl(row.url, originalFormat);
  const release = row.release || row.matchedRelease || row.releases?.[0] || row.media || "";
  const fileName = String(row.fileName || `${release || `wyzie-${row.id}`}.${format}`).replace(/\.[a-z0-9]+$/i, `.${format}`);
  return {
    provider: "wyzie",
    fileId: `${row.source || "source"}:${row.id || ref}`,
    downloadRef: ref,
    fileName,
    release,
    language: "ar",
    hashMatch: false,
    catalogMatch: true,
    episodeScoped: context.media.type === "series",
    rating: Number(row.rating || row.score) || 0,
    downloadCount: Number(row.downloadCount) || 0,
    fromTrusted: false,
    hearingImpaired: Boolean(row.isHearingImpaired),
    aiTranslated: false,
    machineTranslated: false,
    featureDetails: {
      seasonNumber: context.media.type === "series" ? context.media.season : undefined,
      episodeNumber: context.media.type === "series" ? context.media.episode : undefined
    }
  };
}

export class WyzieProvider {
  constructor(config) {
    this.id = "wyzie";
    this.config = config;
  }

  async search(context) {
    if (!this.config.apiKey || !context.media.imdbId) return [];
    const params = new URLSearchParams({
      id: `tt${context.media.imdbId}`,
      language: "ar",
      source: "all",
      limit: "200",
      key: this.config.apiKey
    });
    if (context.media.type === "series") {
      params.set("season", String(context.media.season));
      params.set("episode", String(context.media.episode));
    }
    const response = await fetch(`${this.config.baseUrl}/search?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
    if (response.status === 429) throw new Error("Wyzie daily request limit has been reached");
    if (response.status === 402) throw new Error("Wyzie paid request balance has been reached");
    if (response.status === 400) return [];
    if (!response.ok) throw new Error(`Wyzie search failed with HTTP ${response.status}`);
    const payload = await response.json();
    return rowsOf(payload).map((row) => mapRow(row, context)).filter(Boolean);
  }

  async download(ref) {
    let current = String(ref);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!safeDownloadUrl(current)) throw new Error("Blocked Wyzie subtitle URL");
      const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`Wyzie subtitle download failed with HTTP ${response.status}`);
      const size = Number(response.headers.get("content-length"));
      if (size > 20 * 1024 * 1024) throw new Error("Wyzie subtitle is too large");
      const disposition = response.headers.get("content-disposition") || "";
      const fileName = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || "subtitle.srt";
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName: decodeURIComponent(fileName) };
    }
    throw new Error("Too many subtitle redirects");
  }
}
