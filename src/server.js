import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { readConfig } from "./config.js";
import { logger } from "./logger.js";
import { manifest } from "./manifest.js";
import { parseExtra, parseReleaseName } from "./media.js";
import { alignMediaToFilename, resolveVideoId } from "./id-resolver.js";
import { arabicFansubTeam, rankCandidates, releaseMatched, resultLabel, stableKey } from "./ranker.js";
import { signSubtitleToken, verifySubtitleToken } from "./token.js";
import { convertToFormat, detectTextFormat, normalizeSubtitle } from "./subtitle.js";
import { Cache } from "./cache.js";
import { JsonStore, UpstashKv, deepFreeze, mergeSearchEntries } from "./store.js";
import { assessSubtitle } from "./quality.js";
import { OpenSubtitlesProvider } from "./providers/opensubtitles.js";
import { OpenSubtitlesOrgProvider } from "./providers/opensubtitles-org.js";
import { SubDLProvider } from "./providers/subdl.js";
import { SubSourceProvider } from "./providers/subsource.js";
import { ArabicSubsProvider } from "./providers/arabicsubs.js";
import { StremioV3Provider } from "./providers/stremio-v3.js";
import { WyzieProvider } from "./providers/wyzie.js";
import { SubKongProvider } from "./providers/subkong.js";
import { MiraiAnimeProvider } from "./providers/miraianime.js";
import { AniKotoProvider } from "./providers/anikoto.js";
import { TheSubtitleDbProvider } from "./providers/thesubtitledb.js";
import { MoraProvider } from "./providers/mora.js";
import { Subf2mProvider } from "./providers/subf2m.js";
import { YifySubtitlesProvider } from "./providers/yifysubtitles.js";
import { TvSubtitlesProvider } from "./providers/tvsubtitles.js";
import { MultiProvider } from "./providers/multi.js";
import { deepAnalyzeCandidates, isTransientError, normalizedSubtitleCacheKey, verdictKey } from "./deep-analyzer.js";
import { isIdentityTransform, retimeSubtitle } from "./timing.js";
import {
  CompanionRegistry,
  discoverWindowsStremioHlsSession,
  discoverWindowsStremioSession,
  isAllowedCompanionOrigin,
  isLoopbackAddress,
  LocalMediaAnalyzer
} from "./companion.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const embeddedConfigurePage = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ترجمة النخبة</title><style>body{margin:0;background:#0d0b18;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:620px;margin:24px;padding:34px;border:1px solid #7c5cff;border-radius:22px;background:#171328;text-align:center}h1{margin-top:0}p{color:#cbc5df;line-height:1.8}.button{display:inline-block;margin:10px;padding:14px 24px;border-radius:14px;background:#7c5cff;color:white;text-decoration:none;font-weight:700}.url{direction:ltr;word-break:break-all;background:#0b0912;padding:12px;border-radius:10px}</style></head>
<body><main class="card"><h1>⭐ ترجمة النخبة</h1><p>حتى 25 ترجمة عربية بشرية مرتبة، مع دعم صيغ الترجمة النصية وتحويلها تلقائياً إلى صيغة متوافقة مع Stremio.</p><a class="button" href="{{STREMIO_URL}}">تثبيت في Stremio</a><p>إذا لم يفتح الزر، انسخ رابط الـManifest:</p><div class="url">{{MANIFEST_URL}}</div><p>الإصدار {{VERSION}}</p></main></body></html>`;

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function json(response, status, data, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...SECURITY_HEADERS, ...extraHeaders };
  // A header explicitly set to undefined (companion routes) is removed.
  for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
  response.writeHead(status, headers);
  response.end(JSON.stringify(data));
}

function html(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  response.end(data);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function emptySubtitle(extension) {
  if (extension === "vtt") return { contentType: "text/vtt; charset=utf-8", body: "WEBVTT\n\n" };
  if (extension === "ass" || extension === "ssa") {
    return { contentType: "text/x-ssa; charset=utf-8", body: "[Script Info]\nTitle: Empty fallback\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" };
  }
  return { contentType: "application/x-subrip; charset=utf-8", body: "" };
}

async function readJsonBody(request, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function baseUrl(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  // Only a syntactically valid host may be reflected into generated URLs.
  const host = String(request.headers.host || "");
  const safeHost = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) || /^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(host) ? host : `127.0.0.1:${config.port}`;
  return `${protocol}://${safeHost}`;
}

