import { createHash } from "node:crypto";
import { normalizeSubtitle } from "./subtitle.js";
import { alignTimelines, compareSpeechActivity, compareTimelines, inspectStyling, parseTimeline } from "./timing.js";
import { assessSubtitle, extractCues } from "./quality.js";

export { compareSpeechActivity, compareTimelines };

export function normalizedSubtitleCacheKey({ provider, ref, season, episode }) {
  return `subtitle:v12:verified:${provider}:${ref}:${season || ""}:${episode || ""}`;
}

export function verdictKey(candidate, context) {
  return `verdict:v1:${candidate.provider}:${String(candidate.downloadRef ?? candidate.fileId)}:${context.media.season || ""}:${context.media.episode || ""}`;
}

function subtitleCacheKey(candidate, context) {
  return normalizedSubtitleCacheKey({
    provider: candidate.provider,
    ref: candidate.downloadRef ?? candidate.fileId,
    season: context.media.season,
    episode: context.media.episode
  });
}

// Errors that say nothing about the subtitle itself. They must never be
// remembered as a rejection, or a slow provider would permanently lose its
// results (one cause of "25 results, then 2, then 9").
export function isTransientError(error) {
  const message = String(error?.message || error);
  return error?.name === "TimeoutError" || error?.name === "AbortError" || error?.retryable === true || error?.rateLimited === true ||
    /timeout|timed out|aborted|deadline|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|HTTP 5\d\d|HTTP 429|quota|rate limit/i.test(message);
}

function contentHash(cues) {
  // Ignore whitespace/punctuation/markup differences only; any change in the
  // words or numbers means a different file.
  const text = cues.map((cue) => cue.text.replace(/[\s\p{P}\p{S}]/gu, "")).filter(Boolean).join("|");
  return createHash("sha1").update(text).digest("hex").slice(0, 20);
}

export async function inspectDownloaded(buffer, candidate, context, options = {}) {
  const normalized = normalizeSubtitle(buffer, {
    season: context.media.season,
    episode: context.media.episode,
    fileName: options.fileName || candidate.fileName,
    fps: candidate.fps,
    requireArabic: options.requireArabic !== false,
    preserveFormat: false,
    allowFormatMismatch: true
  });
  const text = normalized.buffer.toString("utf8");
  const cues = extractCues(text);
  return { normalized, text, cues };
}

async function loadNormalized(candidate, context, provider, cache, { requireArabic = true, signal } = {}) {
  const key = subtitleCacheKey(candidate, context);
  let buffer = await cache.getFile(key);
  let inspected;
  if (buffer) {
    inspected = await inspectDownloaded(buffer, candidate, context, { requireArabic });
  } else {
    const downloaded = await provider.download({
      provider: candidate.provider,
      ref: candidate.downloadRef ?? candidate.fileId,
      season: context.media.season,
      episode: context.media.episode
    }, { signal });
    inspected = await inspectDownloaded(downloaded.buffer, candidate, context, { requireArabic, fileName: downloaded.fileName || candidate.fileName });
    buffer = inspected.normalized.buffer;
    await cache.setFile(key, buffer);
  }
  const { normalized, text, cues } = inspected;
  return {
    candidate,
    buffer: normalized.buffer,
    extension: normalized.extension,
    analysis: normalized.analysis,
    cues,
    timeline: parseTimeline(text),
    styling: inspectStyling(text, normalized.extension)
  };
}

export async function loadReference(context, provider, cache, options = {}) {
  if ((!context.extra.videoHash && !context.extra.filename) || typeof provider.findTimingReference !== "function") return null;
  const candidate = await provider.findTimingReference(context, options);
  if (!candidate) return null;
  const loaded = await loadNormalized(candidate, context, provider, cache, { requireArabic: false, signal: options.signal });
  return { ...loaded, kind: candidate.timingReferenceKind, source: `subtitle-${candidate.timingReferenceKind}` };
}

function verdictFrom(inspected, assessment, options) {
  return {
    ok: assessment.accepted && !(options.tooLong),
    reason: !assessment.accepted ? `quality:${assessment.verdict}` : options.tooLong ? "series-subtitle-duration-mismatch" : "",
    actualFormat: inspected.extension,
    styled: inspected.styling.styled,
    styleStrength: inspected.styling.strength,
    styleFeatures: inspected.styling.features,
    cueCount: inspected.analysis.cueCount,
    durationSeconds: Math.round(inspected.analysis.durationSeconds),
    contentHash: contentHash(inspected.cues),
    quality: {
      verdict: assessment.verdict,
      humanScore: Number(assessment.humanScore.toFixed(3)),
      arabicRatio: Number(assessment.arabicRatio.toFixed(3)),
      reasons: assessment.reasons.slice(0, 8),
      bilingual: assessment.bilingual
    }
  };
}

