import { randomBytes } from "node:crypto";
import path from "node:path";

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function readConfig(env = process.env) {
  const generatedSecret = randomBytes(32).toString("hex");
  const localPrograms = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "StremioService") : "";
  return {
    host: env.HOST || "0.0.0.0",
    port: int(env.PORT, 7000, 1, 65535),
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    resultMode: env.RESULT_MODE === "best" ? "best" : "top20",
    minConfidence: int(env.MIN_CONFIDENCE, 70, 0, 100),
    maxResults: int(env.MAX_RESULTS, 25, 1, 25),
    downloadFallbacks: int(env.DOWNLOAD_FALLBACKS, 4, 1, 6),
    maxSearchPages: int(env.MAX_SEARCH_PAGES, 4, 1, 10),
    deepAnalysisCandidates: int(env.DEEP_ANALYSIS_CANDIDATES, 25, 0, 25),
    deepAnalysisTimeoutMs: int(env.DEEP_ANALYSIS_TIMEOUT_MS, 7500, 1000, 30000),
    listingDeadlineMs: int(env.LISTING_DEADLINE_MS, 11500, 3000, 12000),
    providerSearchTimeoutMs: int(env.PROVIDER_SEARCH_TIMEOUT_MS, 5000, 1000, 10000),
    onDemandSyncTimeoutMs: int(env.ON_DEMAND_SYNC_TIMEOUT_MS, 7000, 1000, 10000),
    companionWaitMs: int(env.COMPANION_WAIT_MS, 0, 0, 5000),
    ffprobePath: env.STREMIO_FFPROBE_PATH || (localPrograms ? path.join(localPrograms, "ffprobe.exe") : "ffprobe"),
    ffmpegPath: env.STREMIO_FFMPEG_PATH || (localPrograms ? path.join(localPrograms, "ffmpeg.exe") : "ffmpeg"),
    whisperPath: path.resolve(env.WHISPER_PATH || "tools/whisper/bin/Release/whisper-cli.exe"),
    whisperModelPath: path.resolve(env.WHISPER_MODEL_PATH || "tools/whisper/ggml-base.bin"),
    whisperSampleSeconds: int(env.WHISPER_SAMPLE_SECONDS, 60, 20, 120),
    maxSeriesSubtitleSeconds: int(env.MAX_SERIES_SUBTITLE_MINUTES, 90, 15, 240) * 60,
    cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 21600, 60, 604800),
    cacheDirectory: path.resolve(env.CACHE_DIRECTORY || "./data/cache"),
    tokenSecret: env.URL_TOKEN_SECRET || generatedSecret,
    tokenSecretGenerated: !env.URL_TOKEN_SECRET,
    allowMachineTranslated: bool(env.ALLOW_MACHINE_TRANSLATED, false),
    allowBilingual: bool(env.ALLOW_BILINGUAL, true),
    preferHearingImpaired: bool(env.PREFER_HEARING_IMPAIRED, false),
    validateBeforeListing: bool(env.VALIDATE_BEFORE_LISTING, true),
    openSubtitles: {
      apiKey: env.OPENSUBTITLES_API_KEY || "",
      username: env.OPENSUBTITLES_USERNAME || "",
      password: env.OPENSUBTITLES_PASSWORD || "",
      baseUrl: "https://api.opensubtitles.com/api/v1",
      userAgent: "ArabicEliteSubs v3.2.2"
    },
    subdl: {
      apiKey: env.SUBDL_API_KEY || "",
      baseUrl: "https://api.subdl.com/api/v1"
    },
    subsource: {
      apiKey: env.SUBSOURCE_API_KEY || "",
      baseUrl: "https://api.subsource.net/api/v1"
    },
    arabicSubs: {
      apiKey: env.ARABICSUBS_API_KEY || "",
      baseUrl: "https://arabicsubs.com/api/v1"
    }
  };
}