function extensionOf(candidate) {
  if (candidate?.actualFormat) return /^(?:srt|vtt|ass|ssa)$/.test(candidate.actualFormat) ? candidate.actualFormat : "srt";
  const fileName = typeof candidate === "string" ? candidate : candidate?.fileName || candidate?.release || "";
  const format = String(fileName).toLowerCase().match(/\.(srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/)?.[1] || "srt";
  return /^(?:srt|vtt|ass|ssa)$/.test(format) ? format : "srt";
}

export const PROVIDER_LABELS = {
  opensubtitles: "OpenSubtitles",
  "opensubtitles-org": "OpenSubtitles.org",
  subdl: "SubDL",
  subsource: "SubSource",
  arabicsubs: "ArabicSubs",
  wyzie: "Wyzie",
  thesubtitledb: "TheSubtitleDB",
  subf2m: "Subf2m",
  mora: "Mora",
  subkong: "SubKong",
  miraianime: "MiraiAnime",
  anikoto: "AniKoto",
  yifysubtitles: "YIFY",
  tvsubtitles: "TVsubtitles",
  "stremio-v3": "OpenSubtitles v3"
};

// Relative trust used only as a late tie-breaker in ordering.
const PROVIDER_RELIABILITY = {
  opensubtitles: 6, "opensubtitles-org": 5, subdl: 6, subsource: 6, arabicsubs: 6, thesubtitledb: 5,
  subf2m: 4, mora: 5, miraianime: 5, yifysubtitles: 3, subkong: 3, wyzie: 3, "stremio-v3": 4, anikoto: 2
};

const PLATFORM_LABELS = {
  netflix: "Netflix",
  crunchyroll: "Crunchyroll",
  amazon: "Amazon",
  max: "Max",
  disney: "Disney+",
  hulu: "Hulu",
  "apple-tv": "Apple TV+",
  paramount: "Paramount+",
  peacock: "Peacock",
  shahid: "Shahid",
  osn: "OSN+",
  hidive: "HIDIVE"
};

function compactReleaseName(candidate) {
  // Prefer the full file name when the release field is only its tail
  // ("1080p.Bluray.X264-EVO" vs "Movie.2022.1080p.Bluray.X264-EVO.srt").
  const fileStem = String(candidate.fileName || "").replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,4}$/i, "");
  // SubSource joins every compatible release with " | "; show the first.
  const release = String(candidate.release || "").split(" | ")[0].trim();
  const name = !release || (fileStem && fileStem.toLowerCase().includes(release.replace(/^[.\s-]+|[.\s-]+$/g, "").toLowerCase()) && fileStem.length > release.length)
    ? fileStem || release
    : release;
  return String(name || candidate.fileName || "").split(" | ")[0]
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function badgesFor(candidate) {
  const matched = releaseMatched(candidate);
  const team = arabicFansubTeam(candidate);
  // 🎨 requires content inspection: a ".ass" name alone is not enough.
  const styled = Boolean(candidate.deepAnalyzed && candidate.styled);
  return { matched, team, styled };
}

export function detailedResultLabel(candidate, index) {
  const release = compactReleaseName(candidate);
  const parsed = parseReleaseName(candidate.fileName || candidate.release || "");
  const { matched, team, styled } = badgesFor(candidate);
  const badges = [matched ? resultLabel(candidate) : "", team ? "🇸🇦" : "", styled ? "🎨" : ""].filter(Boolean).join(" ");
  const details = [
    team,
    PLATFORM_LABELS[parsed.platform],
    PROVIDER_LABELS[candidate.provider] || candidate.provider || "Custom",
    extensionOf(candidate).toUpperCase(),
    release
  ].filter(Boolean);
  return `${index + 1}${badges ? ` ${badges}` : ""} | ${details.join(" • ")}`;
}

function displayBadgeProfile(candidate) {
  const { matched, team, styled } = badgesFor(candidate);
  return {
    // 💪👍 count as two visible badges, followed by 🇸🇦 then 🎨.
    count: (matched ? 2 : 0) + (team ? 1 : 0) + (styled ? 1 : 0),
    matched,
    arabicTeam: Boolean(team),
    styled
  };
}

// Final, deterministic display order (see README "Ranking").
export function sortForDisplay(candidates) {
  return candidates
    .map((candidate) => ({ candidate, badges: displayBadgeProfile(candidate) }))
    .sort((a, b) =>
      b.badges.count - a.badges.count ||
      Number(b.badges.matched) - Number(a.badges.matched) ||
      Number(b.badges.arabicTeam) - Number(a.badges.arabicTeam) ||
      Number(b.badges.styled) - Number(a.badges.styled) ||
      Number(Boolean(b.candidate.reasons?.includes("exact-hash"))) - Number(Boolean(a.candidate.reasons?.includes("exact-hash"))) ||
      Number(Boolean(b.candidate.deepAnalyzed)) - Number(Boolean(a.candidate.deepAnalyzed)) ||
      (b.candidate.timingScore || 0) - (a.candidate.timingScore || 0) ||
      (b.candidate.syncScore || 0) - (a.candidate.syncScore || 0) ||
      (b.candidate.humanScore ?? 0.5) - (a.candidate.humanScore ?? 0.5) ||
      (PROVIDER_RELIABILITY[b.candidate.provider] || 1) - (PROVIDER_RELIABILITY[a.candidate.provider] || 1) ||
      (b.candidate.qualityScore || 0) - (a.candidate.qualityScore || 0) ||
      stableKey(a.candidate).localeCompare(stableKey(b.candidate))
    )
    .map(({ candidate }) => candidate);
}