function applyVerdict(candidate, verdict) {
  const reasons = [...(candidate.reasons || [])];
  let confidence = candidate.confidence;
  if (verdict.styled) {
    confidence += Math.min(8, 3 + (verdict.styleStrength || 0));
    reasons.push("rich-styling");
  }
  if (verdict.quality?.reasons?.length) reasons.push(...verdict.quality.reasons.map((reason) => `q:${reason}`));
  return {
    ...candidate,
    reasons,
    confidence,
    actualFormat: verdict.actualFormat,
    styled: Boolean(verdict.styled),
    styleStrength: verdict.styleStrength || 0,
    styleFeatures: verdict.styleFeatures || [],
    humanScore: verdict.quality?.humanScore,
    contentHash: verdict.contentHash,
    cueCount: verdict.cueCount,
    subtitleDurationSeconds: verdict.durationSeconds,
    deepAnalyzed: true
  };
}

function applyTiming(candidate, inspected, reference) {
  if (!reference?.timeline?.length || !inspected?.timeline?.length) return candidate;
  const kind = reference.kind || reference.candidate?.timingReferenceKind;
  const alignment = alignTimelines(reference.timeline, inspected.timeline, { windows: reference.windows, kind });
  const exactReference = ["exact-hash", "embedded", "embedded-sample", "audio-whisper"].includes(kind);
  const reasons = [...candidate.reasons];
  let confidence = candidate.confidence;
  if (alignment.confidence >= 0.75) {
    confidence += exactReference ? 18 : 12;
    reasons.push("timing-reference");
  } else if (alignment.confidence >= 0.55) {
    confidence += exactReference ? 11 : 7;
    reasons.push("timing-reference");
  } else if (alignment.confidence >= 0.35) {
    confidence += exactReference ? 4 : 2;
    reasons.push("timing-reference-weak");
  } else if (exactReference && alignment.anchors >= 5 && alignment.inliers <= 1) {
    // The reference is the playing video itself and no consistent mapping
    // exists: almost always a different cut or a different episode.
    confidence -= 18;
    reasons.push("timing-mismatch");
  }
  return {
    ...candidate,
    reasons,
    confidence,
    timingScore: alignment.confidence,
    timingModel: alignment.model,
    timingScale: alignment.scale ?? 1,
    timingOffset: alignment.offset ?? 0,
    timingSegments: alignment.segments,
    timingAnchors: alignment.anchors,
    timingInliers: alignment.inliers,
    timingOutlierRatio: alignment.outlierRatio,
    timingError: alignment.medianError,
    timingReferenceKind: kind
  };
}

function finalize(candidate) {
  const reasons = candidate.reasons || [];
  const confidence = reasons.includes("exact-hash") ? 100 : Math.max(5, Math.min(99, Math.round(candidate.confidence)));
  const tier = reasons.includes("exact-hash") ? 4 : reasons.some((reason) => ["exact-release", "strong-release-match"].includes(reason)) ? 3 : confidence >= 70 ? 2 : 1;
  return { ...candidate, confidence, tier };
}

function presentationTier(candidate) {
  if (candidate.downloadFailed) return 0;
  if (candidate.reasons?.includes("exact-hash")) return 5;
  if ((candidate.timingScore || 0) >= 0.75) return 4;
  if (candidate.styled && candidate.confidence >= 65 && !candidate.reasons?.includes("timing-mismatch")) return 3;
  if (candidate.reasons?.some((reason) => ["exact-release", "strong-release-match"].includes(reason))) return 2;
  if (candidate.deepAnalyzed) return 2;
  return 1;
}

export function sortDeepCandidates(candidates) {
  return [...candidates].sort((a, b) =>
    presentationTier(b) - presentationTier(a) ||
    b.confidence - a.confidence ||
    Number(Boolean(b.styled)) - Number(Boolean(a.styled)) ||
    (b.styleStrength || 0) - (a.styleStrength || 0) ||
    b.syncScore - a.syncScore ||
    b.qualityScore - a.qualityScore ||
    `${a.provider}:${a.fileId}`.localeCompare(`${b.provider}:${b.fileId}`)
  );
}

function within(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("deep-analysis-timeout"), { name: "TimeoutError" })), Math.max(1, milliseconds));
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Downloads and inspects candidates within a time budget.
 *
 * Results per candidate:
 * - verified (deepAnalyzed: true) with format, styling, human-translation
 *   assessment and, when a reference timeline exists, an alignment model;
 * - rejected (dropped) when the file itself is wrong: not Arabic, machine
 *   translated, wrong episode, HTML, implausible duration. Rejections are
 *   remembered in `verdicts` so later requests do not download them again;
 * - pending (validationPending: true) when the download timed out or the
 *   provider was temporarily unavailable. Pending is never remembered.
 */
