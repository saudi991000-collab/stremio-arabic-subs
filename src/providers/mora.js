import { parseReleaseName, titleSimilarity, titleTokens } from "../media.js";

const IDENTIFIER = "mora25r";
const BASE = `https://archive.org/download/${IDENTIFIER}`;

function titleFor(context) {
  return context.media.releaseTitle
    || context.media.catalogTitle
    || context.media.title
    || parseReleaseName(context.extra.filename || "").title
    || "";
}

function safeName(value) {
  const name = String(value || "");
  return name && !/[\\/]/.test(name) && /\.(?:srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i.test(name) ? name : null;
}

export class MoraProvider {
  constructor(config = {}) {
    this.id = "mora";
    this.config = { metadataUrl: `https://archive.org/metadata/${IDENTIFIER}`, ...config };
    this.index = null;
    this.indexExpiresAt = 0;
  }

  async files() {
    if (this.index && Date.now() < this.indexExpiresAt) return this.index;
    const response = await fetch(this.config.metadataUrl, {
      headers: { Accept: "application/json", "User-Agent": "ArabicEliteSubs/3.5.1" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Mora archive index failed with HTTP ${response.status}`);
    const payload = await response.json();
    this.index = (Array.isArray(payload.files) ? payload.files : []).filter((file) => safeName(file.name));
    this.indexExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
    return this.index;
  }

  async search(context) {
    const wantedTitle = titleFor(context);
    if (!wantedTitle) return [];
    const wantedYear = parseReleaseName(context.extra.filename || "").year || Number(context.media.year) || undefined;
    const wantedTokens = new Set(titleTokens(wantedTitle));
    const files = await this.files();
    return files.map((file) => {
      const parsed = parseReleaseName(file.name);
      const similarity = titleSimilarity(wantedTitle, file.name);
      if (similarity < 0.55) return null;
      const candidateTokens = new Set(titleTokens(file.name));
      const sharedWanted = [...wantedTokens].filter((token) => candidateTokens.has(token)).length;
      if (wantedTokens.size >= 3 && sharedWanted / wantedTokens.size < 0.6) return null;
      if (wantedYear && parsed.year && Math.abs(wantedYear - parsed.year) > 1) return null;
      if (context.media.type === "series") {
        if (parsed.season !== Number(context.media.season) || parsed.episode !== Number(context.media.episode)) return null;
      }
      return {
        provider: this.id,
        fileId: file.name,
        downloadRef: file.name,
        fileName: file.name,
        release: file.name,
        language: "ar",
        hashMatch: false,
        catalogMatch: false,
        episodeScoped: context.media.type === "series",
        rating: 2,
        downloadCount: 0,
        fromTrusted: true,
        hearingImpaired: false,
        aiTranslated: false,
        machineTranslated: false,
        fileSize: Number(file.size) || undefined,
        featureDetails: {
          seasonNumber: parsed.season,
          episodeNumber: parsed.episode,
          year: parsed.year
        }
      };
    }).filter(Boolean).sort((a, b) => titleSimilarity(wantedTitle, b.fileName) - titleSimilarity(wantedTitle, a.fileName)).slice(0, 50);
  }

  async download(ref) {
    const name = safeName(ref);
    if (!name) throw new Error("Invalid Mora subtitle name");
    const response = await fetch(`${BASE}/${encodeURIComponent(name)}`, {
      headers: { "User-Agent": "ArabicEliteSubs/3.5.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(`Mora subtitle download failed with HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 20 * 1024 * 1024) throw new Error("Mora subtitle is too large");
    return { buffer: Buffer.from(await response.arrayBuffer()), fileName: name };
  }
}