function selectDiverseCandidates(candidates, limit) {
  const selected = [];
  const deferred = [];
  const counts = new Map();
  const perProvider = Math.max(3, Math.ceil(limit / 4));
  for (const candidate of candidates) {
    const providerId = candidate.provider || "default";
    const count = counts.get(providerId) || 0;
    if (count < perProvider) {
      selected.push(candidate);
      counts.set(providerId, count + 1);
    } else deferred.push(candidate);
    if (selected.length >= limit) return selected;
  }
  for (const candidate of deferred) {
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

// After inspection: (1) the same file mirrored by several providers (same
// release name, cue count within 1%, same length) is shown once; (2) a verified
// subtitle far shorter or longer than the others for the same video (a
// featurette, a partial file, a different cut) is dropped.
export function dropDuplicatesAndOutliers(candidates, videoDurationSeconds) {
  const durations = candidates.filter((item) => item.deepAnalyzed && item.subtitleDurationSeconds > 0).map((item) => item.subtitleDurationSeconds).sort((a, b) => a - b);
  const reference = Number(videoDurationSeconds) > 60 ? Number(videoDurationSeconds) : durations.length >= 4 ? durations[Math.floor(durations.length / 2)] : 0;
  const kept = [];
  for (const candidate of candidates) {
    if (reference && candidate.deepAnalyzed && candidate.subtitleDurationSeconds > 0 && !candidate.reasons?.includes("exact-hash")) {
      const ratio = candidate.subtitleDurationSeconds / reference;
      if (ratio < 0.6 || ratio > 1.5) continue;
    }
    const name = normalizeReleaseKey(candidate);
    const duplicate = candidate.deepAnalyzed && kept.some((item) => item.deepAnalyzed && item.provider !== candidate.provider &&
      normalizeReleaseKey(item) === name &&
      Math.abs((item.cueCount || 0) - (candidate.cueCount || 0)) <= Math.max(2, (candidate.cueCount || 0) * 0.01) &&
      Math.abs((item.subtitleDurationSeconds || 0) - (candidate.subtitleDurationSeconds || 0)) <= 3);
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

function normalizeReleaseKey(candidate) {
  return compactReleaseName(candidate).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function within(promise, timeoutMs, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (arguments.length >= 3) resolve(fallback);
      else reject(new Error("deadline exceeded"));
    }, Math.max(1, timeoutMs));
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function fallbackCandidates(eligible, candidate, extension, limit) {
  const all = eligible.filter((item) => item !== candidate);
  const pool = [
    ...all.filter((item) => item.deepAnalyzed && extensionOf(item) === extension),
    ...all.filter((item) => item.deepAnalyzed && extensionOf(item) !== extension),
    ...all.filter((item) => !item.deepAnalyzed)
  ];
  const selected = [candidate];
  const providers = new Set([candidate.provider || "opensubtitles"]);
  for (const item of pool) {
    const providerId = item.provider || "opensubtitles";
    if (providers.has(providerId)) continue;
    selected.push(item);
    providers.add(providerId);
    if (selected.length >= limit) return selected;
  }
  for (const item of pool) {
    if (selected.includes(item)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function timingTransform(candidate, minConfidence = 0.6) {
  const score = Number(candidate?.timingScore);
  if (!candidate || candidate.reasons?.includes("exact-hash") || !Number.isFinite(score) || score < minConfidence) return undefined;
  if (!candidate.timingModel || candidate.timingModel === "none") {
    // Legacy tokens (3.5.x) carried scale/offset without a model name.
    if (candidate.timingModel === "none") return undefined;
  }
  const transform = Array.isArray(candidate.timingSegments) && candidate.timingSegments.length
    ? { segments: candidate.timingSegments.map((segment) => ({ start: segment.start ?? -1e9, end: segment.end ?? 1e9, scale: segment.scale, offset: segment.offset })) }
    : { scale: Number(candidate.timingScale) || 1, offset: Number(candidate.timingOffset) || 0 };
  if (isIdentityTransform(transform)) return undefined;
  return { ...transform, score, reference: candidate.timingReferenceKind || "reference" };
}

// JSON cannot carry Infinity; piecewise segments use large finite bounds.
function serializableTransform(transform) {
  if (!transform?.segments) return transform;
  return {
    ...transform,
    segments: transform.segments.map((segment) => ({
      start: Number.isFinite(segment.start) ? Number(segment.start.toFixed(3)) : -1e9,
      end: Number.isFinite(segment.end) ? Number(segment.end.toFixed(3)) : 1e9,
      scale: Number(segment.scale.toFixed(7)),
      offset: Number(segment.offset.toFixed(3))
    }))
  };
}

function searchKey(type, id, extra) {
  const filename = path.basename(String(extra.filename || "")).toLowerCase().slice(0, 240);
  return `search:v2:${type}:${id}:${filename}:${String(extra.videoHash || "").toLowerCase()}:${extra.videoSize || ""}`;
}

export function buildProviders(config) {
  const disabled = new Set(config.disabledProviders || []);
  const providers = [
    ...(config.openSubtitles.apiKey ? [new OpenSubtitlesProvider(config.openSubtitles)] : []),
    ...(config.openSubtitlesOrg?.enabled !== false ? [new OpenSubtitlesOrgProvider(config.openSubtitlesOrg)] : []),
    ...(config.subdl.apiKey ? [new SubDLProvider(config.subdl)] : []),
    ...(config.subsource.apiKey ? [new SubSourceProvider(config.subsource)] : []),
    ...(config.arabicSubs.apiKey ? [new ArabicSubsProvider(config.arabicSubs)] : []),
    ...(config.wyzie.apiKey ? [new WyzieProvider(config.wyzie)] : []),
    new TheSubtitleDbProvider(config.theSubtitleDb),
    new Subf2mProvider(),
    new MoraProvider(config.mora),
    new SubKongProvider(config.subkong),
    new MiraiAnimeProvider(config.miraianime),
    ...(config.anikoto?.enabled !== false ? [new AniKotoProvider(config.anikoto)] : []),
    ...(config.yify?.enabled !== false ? [new YifySubtitlesProvider()] : []),
    ...(config.tvsubtitles?.enabled !== false ? [new TvSubtitlesProvider()] : []),
    new StremioV3Provider()
  ];
  return providers.filter((provider) => !disabled.has(provider.id));
}

export async function createAddonServer({ config = readConfig(), provider, cache, stores } = {}) {
  const configuredProviders = provider ? [] : buildProviders(config);
  const actualProvider = provider || new MultiProvider(configuredProviders, { providerTimeoutMs: config.providerHardTimeoutMs });
  const expectedProviders = actualProvider.names || [];
  const actualCache = cache || new Cache(config.cacheDirectory, config.cacheTtlSeconds);
  let remote = null;
  if (config.upstash) {
    try {
      remote = new UpstashKv(config.upstash);
    } catch (error) {
      logger.warn("remote cache disabled", { reason: error.message });
    }
  }
  const searchStore = stores?.search || new JsonStore({ directory: config.cacheDirectory, namespace: "search", ttlSeconds: config.searchStaleSeconds, remote });
  const verdictStore = stores?.verdicts || new JsonStore({ directory: config.cacheDirectory, namespace: "verdicts", ttlSeconds: config.verdictTtlSeconds, remote });
  const companion = new CompanionRegistry();
  const mediaAnalyzer = new LocalMediaAnalyzer({
    ffprobePath: config.ffprobePath,
    ffmpegPath: config.ffmpegPath,
    whisperPath: config.whisperPath,
    whisperModelPath: config.whisperModelPath,
    whisperSampleSeconds: config.whisperSampleSeconds
  });
  await actualCache.init();
  const backgroundTasks = new Set();
  const refreshes = new Map();
  const validations = new Map();
  const storeLocks = new Map();
  const preferences = {
    allowMachineTranslated: config.allowMachineTranslated,
    allowBilingual: config.allowBilingual,
    preferHearingImpaired: config.preferHearingImpaired
  };

  function track(promise) {
    const task = promise.catch((error) => logger.warn("background task failed", { reason: error?.message || String(error) }));
    backgroundTasks.add(task);
    task.finally(() => backgroundTasks.delete(task));
    return task;
  }

  async function discoverLocalPlayback() {
    const processSession = await discoverWindowsStremioSession().catch(() => null);
    if (!processSession) return null;
    return await discoverWindowsStremioHlsSession(processSession).catch(() => null) || processSession;
  }

  // Serialises read-merge-write per key so concurrent requests and late
  // provider results never overwrite each other's merges.
  function mergeIntoStore(key, snapshot, media) {
    const previousLock = storeLocks.get(key) || Promise.resolve();
    const work = previousLock.then(async () => {
      const previous = await searchStore.get(key);
      const merged = mergeSearchEntries(previous, snapshot, expectedProviders);
      const entry = deepFreeze({ ...merged, media: media || previous?.media });
      await searchStore.set(key, entry);
      return entry;
    });
    const settled = work.catch(() => null);
    storeLocks.set(key, settled);
    settled.finally(() => {
      if (storeLocks.get(key) === settled) storeLocks.delete(key);
    });
    return work;
  }

  async function runSearch(key, context, timeoutMs) {
    const onLate = (late) => {
      track(mergeIntoStore(key, late, context.media).then((entry) => {
        logger.info("late provider results merged", { providers: Object.keys(late.providers), candidates: entry.candidates.length, complete: entry.complete });
        scheduleValidation(key, entry, context);
      }));
    };
    let snapshot;
    if (typeof actualProvider.searchSnapshot === "function") {
      snapshot = await actualProvider.searchSnapshot(context, config.maxSearchPages, timeoutMs, { onLate });
    } else {
      // Custom providers (tests, scripts) implement the plain array API.
      const found = await actualProvider.search(context, config.maxSearchPages, timeoutMs);
      const ids = new Set(["default", ...found.map((candidate) => candidate.provider || "default")]);
      snapshot = deepFreeze({
        candidates: found.map((candidate) => ({ ...candidate })),
        providers: Object.fromEntries([...ids].map((id) => [id, { status: "ok", count: found.filter((candidate) => (candidate.provider || "default") === id).length, at: Date.now() }])),
        complete: true
      });
    }
    return mergeIntoStore(key, snapshot, context.media);
  }

  const lastRefreshAt = new Map();
  function scheduleRefresh(key, context) {
    if (refreshes.has(key)) return refreshes.get(key);
    // A provider that is down for hours must not trigger a refresh on every
    // single request for the same video.
    if (Date.now() - (lastRefreshAt.get(key) || 0) < 60000) return null;
    lastRefreshAt.set(key, Date.now());
    if (lastRefreshAt.size > 5000) lastRefreshAt.delete(lastRefreshAt.keys().next().value);
    const work = track(runSearch(key, context, config.providerHardTimeoutMs).then((entry) => {
      logger.info("background search refresh finished", { candidates: entry.candidates.length, complete: entry.complete });
      scheduleValidation(key, entry, context);
    }).finally(() => refreshes.delete(key)));
    refreshes.set(key, work);
    return work;
  }

  // Validates candidates that did not fit into the listing deadline. Verdicts
  // are stored, so the next request lists them as verified immediately.
  function scheduleValidation(key, entry, context) {
    if (!config.backgroundValidation || !entry?.candidates?.length || typeof actualProvider.download !== "function") return null;
    if (validations.has(key)) return validations.get(key);
    const work = track((async () => {
      const ranked = rankCandidates(entry.candidates, context, config)
        .filter((candidate) => candidate.confidence >= Math.max(45, config.minConfidence - 25) && !candidate.reasons?.includes("season-pack"));
      await deepAnalyzeCandidates(ranked, context, actualProvider, actualCache, {
        limit: Math.min(60, ranked.length),
        timeoutMs: config.backgroundValidationTimeoutMs,
        verdicts: verdictStore,
        preferences,
        loadReference: false,
        syncWithReference: false,
        concurrency: 4,
        maxSeriesSubtitleSeconds: config.maxSeriesSubtitleSeconds
      });
    })().finally(() => validations.delete(key)));
    validations.set(key, work);
    return work;
  }

  // Warm local playback discovery outside subtitle-list requests. On Windows,
  // process discovery may take several seconds and must never make TV/mobile
  // clients abandon the first subtitle list.
  setImmediate(() => {
    discoverLocalPlayback().then((discovered) => {
      if (discovered) companion.registerTrusted(discovered);
    }).catch(() => null);
  });

  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    let url;
    try {
      url = new URL(request.url, "http://localhost");
      const companionRoute = url.pathname.startsWith("/companion/");
      if (request.method === "OPTIONS") {
        if (companionRoute) {
          const origin = request.headers.origin;
          if (!isLoopbackAddress(request.socket.remoteAddress) || !isAllowedCompanionOrigin(origin)) {
            response.writeHead(403, SECURITY_HEADERS);
            return response.end();
          }
          response.writeHead(204, { ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}), "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", ...SECURITY_HEADERS });
          return response.end();
        }
        response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", ...SECURITY_HEADERS });
        return response.end();
      }
      if (companionRoute) {
        const origin = request.headers.origin;
        if (!isLoopbackAddress(request.socket.remoteAddress) || !isAllowedCompanionOrigin(origin)) return json(response, 403, { error: "Local companion only" }, { "Access-Control-Allow-Origin": undefined });
        // Never "*" on companion routes: only the calling Stremio origin.
        const corsHeaders = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { "Access-Control-Allow-Origin": undefined };
        if (url.pathname === "/companion/session" && request.method === "POST") {
          const session = companion.register(await readJsonBody(request));
          mediaAnalyzer.bestReference(session.streamUrl, session.duration, session.playbackTime).catch(() => null);
          return json(response, 200, { ok: true, receivedAt: session.receivedAt }, corsHeaders);
        }
        if (url.pathname === "/companion/status" && request.method === "GET") {
          let session = companion.latest();
          if (!session) {
            const discovered = await discoverLocalPlayback();
            if (discovered) session = companion.registerTrusted(discovered);
          }
          return json(response, 200, {
            connected: Boolean(session),
            ageMs: session ? Date.now() - session.receivedAt : null,
            duration: session?.duration,
            title: session?.title,
            discoveredFrom: session?.discoveredFrom
          }, corsHeaders);
        }
        return json(response, 404, { error: "Not found" }, corsHeaders);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
      if (url.pathname === "/health") {
        return json(response, 200, {
          ok: true,
          version: manifest.version,
          providerConfigured: configuredProviders.length > 0 || Boolean(provider),
          providers: actualProvider.names || ["custom"],
          persistentCache: remote ? "upstash" : "disk"
        });
      }
      if (url.pathname === "/manifest.json") return json(response, 200, manifest);
      if (url.pathname === "/" || url.pathname === "/configure") {
        const template = await readFile(path.join(moduleDirectory, "../public/configure.html"), "utf8").catch(() => embeddedConfigurePage);
        const manifestUrl = `${baseUrl(request, config)}/manifest.json`;
        return html(response, 200, template
          .replaceAll("{{MANIFEST_URL}}", escapeHtml(manifestUrl))
          .replaceAll("{{STREMIO_URL}}", escapeHtml(manifestUrl.replace(/^https?:/, "stremio:")))
          .replaceAll("{{VERSION}}", escapeHtml(manifest.version)));
      }

      const subtitleRoute = url.pathname.match(/^\/subtitles\/(movie|series)\/([^/]+)(?:\/(.*))?\.json$/);
      if (subtitleRoute) {
        const listingDeadline = started + config.listingDeadlineMs;
        const [, type, encodedId, encodedExtra = ""] = subtitleRoute;
        const videoId = decodeURIComponent(encodedId);
        if (videoId.length > 200) throw new Error("Video id is too long");
        const extra = parseExtra(decodeURIComponent(encodedExtra));
        const key = searchKey(type, videoId, extra);
        let entry = await searchStore.get(key);
        // Reuse the media identity resolved the first time. Re-resolving on
        // every request made results depend on transient Cinemeta timeouts.
        let media = entry?.media;
        if (!media) {
          const resolvedMedia = await resolveVideoId(type, videoId);
          media = await alignMediaToFilename(resolvedMedia, extra);
        }
        const context = { media, extra };
        const cacheState = !entry ? "miss" : entry.complete && Date.now() - entry.updatedAt < config.cacheTtlSeconds * 1000 ? "fresh" : "stale";
        if (!entry) {
          const searchBudget = Math.max(500, Math.min(config.providerSearchTimeoutMs, listingDeadline - Date.now() - 1500));
          entry = await runSearch(key, context, searchBudget);
          if (!entry.complete) scheduleRefreshLater(key, context);
        } else if (cacheState === "stale") {
          // Serve the best previous result now and refresh in the background.
          scheduleRefresh(key, context);
        }
        const candidates = entry.candidates;
        logger.info("subtitle listing search ready", { requestId, candidates: candidates.length, cache: cacheState, complete: entry.complete, elapsedMs: Date.now() - started });
        let ranked = rankCandidates(candidates, context, config);
        const fallbackConfidence = Math.max(45, config.minConfidence - 25);
        const preliminary = ranked.filter((candidate) =>
          candidate.confidence >= fallbackConfidence && !candidate.reasons?.includes("season-pack")
        );
        const companionBudget = Math.max(0, Math.min(config.companionWaitMs, listingDeadline - Date.now() - 1000));
        let companionSession = companionBudget > 0 ? await companion.waitForRecent(companionBudget) : companion.latest();
        if (!companionSession && process.platform === "win32") {
          const discoveryBudget = Math.max(0, Math.min(750, listingDeadline - Date.now() - 1000));
          const discovered = discoveryBudget > 0
            ? await within(discoverLocalPlayback(), discoveryBudget, null)
            : null;
          if (discovered) companionSession = companion.registerTrusted(discovered);
        }
        const referenceBudget = Math.max(0, Math.min(1800, listingDeadline - Date.now() - 1000));
        const localReference = companionSession && referenceBudget > 0
          ? await within(
            mediaAnalyzer.bestReference(companionSession.streamUrl, companionSession.duration, companionSession.playbackTime).catch(() => null),
            referenceBudget,
            null
          )
          : null;
        const analysisBudget = Math.max(0, Math.min(config.deepAnalysisTimeoutMs, listingDeadline - Date.now() - 300));
        if (analysisBudget >= 500) {
          ranked = await deepAnalyzeCandidates(preliminary, context, actualProvider, actualCache, {
            limit: config.deepAnalysisCandidates,
            timeoutMs: analysisBudget,
            reference: localReference,
            verdicts: verdictStore,
            preferences,
            expectedDurationSeconds: companionSession?.duration,
            maxSeriesSubtitleSeconds: config.maxSeriesSubtitleSeconds
          });
        } else {
          ranked = preliminary;
        }
        if (ranked.some((candidate) => !candidate.deepAnalyzed)) scheduleValidation(key, entry, context);
        const requireVerifiedDownload = config.validateBeforeListing && typeof actualProvider.download === "function";
        // A provider whose daily download quota is used up cannot deliver
        // its files; listing them only produces "Failed to load" in Stremio.
        const unavailable = (candidate) => Boolean(actualProvider.byId?.get(candidate.provider)?.isQuotaExhausted?.());
        const usable = dropDuplicatesAndOutliers(ranked.filter((candidate) => candidate.confidence >= 5 && !candidate.downloadFailed && !unavailable(candidate)), companionSession?.duration);
        const eligible = requireVerifiedDownload
          ? [
            ...usable.filter((candidate) => candidate.deepAnalyzed === true && candidate.confidence >= config.minConfidence && !candidate.reasons?.includes("timing-mismatch")),
            ...usable.filter((candidate) => candidate.deepAnalyzed !== true && candidate.confidence >= config.minConfidence && !candidate.reasons?.includes("timing-mismatch"))
          ]
          : [
            ...usable.filter((candidate) => candidate.confidence >= config.minConfidence),
            ...usable.filter((candidate) => candidate.confidence < config.minConfidence)
          ];
        const displayRanked = sortForDisplay(eligible);
        const diverse = config.resultMode === "best" ? displayRanked.slice(0, 1) : selectDiverseCandidates(displayRanked, config.maxResults);
        const selected = sortForDisplay(diverse);
        const subtitles = selected.map((candidate, index) => {
          const extension = extensionOf(candidate);
          const fallback = fallbackCandidates(eligible, candidate, extension, config.downloadFallbacks);
          const items = fallback.map((item) => ({
            provider: item.provider || "opensubtitles",
            ref: item.downloadRef ?? item.fileId,
            fileId: item.fileId,
            season: item.featureDetails?.seasonNumber ?? parseReleaseName(item.fileName || item.release || "").season ?? media.season,
            episode: item.featureDetails?.episodeNumber ?? parseReleaseName(item.fileName || item.release || "").episode ?? media.episode,
            fileName: item.fileName || item.release || `subtitle.${extensionOf(item)}`,
            extension: extensionOf(item),
            fps: item.fps,
            confidence: item.confidence,
            reasons: (item.reasons || []).filter((reason) => !reason.startsWith("q:")),
            syncScore: item.syncScore || 0,
            qualityScore: item.qualityScore || 0,
            verified: Boolean(item.deepAnalyzed),
            transform: serializableTransform(timingTransform(item, config.syncMinConfidence))
          }));
          const token = signSubtitleToken({ items, extension, context: { media, extra } }, config.tokenSecret);
          const stableId = createHash("sha256").update(`${candidate.provider || "opensubtitles"}:${candidate.fileId}`).digest("hex").slice(0, 16);
          return {
            id: `arabic-syncrank-${stableId}`,
            url: `${baseUrl(request, config)}/subtitle/${token}.${extension}`,
            lang: "ara",
            label: detailedResultLabel(candidate, index)
          };
        });
        logger.info("subtitle search completed", {
          requestId,
          mediaId: media.id,
          filename: extra.filename ? path.basename(extra.filename).slice(0, 160) : "",
          hasVideoHash: Boolean(extra.videoHash),
          count: subtitles.length,
          providerCandidates: candidates.length,
          providers: Object.fromEntries(Object.entries(entry.providers || {}).map(([id, status]) => [id, `${status.status}:${status.count ?? 0}`])),
          eligibleCandidates: eligible.length,
          deepAnalyzed: selected.filter((candidate) => candidate.deepAnalyzed).length,
          timingCalibrated: selected.filter((candidate) => timingTransform(candidate, config.syncMinConfidence)).length,
          styledCandidates: selected.filter((candidate) => candidate.styled).length,
          companionReference: localReference?.source,
          cache: cacheState,
          complete: entry.complete,
          durationMs: Date.now() - started
        });
        // A short client cache only for complete results; partial lists must
        // be re-requested so the improved list shows up on the next open.
        const cacheMaxAge = entry.complete ? 300 : 0;
        return json(response, 200, { subtitles, cacheMaxAge }, { "Cache-Control": "no-store" });
      }

      const proxyRoute = url.pathname.match(/^\/subtitle\/([A-Za-z0-9_.-]{1,12000})\.(srt|vtt|ass|ssa)$/i);
      if (proxyRoute) {
        const payload = verifySubtitleToken(proxyRoute[1], config.tokenSecret);
        if (payload.extension !== proxyRoute[2].toLowerCase()) throw new Error("Subtitle extension mismatch");
        let lastError;
        const tokenItems = payload.items || (payload.fileIds || []).map((ref) => ({ provider: "opensubtitles", ref }));
        for (const item of tokenItems.slice(0, 8)) {
          try {
            const tokenContext = payload.context || { media: { season: item.season, episode: item.episode, type: item.episode != null ? "series" : "movie" }, extra: {} };
            const remembered = await verdictStore.get(verdictKey({ provider: item.provider, downloadRef: item.ref }, tokenContext)).catch(() => undefined);
            if (remembered && remembered.ok === false) throw new Error(`Previously rejected: ${remembered.reason}`);
            const key = normalizedSubtitleCacheKey({
              provider: item.provider,
              ref: item.ref,
              season: item.season,
              episode: item.episode
            });
            let normalizedBuffer = await actualCache.getFile(key);
            let extension = item.extension || payload.extension;
            if (!normalizedBuffer) {
              const downloaded = await actualProvider.download(item);
              const normalized = normalizeSubtitle(downloaded.buffer, {
                season: item.season,
                episode: item.episode,
                fileName: downloaded.fileName || item.fileName,
                outputExtension: payload.extension,
                fps: item.fps,
                preserveFormat: false,
                allowFormatMismatch: true
              });
              if (item.episode != null && normalized.analysis.durationSeconds > config.maxSeriesSubtitleSeconds) {
                throw new Error(`Series subtitle duration is implausible (${Math.round(normalized.analysis.durationSeconds / 60)} minutes)`);
              }
              if (!remembered?.ok) {
                const assessment = assessSubtitle(normalized.buffer.toString("utf8"), {
                  fileName: item.fileName,
                  allowMachineTranslated: config.allowMachineTranslated,
                  allowBilingual: config.allowBilingual
                });
                if (!assessment.accepted && assessment.verdict !== "broken") throw new Error(`Subtitle rejected: ${assessment.verdict}`);
                if (assessment.verdict === "broken" && normalized.analysis.cueCount < 1) throw new Error("Subtitle has no cues");
              }
              normalizedBuffer = normalized.buffer;
              extension = normalized.extension;
              await actualCache.setFile(key, normalizedBuffer);
              logger.info("subtitle normalized", { requestId, provider: item.provider, encoding: normalized.encoding, cueCount: normalized.analysis.cueCount });
            } else {
              // Cached files keep their real format; read it from the content.
              extension = detectTextFormat(normalizedBuffer.subarray(0, 4096).toString("utf8"));
            }
            // The URL promised payload.extension. A fallback (or a cached
            // file) in another format must be converted, or Stremio rejects
            // it with "Failed to load external subtitles".
            if (extension !== payload.extension) {
              const converted = convertToFormat(normalizedBuffer, payload.extension);
              normalizedBuffer = converted.buffer;
              extension = converted.extension;
            }
            let transform = item.transform;
            if (!transform && payload.context && !item.reasons?.includes("exact-hash")) {
              let session = companion.latest();
              if (!session && process.platform === "win32") {
                const discovered = await within(discoverLocalPlayback(), 1000, null);
                if (discovered) session = companion.registerTrusted(discovered);
              }
              if (session) {
                const candidate = {
                  provider: item.provider,
                  fileId: item.fileId ?? item.ref,
                  downloadRef: item.ref,
                  fileName: item.fileName,
                  confidence: item.confidence || 45,
                  reasons: item.reasons || [],
                  syncScore: item.syncScore || 0,
                  qualityScore: item.qualityScore || 0
                };
                const onDemandDeadline = Date.now() + config.onDemandSyncTimeoutMs;
                const reference = await within(
                  mediaAnalyzer.bestReference(session.streamUrl, session.duration, session.playbackTime).catch(() => null),
                  Math.max(250, Math.min(2500, onDemandDeadline - Date.now() - 500)),
                  null
                );
                if (reference) {
                  const analyzed = await deepAnalyzeCandidates([candidate], payload.context, actualProvider, actualCache, {
                    limit: 1,
                    timeoutMs: Math.max(1000, onDemandDeadline - Date.now()),
                    reference,
                    verdicts: verdictStore,
                    preferences
                  }).catch(() => [candidate]);
                  transform = timingTransform(analyzed[0], config.syncMinConfidence);
                }
              }
            }
            if (transform && !isIdentityTransform(transform)) {
              normalizedBuffer = Buffer.from(retimeSubtitle(normalizedBuffer.toString("utf8"), extension, transform), "utf8");
              logger.info("subtitle retimed", {
                requestId,
                provider: item.provider,
                score: Number(transform.score).toFixed(3),
                model: transform.segments ? `piecewise:${transform.segments.length}` : "linear",
                scale: transform.segments ? undefined : Number(transform.scale).toFixed(6),
                offset: transform.segments ? undefined : Number(transform.offset).toFixed(3),
                reference: transform.reference
              });
            }
            const contentType = extension === "vtt" ? "text/vtt" : extension === "ass" || extension === "ssa" ? "text/x-ssa" : "application/x-subrip";
            response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8`, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=21600", ...SECURITY_HEADERS });
            return response.end(request.method === "HEAD" ? undefined : normalizedBuffer);
          } catch (error) {
            lastError = error;
            if (!isTransientError(error) && !/Previously rejected/.test(error.message) && payload.context) {
              await verdictStore.set(verdictKey({ provider: item.provider, downloadRef: item.ref }, payload.context), { ok: false, reason: String(error.message).slice(0, 160) }).catch(() => null);
            }
            logger.warn("subtitle candidate rejected", { requestId, provider: item.provider, reason: error.message });
          }
        }
        throw lastError || new Error("No usable subtitle candidate");
      }

      return json(response, 404, { error: "Not found" });
    } catch (error) {
      logger.error("request failed", { requestId, reason: error.message, durationMs: Date.now() - started });
      // Stremio Desktop 4's bundled Node 18 server can crash when a proxied
      // subtitle URL returns JSON. Always answer subtitle-file routes with a
      // subtitle payload, even after every upstream fallback has failed.
      const subtitleExtension = url?.pathname.match(/^\/subtitle\/.*\.(srt|vtt|ass|ssa)$/i)?.[1]?.toLowerCase();
      if (subtitleExtension) {
        const fallback = emptySubtitle(subtitleExtension);
        response.writeHead(200, {
          "Content-Type": fallback.contentType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "X-Subtitle-Fallback": "empty",
          ...SECURITY_HEADERS
        });
        return response.end(fallback.body);
      }
      if (/^\/subtitles\//.test(url?.pathname || "")) {
        // Never answer a listing with an error page; an empty list lets
        // Stremio retry later instead of showing a failure.
        return json(response, 200, { subtitles: [], cacheMaxAge: 0 }, { "Cache-Control": "no-store" });
      }
      const safeMessage = /token|extension|too long|too large|Only IMDb/i.test(error.message) ? error.message : "Request failed";
      return json(response, /missing|quota/i.test(error.message) ? 503 : 400, { error: safeMessage, requestId });
    }
  });

  const retryTimers = new Set();
  function scheduleRefreshLater(key, context) {
    // A partial first search (provider timed out) is refreshed shortly after,
    // independent of the late-result merge, so the next open is complete.
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      scheduleRefresh(key, context);
    }, 15000);
    timer.unref?.();
    retryTimers.add(timer);
  }

  server.flushBackground = async () => {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    await Promise.allSettled([...backgroundTasks]);
    await Promise.allSettled([...storeLocks.values()]);
    await Promise.allSettled([searchStore.flush?.(), verdictStore.flush?.()]);
  };
  server.on("close", () => {
    for (const timer of retryTimers) clearTimeout(timer);
  });
  server.stores = { search: searchStore, verdicts: verdictStore };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  if (config.tokenSecretGenerated) logger.warn("URL_TOKEN_SECRET is not set; signed subtitle URLs will change after restart");
  const server = await createAddonServer({ config });
  server.listen(config.port, config.host, () => {
    logger.info("Arabic Elite Subtitles started", { version: manifest.version, host: config.host, port: config.port, configure: `${config.publicBaseUrl || `http://127.0.0.1:${config.port}`}/configure` });
  });
  const shutdown = () => {
    server.close();
    Promise.race([server.flushBackground(), new Promise((resolve) => setTimeout(resolve, 4000))]).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
