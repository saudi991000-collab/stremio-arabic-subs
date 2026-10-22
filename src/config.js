import { randomBytes } from "node:crypto";
import path from "node:path";
import { USER_AGENT, VERSION } from "./version.js";

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function float(value, fallback, min, max) {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function list(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function readConfig(env = process.env) {
  const generatedSecret = randomBytes(32).toString("hex");
  const localPrograms = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "StremioService") : "";
  const listingDeadlineMs = int(env.LISTING_DEADLINE_MS, 10000, 3000, 12000);
  return {
    version: VERSION,
    host: env.HOST || "0.0.0.0",
    port: int(env.PORT, 7000, 1, 65535),
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    resultMode: env.RESULT_MODE === "best" ? "best" : "top20",
    minConfidence: int(env.MIN_CONFIDENCE, 70, 0, 100),
    maxResults: int(env.MAX_RESULTS, 25, 1, 25),
    downloadFallbacks: int(env.DOWNLOAD_FALLBACKS, 5, 1, 8),
    maxSearchPages: int(env.MAX_SEARCH_PAGES, 3, 1, 10),
    // Candidates downloaded and inspected inside the listing request. Some are
    // rejected (English, machine translation, wrong episode), so inspect more
    // than MAX_RESULTS when time allows.
    deepAnalysisCandidates: int(env.DEEP_ANALYSIS_CANDIDATES, 35, 0, 60),
    deepAnalysisTimeoutMs: int(env.DEEP_ANALYSIS_TIMEOUT_MS, 6500, 500, 30000),
    // Of those, how many may be newly downloaded and parsed while Stremio
    // waits. Parsing is CPU-bound; Render's free instance has a fraction of a
    // CPU, so a large value delays the whole response.
    listingDownloads: int(env.LISTING_DOWNLOADS, 6, 0, 60),
    // Total time a listing may take before Stremio is answered. Stremio
    // clients abandon slow subtitle requests, so this is capped at 12 s.
    listingDeadlineMs,
    // How long the listing waits for providers before continuing with what
    // has arrived. Slower providers keep running in the background (up to
    // PROVIDER_HARD_TIMEOUT_MS) and their results are merged into the cache.
    providerSearchTimeoutMs: int(env.PROVIDER_SEARCH_TIMEOUT_MS, 5000, 1000, 10000),
    providerHardTimeoutMs: int(env.PROVIDER_HARD_TIMEOUT_MS, 12000, 2000, 30000),
    onDemandSyncTimeoutMs: int(env.ON_DEMAND_SYNC_TIMEOUT_MS, 6000, 1000, 10000),
    readyAnswers: bool(env.READY_ANSWERS, true),
    companionWaitMs: int(env.COMPANION_WAIT_MS, 0, 0, 5000),
    backgroundValidation: bool(env.BACKGROUND_VALIDATION, true),
    backgroundValidationTimeoutMs: int(env.BACKGROUND_VALIDATION_TIMEOUT_MS, 25000, 2000, 120000),
    syncMinConfidence: float(env.SYNC_MIN_CONFIDENCE, 0.6, 0.3, 0.99),
    ffprobePath: env.STREMIO_FFPROBE_PATH || (localPrograms ? path.join(localPrograms, "ffprobe.exe") : "ffprobe"),
    ffmpegPath: env.STREMIO_FFMPEG_PATH || (localPrograms ? path.join(localPrograms, "ffmpeg.exe") : "ffmpeg"),
    whisperPath: path.resolve(env.WHISPER_PATH || "tools/whisper/bin/Release/whisper-cli.exe"),
    whisperModelPath: path.resolve(env.WHISPER_MODEL_PATH || "tools/whisper/ggml-base.bin"),
    whisperSampleSeconds: int(env.WHISPER_SAMPLE_SECONDS, 60, 20, 120),
    maxSeriesSubtitleSeconds: int(env.MAX_SERIES_SUBTITLE_MINUTES, 90, 15, 240) * 60,
    // Fresh search results are reused for CACHE_TTL_SECONDS. After that they
    // are still served (stale) for up to SEARCH_STALE_SECONDS while a
    // background refresh runs, so a cold or slow provider never empties a list.
    cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 21600, 60, 604800),
    searchStaleSeconds: int(env.SEARCH_STALE_SECONDS, 604800, 3600, 2592000),
    verdictTtlSeconds: int(env.VERDICT_TTL_SECONDS, 1209600, 3600, 7776000),
    cacheDirectory: path.resolve(env.CACHE_DIRECTORY || "./data/cache"),
    upstash: env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }
      : null,
    tokenSecret: env.URL_TOKEN_SECRET || generatedSecret,
    tokenSecretGenerated: !env.URL_TOKEN_SECRET,
    allowMachineTranslated: bool(env.ALLOW_MACHINE_TRANSLATED, false),
    allowBilingual: bool(env.ALLOW_BILINGUAL, true),
    preferHearingImpaired: bool(env.PREFER_HEARING_IMPAIRED, false),
    validateBeforeListing: bool(env.VALIDATE_BEFORE_LISTING, true),
    disabledProviders: list(env.DISABLED_PROVIDERS),
    openSubtitles: {
      apiKey: env.OPENSUBTITLES_API_KEY || "",
      username: env.OPENSUBTITLES_USERNAME || "",
      password: env.OPENSUBTITLES_PASSWORD || "",
      baseUrl: "https://api.opensubtitles.com/api/v1",
      userAgent: env.OPENSUBTITLES_USER_AGENT || USER_AGENT
    },
    openSubtitlesOrg: {
      enabled: bool(env.ENABLE_OPENSUBTITLES_ORG, true),
      userAgent: env.OPENSUBTITLES_ORG_USER_AGENT || USER_AGENT
    },
    yify: {
      enabled: bool(env.ENABLE_YIFY, true)
    },
    tvsubtitles: {
      enabled: bool(env.ENABLE_TVSUBTITLES, true)
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
    },
    wyzie: {
      apiKey: env.WYZIE_API_KEY || "",
      baseUrl: "https://sub.wyzie.io"
    },
    subkong: {
      baseUrl: "https://www.subkong.com"
    },
    miraianime: {
      baseUrl: "https://miraianime.net"
    },
    anikoto: {
      enabled: bool(env.ENABLE_ANIKOTO, true),
      baseUrl: "https://watch.reyamika.eu.cc"
    },
    theSubtitleDb: {
      baseUrl: "https://api.thesubtitledb.org/v1"
    },
    mora: {
      metadataUrl: "https://archive.org/metadata/mora25r"
    }
  };
}
