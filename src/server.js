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
import { arabicFansubTeam, rankCandidates, resultLabel } from "./ranker.js";
import { signSubtitleToken, verifySubtitleToken } from "./token.js";
import { normalizeSubtitle } from "./subtitle.js";
import { Cache } from "./cache.js";
import { OpenSubtitlesProvider } from "./providers/opensubtitles.js";
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
import { MultiProvider } from "./providers/multi.js";
import { deepAnalyzeCandidates, normalizedSubtitleCacheKey } from "./deep-analyzer.js";
import { retimeSubtitle } from "./timing.js";
import {
  CompanionRegistry,
  discoverWindowsStremioHlsSession,
  discoverWindowsStremioSession,
  isLoopbackAddress,
  LocalMediaAnalyzer
} from "./companion.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const embeddedConfigurePage = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ترجمة النخبة</title><style>body{margin:0;background:#0d0b18;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:620px;margin:24px;padding:34px;border:1px solid #7c5cff;border-radius:22px;background:#171328;text-align:center}h1{margin-top:0}p{color:#cbc5df;line-height:1.8}.button{display:inline-block;margin:10px;padding:14px 24px;border-radius:14px;background:#7c5cff;color:white;text-decoration:none;font-weight:700}.url{direction:ltr;word-break:break-all;background:#0b0912;padding:12px;border-radius:10px}</style></head>
<body><main class="card"><h1>⭐ ترجمة النخبة</h1><p>حتى 25 ترجمة عربية بشرية مرتبة، مع دعم صيغ الترجمة النصية وتحويلها تلقائياً إلى صيغة متوافقة مع Stremio.</p><a class="button" href="{{STREMIO_URL}}">تثبيت في Stremio</a><p>إذا لم يفتح الزر، انسخ رابط الـManifest:</p><div class="url">{{MANIFEST_URL}}</div></main></body></html>`;

function json(response, status, data, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...extraHeaders });
  response.end(JSON.stringify(data));
}

function html(response, status, data) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  response.end(data);
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
  return `${protocol}://${request.headers.host || `127.0.0.1:${config.port}`}`;
}

