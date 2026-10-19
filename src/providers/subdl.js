function allowedDownloadUrl(value) {
  const url = new URL(value, "https://dl.subdl.com");
  return url.protocol === "https:" && (url.hostname === "subdl.com" || url.hostname.endsWith(".subdl.com"));
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function mapSubtitle(parent, file, catalogMatch) {
  const downloadRef = file.url || parent.url;
  if (!downloadRef || !allowedDownloadUrl(downloadRef)) return null;
  const language = String(file.language || parent.language || "AR").toUpperCase();
  if (!["AR", "ARA", "ARABIC"].includes(language)) return null;
  const release = file.release_name || parent.release_name || parent.name || file.name || "";
  return {
    provider: "subdl",
    fileId: file.file_n_id || parent.n_id || downloadRef,
    downloadRef,
    fileName: file.name || parent.name || `${release}.srt`,
    fileSize: positiveNumber(file.size || parent.size),
    release,
    language: "ar",
    hashMatch: false,
    catalogMatch,
    fps: positiveNumber(file.fps || parent.fps),
    rating: Number(parent.rating) || 0,
    downloadCount: Number(parent.downloads) || 0,
    fromTrusted: false,
    hearingImpaired: Boolean(file.hi ?? parent.hi),
    aiTranslated: Boolean(file.ai_translated ?? parent.ai_translated),
    machineTranslated: Number(file.production_type ?? parent.production_type) === 3,
    featureDetails: {
      year: positiveNumber(file.year || parent.year),
      seasonNumber: positiveNumber(file.season ?? parent.season),
      episodeNumber: positiveNumber(file.episode ?? parent.episode)
    }
  };
}

export class SubDLProvider {
  constructor(config) {
    this.id = "subdl";
    this.config = config;
  }

  async search(context) {
    const common = {
      api_key: this.config.apiKey,
      type: context.media.type === "series" ? "tv" : "movie",
      languages: "AR",
      subs_per_page: "30",
      releases: "1",
      hi: "1",
      unpack: "1",
      client: "stremio"
    };
    const searches = [];
    if (context.media.imdbId) searches.push(new URLSearchParams({ ...common, imdb_id: `tt${context.media.imdbId}` }));
    if (context.extra.filename) searches.push(new URLSearchParams({ ...common, file_name: context.extra.filename }));
    if (!searches.length) return [];
    if (context.media.type === "series") {
      for (const params of searches) {
        params.set("season_number", String(context.media.season));
        params.set("episode_number", String(context.media.episode));
      }
    }
    const candidates = [];
    const payloads = await Promise.all(searches.map(async (params) => {
      const response = await fetch(`${this.config.baseUrl}/subtitles?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000)
      });
      if (response.status === 429) throw new Error("SubDL request quota has been reached");
      if (!response.ok) throw new Error(`SubDL search failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.status === false) throw new Error(`SubDL search failed: ${payload.error || "unknown error"}`);
      return payload;
    }));
    for (const payload of payloads) {
      for (const subtitle of payload.subtitles || []) {
        const files = subtitle.unpack_files?.length ? subtitle.unpack_files : [subtitle];
        for (const file of files) {
          const candidate = mapSubtitle(subtitle, file, Boolean(context.media.imdbId));
          if (candidate) candidates.push(candidate);
        }
      }
    }
    return [...new Map(candidates.map((candidate) => [String(candidate.downloadRef), candidate])).values()];
  }

  async download(ref) {
    let current = new URL(String(ref), "https://dl.subdl.com").toString();
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedDownloadUrl(current)) throw new Error("Blocked SubDL redirect host");
      const response = await fetch(current, {
        redirect: "manual",
        headers: { "X-API-Key": this.config.apiKey },
        signal: AbortSignal.timeout(15000)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`SubDL download failed with HTTP ${response.status}`);
      const size = Number(response.headers.get("content-length"));
      if (size > 20 * 1024 * 1024) throw new Error("SubDL subtitle download is too large");
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName: "subtitle.zip" };
    }
    throw new Error("Too many SubDL redirects");
  }
}