export async function deepAnalyzeCandidates(candidates, context, provider, cache, options = {}) {
  const limit = Math.min(candidates.length, Math.max(0, options.limit || 0));
  if (!limit || typeof provider.download !== "function") return candidates;
  const verdicts = options.verdicts;
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 18000);
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const stopTimer = setTimeout(() => controller.abort(Object.assign(new Error("deep-analysis-timeout"), { name: "TimeoutError" })), timeoutMs + 50);
  stopTimer.unref?.();

  // Pick across providers first so a slow provider cannot monopolise the budget.
  const selected = [];
  const selectedSet = new Set();
  const providers = new Set();
  for (const candidate of candidates) {
    const providerId = candidate.provider || "default";
    if (providers.has(providerId)) continue;
    selected.push(candidate);
    selectedSet.add(candidate);
    providers.add(providerId);
    if (selected.length >= limit) break;
  }
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (!selectedSet.has(candidate)) {
      selected.push(candidate);
      selectedSet.add(candidate);
    }
  }

  let reference = options.reference || null;
  if (!reference && options.loadReference !== false) {
    const referenceBudget = Math.min(4500, Math.max(500, (deadline - Date.now()) * 0.45));
    reference = await within(loadReference(context, provider, cache, { signal: controller.signal }), referenceBudget).catch(() => null);
  }
  const preferences = options.preferences || {};
  const results = new Array(selected.length);
  let cursor = 0;
  let downloadsStarted = 0;
  const workers = Array.from({ length: Math.min(options.concurrency || 10, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const candidate = selected[index];
      // Background runs step aside while a user is waiting for a listing: on
      // a fraction-of-a-CPU instance, parsing subtitles here starved the
      // event loop and the user's provider searches never completed.
      while (options.shouldPause?.() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (Date.now() >= deadline) {
        results[index] = { ...candidate, deepAnalyzed: false, validationPending: true };
        continue;
      }
      const remembered = verdicts ? await verdicts.get(verdictKey(candidate, context)).catch(() => undefined) : undefined;
      if (remembered && !remembered.ok) {
        results[index] = null;
        continue;
      }
      try {
        let inspected = null;
        const needsDownload = !remembered || (reference && options.syncWithReference !== false);
        // Downloading and parsing is CPU-heavy; inside a listing only a few
        // new files are inspected. Already-verified files cost nothing.
        if (needsDownload && Number.isFinite(options.maxDownloads)) {
          if (downloadsStarted >= options.maxDownloads) {
            results[index] = { ...candidate, deepAnalyzed: false, validationPending: true };
            continue;
          }
          downloadsStarted += 1;
        }
        if (needsDownload) {
          inspected = await within(loadNormalized(candidate, context, provider, cache, { signal: controller.signal }), deadline - Date.now());
        }
        let verdict = remembered;
        if (!verdict) {
          const assessment = assessSubtitle(inspected.buffer.toString("utf8"), {
            fileName: candidate.fileName,
            release: candidate.release,
            comment: candidate.comment,
            expectedDurationSeconds: options.expectedDurationSeconds,
            allowMachineTranslated: preferences.allowMachineTranslated,
            allowBilingual: preferences.allowBilingual !== false,
            metadataMachineTranslated: Boolean(candidate.machineTranslated || candidate.aiTranslated)
          });
          const tooLong = context.media.type === "series" && Number(options.maxSeriesSubtitleSeconds) > 0 &&
            inspected.analysis.durationSeconds > Number(options.maxSeriesSubtitleSeconds);
          verdict = verdictFrom(inspected, assessment, { tooLong });
          await verdicts?.set(verdictKey(candidate, context), verdict);
        }
        if (!verdict.ok) {
          results[index] = null;
          continue;
        }
        let analyzed = applyVerdict(candidate, verdict);
        if (inspected) analyzed = applyTiming(analyzed, inspected, reference);
        results[index] = finalize(analyzed);
        // Let pending network I/O run between CPU-heavy files in background mode.
        if (options.shouldPause) await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        if (isTransientError(error) || controller.signal.aborted) {
          results[index] = { ...candidate, deepAnalyzed: false, validationPending: true };
        } else {
          // The provider answered but the file is unusable (invalid format,
          // wrong episode in the archive, HTML page, not Arabic...). Keep it,
          // demoted and flagged, so it is never listed or used as a fallback.
          await verdicts?.set(verdictKey(candidate, context), { ok: false, reason: String(error?.message || error).slice(0, 160) });
          results[index] = {
            ...candidate,
            confidence: Math.max(5, candidate.confidence - 25),
            tier: 1,
            reasons: [...(candidate.reasons || []), "download-failed"],
            downloadFailed: true,
            deepAnalyzed: false
          };
        }
      }
    }
  });
  await Promise.all(workers);
  clearTimeout(stopTimer);
  controller.abort();
  const analyzed = [];
  for (let index = 0; index < selected.length; index += 1) {
    if (results[index] === null) continue;
    analyzed.push(results[index] || { ...selected[index], deepAnalyzed: false, validationPending: true });
  }
  // Identical files offered by several providers collapse into one result.
  const seenContent = new Set();
  const unique = sortDeepCandidates(analyzed).filter((candidate) => {
    if (!candidate.contentHash) return true;
    if (seenContent.has(candidate.contentHash)) return false;
    seenContent.add(candidate.contentHash);
    return true;
  });
  return sortDeepCandidates([...unique, ...candidates.filter((candidate) => !selectedSet.has(candidate))]);
}
