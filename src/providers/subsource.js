function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "results", "movies", "subtitles", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.[key]?.data)) return payload[key].data;
  }
  return [];
}

function movieIdOf(value) {
  return value?.id ?? value?.movieId ?? value?.movie_id;
}

function subtitleIdOf(value) {
  return value?.subtitleId ?? value?.subtitle_id ?? value?.id;
}

function allowedUrl(value) {
  const url = new URL(value, "https://api.subsource.net");
  return url.protocol === "https:" && (url.hostname === "subsource.net" || url.hostname.endsWith(".subsource.net"));
}

export class SubSourceProvider {
  constructor(config) {
    this.id = "subsource";
    this.config = config;
  }

  headers() {
    return { "X-API-Key": this.config.apiKey, Accept: "application/json" };
  }

  async json(path) {
    const response = await fetch(`${this.config.baseUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(12000) });
    if (response.status === 429) throw new Error("SubSource request quota has been reached");
    if (!response.ok) throw new Error(`SubSource request failed with HTTP ${response.status}`);
    return response.json();
  }

  async search(context) {
    if (!context.media.imdbId) return [];
    const movieQuery = new URLSearchParams({ searchType: "imdb", imdb: `tt${context.media.imdbId}` });
    const moviePayload = await this.json(`/movies/search?${movieQuery}`);
    const movie = asArray(moviePayload)[0] || moviePayload?.data;
    const movieId = movieIdOf(movie);
    if (!movieId) return [];

    const subtitleQuery = new URLSearchParams({ movieId: String(movieId), language: "arabic", sort: "rating", limit: "100" });
    const payload = await this.json(`/subtitles?${subtitleQuery}`);
    return asArray(payload).map((subtitle) => {
      const fileId = subtitleIdOf(subtitle);
      const releaseInfo = Array.isArray(subtitle.releaseInfo) ? subtitle.releaseInfo : [];
      const release = releaseInfo.join(" | ") || subtitle.releaseName || subtitle.release_name || subtitle.release || subtitle.title || subtitle.name || "";
      const rating = typeof subtitle.rating === "object"
        ? Number(subtitle.rating?.good || 0) - Number(subtitle.rating?.bad || 0)
        : Number(subtitle.rating || subtitle.score) || 0;
      return {
        provider: "subsource",
        fileId,
        downloadRef: fileId,
        fileName: subtitle.fileName || subtitle.file_name || `${release || `subtitle-${fileId}`}.srt`,
        release,
        language: "ar",
        hashMatch: false,
        catalogMatch: true,
        fps: Number(subtitle.fps || subtitle.frameRate || subtitle.framerate) || undefined,
        rating,
        downloadCount: Number(subtitle.downloads || subtitle.downloadCount) || 0,
        fromTrusted: Boolean(subtitle.trusted || subtitle.fromTrusted),
        hearingImpaired: Boolean(subtitle.hi || subtitle.hearingImpaired || subtitle.hearing_impaired),
        aiTranslated: Boolean(subtitle.aiTranslated || subtitle.ai_translated),
        machineTranslated: Boolean(subtitle.machineTranslated || subtitle.machine_translated),
        featureDetails: {
          seasonNumber: Number(subtitle.season || subtitle.seasonNumber) || undefined,
          episodeNumber: Number(subtitle.episode || subtitle.episodeNumber) || undefined
        }
      };
    }).filter((candidate) => candidate.fileId != null);
  }

  async download(ref) {
    let current = `${this.config.baseUrl}/subtitles/${encodeURIComponent(ref)}/download`;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedUrl(current)) throw new Error("Blocked SubSource redirect host");
      const response = await fetch(current, { headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(response.headers.get("location"), current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`SubSource download failed with HTTP ${response.status}`);
      const size = Number(response.headers.get("content-length"));
      if (size > 20 * 1024 * 1024) throw new Error("SubSource subtitle download is too large");
      return { buffer: Buffer.from(await response.arrayBuffer()), fileName: "subtitle.zip" };
    }
    throw new Error("Too many SubSource redirects");
  }
}