function extensionOf(candidate) {
  if (candidate?.actualFormat) return /^(?:srt|vtt|ass|ssa)$/.test(candidate.actualFormat) ? candidate.actualFormat : "srt";
  const fileName = typeof candidate === "string" ? candidate : candidate?.fileName || candidate?.release || "";
  const format = String(fileName).toLowerCase().match(/\.(srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/)?.[1] || "srt";
  return /^(?:srt|vtt|ass|ssa)$/.test(format) ? format : "srt";
}

const PROVIDER_LABELS = {
  opensubtitles: "OpenSubtitles",
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
  "stremio-v3": "OpenSubtitles v3"
};

const PLATFORM_LABELS = {
  netflix: "Netflix",
  crunchyroll: "Crunchyroll",
  amazon: "Amazon",
  max: "Max",
  disney: "Disney+",
  hulu: "Hulu",
  "apple-tv": "Apple TV+"
};

function compactReleaseName(candidate) {
  return String(candidate.release || candidate.fileName || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:srt|vtt|ass|ssa|smi|sami|sbv|ttml|dfxp|sub)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

function detailedResultLabel(candidate, index) {
  const release = compactReleaseName(candidate);
  const parsed = parseReleaseName(candidate.fileName || candidate.release || "");
  const team = arabicFansubTeam(candidate);
  const badges = [resultLabel(candidate), team ? "🇸🇦" : "", candidate.styled ? "🎨" : ""].filter(Boolean).join(" ");
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
  const matched = Boolean(resultLabel(candidate));
  const arabicTeam = Boolean(arabicFansubTeam(candidate));
  const styled = Boolean(candidate.styled);
  return {
    // 💪👍 count as two visible badges, followed by 🇸🇦 then 🎨.
    count: (matched ? 2 : 0) + (arabicTeam ? 1 : 0) + (styled ? 1 : 0),
    matched,
    arabicTeam,
    styled
  };
}

function sortForDisplay(candidates) {
  return candidates
    .map((candidate, originalIndex) => ({ candidate, originalIndex, badges: displayBadgeProfile(candidate) }))
    .sort((a, b) =>
      b.badges.count - a.badges.count ||
      Number(b.badges.matched) - Number(a.badges.matched) ||
      Number(b.badges.arabicTeam) - Number(a.badges.arabicTeam) ||
      Number(b.badges.styled) - Number(a.badges.styled) ||
      a.originalIndex - b.originalIndex
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
    ...all.filter((item) => extensionOf(item) === extension),
    ...all.filter((item) => extensionOf(item) !== extension)
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

function timingTransform(candidate) {
  const score = Number(candidate?.timingScore);
  if (!candidate || candidate.reasons?.includes("exact-hash") || !Number.isFinite(score) || score < 0.45) return undefined;
  return {
    scale: Number(candidate.timingScale) || 1,
    offset: Number(candidate.timingOffset) || 0,
    score,
    reference: candidate.timingReferenceKind || "reference"
  };
}

export async function createAddonServer({ config = readConfig(), provider, cache } = {}) {
  const configuredProviders = [
    ...(config.openSubtitles.apiKey ? [new OpenSubtitlesProvider(config.openSubtitles)] : []),
    ...(config.subdl.apiKey ? [new SubDLProvider(config.subdl)] : []),
    ...(config.subsource.apiKey ? [new SubSourceProvider(config.subsource)] : []),
    ...(config.arabicSubs.apiKey ? [new ArabicSubsProvider(config.arabicSubs)] : []),
    ...(config.wyzie.apiKey ? [new WyzieProvider(config.wyzie)] : []),
    new TheSubtitleDbProvider(config.theSubtitleDb),
    new Subf2mProvider(),
    new MoraProvider(config.mora),
    new SubKongProvider(config.subkong),
    new MiraiAnimeProvider(config.miraianime),
    new AniKotoProvider(config.anikoto),
    new StremioV3Provider()
  ];
  const actualProvider = provider || new MultiProvider(configuredProviders);
  const actualCache = cache || new Cache(config.cacheDirectory, config.cacheTtlSeconds);
  const companion = new CompanionRegistry();
  const mediaAnalyzer = new LocalMediaAnalyzer({
    ffprobePath: config.ffprobePath,
    ffmpegPath: config.ffmpegPath,
    whisperPath: config.whisperPath,
    whisperModelPath: config.whisperModelPath,
    whisperSampleSeconds: config.whisperSampleSeconds
  });
  await actualCache.init();

  async function discoverLocalPlayback() {
    const processSession = await discoverWindowsStremioSession().catch(() => null);
    if (!processSession) return null;
    return await discoverWindowsStremioHlsSession(processSession).catch(() => null) || processSession;
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
      url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
        return response.end();
      }
      if (url.pathname === "/companion/session" && request.method === "POST") {
        if (!isLoopbackAddress(request.socket.remoteAddress)) return json(response, 403, { error: "Local companion only" });
        const session = companion.register(await readJsonBody(request));
        mediaAnalyzer.bestReference(session.streamUrl, session.duration, session.playbackTime).catch(() => null);
        return json(response, 200, { ok: true, receivedAt: session.receivedAt });
      }
      if (url.pathname === "/companion/status" && request.method === "GET") {
        if (!isLoopbackAddress(request.socket.remoteAddress)) return json(response, 403, { error: "Local companion only" });
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
        });
      }
      if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });
      if (url.pathname === "/health") {
        return json(response, 200, { ok: true, providerConfigured: configuredProviders.length > 0 || Boolean(provider), providers: actualProvider.names || ["custom"], version: manifest.version });
      }
      if (url.pathname === "/manifest.json") return json(response, 200, manifest);
      if (url.pathname === "/" || url.pathname === "/configure") {
        const template = await readFile(path.join(moduleDirectory, "../public/configure.html"), "utf8").catch(() => embeddedConfigurePage);
        const manifestUrl = `${baseUrl(request, config)}/manifest.json`;
        return html(response, 200, template.replaceAll("{{MANIFEST_URL}}", manifestUrl).replaceAll("{{STREMIO_URL}}", manifestUrl.replace(/^https?:/, "stremio:")));
      }

      const subtitleRoute = url.pathname.match(/^\/subtitles\/(movie|series)\/([^/]+)(?:\/(.*))?\.json$/);
      if (subtitleRoute) {
        const listingDeadline = started + config.listingDeadlineMs;
        const [, type, encodedId, encodedExtra = ""] = subtitleRoute;
        const extra = parseExtra(decodeURIComponent(encodedExtra));
        const resolvedMedia = await resolveVideoId(type, decodeURIComponent(encodedId));
        const media = await alignMediaToFilename(resolvedMedia, extra);
        const context = { media, extra };
        const cacheKey = JSON.stringify(context);
        let candidates = actualCache.getMemory(cacheKey);
        const cacheHit = Boolean(candidates);
        if (!candidates) {
          const searchBudget = Math.max(500, Math.min(config.providerSearchTimeoutMs, listingDeadline - Date.now() - 750));
          candidates = await actualProvider.search(context, config.maxSearchPages, searchBudget);
          actualCache.setMemory(cacheKey, candidates);
        }
        logger.info("subtitle listing search ready", { requestId, candidates: candidates.length, elapsedMs: Date.now() - started });
        let ranked = rankCandidates(candidates, context, config);
        const fallbackConfidence = Math.max(45, config.minConfidence - 25);
        const preliminary = ranked.filter((candidate) =>
          candidate.confidence >= fallbackConfidence && !candidate.reasons?.includes("season-pack")
        );
        const companionBudget = Math.max(0, Math.min(config.companionWaitMs, listingDeadline - Date.now() - 1000));
        let companionSession = companionBudget > 0 ? await companion.waitForRecent(companionBudget) : companion.latest();
        if (!companionSession) {
          const discoveryBudget = Math.max(0, Math.min(750, listingDeadline - Date.now() - 1000));
          const discovered = discoveryBudget > 0
            ? await within(discoverLocalPlayback(), discoveryBudget, null)
            : null;
          if (discovered) companionSession = companion.registerTrusted(discovered);
        }
        logger.info("subtitle listing companion ready", { requestId, connected: Boolean(companionSession), elapsedMs: Date.now() - started });
        const referenceBudget = Math.max(0, Math.min(1800, listingDeadline - Date.now() - 1000));
        const localReference = companionSession && referenceBudget > 0
          ? await within(
            mediaAnalyzer.bestReference(companionSession.streamUrl, companionSession.duration, companionSession.playbackTime).catch(() => null),
            referenceBudget,
            null
          )
          : null;
        logger.info("subtitle listing reference ready", { requestId, source: localReference?.source, elapsedMs: Date.now() - started });
        const analysisBudget = Math.max(0, Math.min(config.deepAnalysisTimeoutMs, listingDeadline - Date.now() - 250));
        if (analysisBudget >= 1000) {
          ranked = await deepAnalyzeCandidates(preliminary, context, actualProvider, actualCache, {
            limit: config.deepAnalysisCandidates,
            timeoutMs: analysisBudget,
            reference: localReference,
            maxSeriesSubtitleSeconds: config.maxSeriesSubtitleSeconds
          });
        } else {
          ranked = preliminary;
        }
        logger.info("subtitle listing analysis ready", { requestId, elapsedMs: Date.now() - started });
        const requireVerifiedDownload = config.validateBeforeListing && typeof actualProvider.download === "function";
        const usable = ranked.filter((candidate) =>
          candidate.confidence >= 5 &&
          !candidate.downloadFailed
        );
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
            reasons: item.reasons || [],
            syncScore: item.syncScore || 0,
            qualityScore: item.qualityScore || 0,
            transform: timingTransform(item)
          }));
          const token = signSubtitleToken({ items, extension, context }, config.tokenSecret);
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
          videoHash: extra.videoHash || undefined,
          videoSize: extra.videoSize,
          count: subtitles.length,
          providerCandidates: candidates.length,
          eligibleCandidates: eligible.length,
          deepAnalyzed: selected.filter((candidate) => candidate.deepAnalyzed).length,
          timingCalibrated: selected.filter((candidate) => candidate.timingScore != null).length,
          styledCandidates: selected.filter((candidate) => candidate.styled).length,
          companionReference: localReference?.source,
          cacheHit,
          durationMs: Date.now() - started,
          matchTier: ranked[0]?.tier
        });
        return json(response, 200, { subtitles, cacheMaxAge: 60 }, { "Cache-Control": "no-store" });
      }

      const proxyRoute = url.pathname.match(/^\/subtitle\/([A-Za-z0-9_.-]+)\.(srt|vtt|ass|ssa)$/i);
      if (proxyRoute) {
        const payload = verifySubtitleToken(proxyRoute[1], config.tokenSecret);
        if (payload.extension !== proxyRoute[2].toLowerCase()) throw new Error("Subtitle extension mismatch");
        let lastError;
        const tokenItems = payload.items || (payload.fileIds || []).map((ref) => ({ provider: "opensubtitles", ref }));
        for (const item of tokenItems) {
          try {
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
              normalizedBuffer = normalized.buffer;
              extension = normalized.extension;
              await actualCache.setFile(key, normalizedBuffer);
              logger.info("subtitle normalized", { requestId, provider: item.provider, fileRef: String(item.ref).slice(0, 80), encoding: normalized.encoding, cueCount: normalized.analysis.cueCount });
            }
            let transform = item.transform;
            if (!transform && payload.context && !item.reasons?.includes("exact-hash")) {
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
              let session = companion.latest();
              if (!session) {
                const discovered = await within(discoverLocalPlayback(), 1000, null);
                if (discovered) session = companion.registerTrusted(discovered);
              }
              const onDemandDeadline = Date.now() + config.onDemandSyncTimeoutMs;
              const reference = session
                ? await within(
                  mediaAnalyzer.bestReference(session.streamUrl, session.duration, session.playbackTime).catch(() => null),
                  Math.max(250, Math.min(1800, onDemandDeadline - Date.now() - 500)),
                  null
                )
                : null;
              const analyzed = await deepAnalyzeCandidates([candidate], payload.context, actualProvider, actualCache, {
                limit: 1,
                timeoutMs: Math.max(1000, onDemandDeadline - Date.now()),
                reference
              }).catch(() => [candidate]);
              transform = timingTransform(analyzed[0]);
            }
            if (transform) {
              normalizedBuffer = Buffer.from(retimeSubtitle(normalizedBuffer.toString("utf8"), extension, transform), "utf8");
              logger.info("subtitle retimed", {
                requestId,
                provider: item.provider,
                score: Number(transform.score).toFixed(3),
                scale: Number(transform.scale).toFixed(6),
                offset: Number(transform.offset).toFixed(3),
                reference: transform.reference
              });
            }
            const contentType = extension === "vtt" ? "text/vtt" : extension === "ass" || extension === "ssa" ? "text/x-ssa" : "application/x-subrip";
            response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8`, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=21600" });
            return response.end(normalizedBuffer);
          } catch (error) {
            lastError = error;
            logger.warn("subtitle candidate rejected", { requestId, provider: item.provider, fileRef: String(item.ref).slice(0, 80), reason: error.message });
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
          "X-Subtitle-Fallback": "empty"
        });
        return response.end(fallback.body);
      }
      return json(response, /missing|quota|OpenSubtitles|SubDL|SubSource|ArabicSubs/i.test(error.message) ? 503 : 400, { error: error.message, requestId });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  if (config.tokenSecretGenerated) logger.warn("URL_TOKEN_SECRET is not set; signed subtitle URLs will change after restart");
  const server = await createAddonServer({ config });
  server.listen(config.port, config.host, () => {
    logger.info("Arabic Elite Subtitles started", { host: config.host, port: config.port, configure: `${config.publicBaseUrl || `http://127.0.0.1:${config.port}`}/configure` });
  });
}
