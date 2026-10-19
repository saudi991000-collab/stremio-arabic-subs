import { normalizeSubtitle } from "./subtitle.js";
import { compareSpeechActivity, compareTimelines, inspectStyling, parseTimeline } from "./timing.js";

export function normalizedSubtitleCacheKey({ provider, ref, season, episode }) {
  return `subtitle:v11:verified:${provider}:${ref}:${season || ""}:${episode || ""}`;
}

function subtitleCacheKey(candidate, context) {
  return normalizedSubtitleCacheKey({
    provider: candidate.provider,
    ref: candidate.downloadRef ?? candidate.fileId,
    season: context.media.season,
    episode: context.media.episode
  });
}

async function loadNormalized(candidate, context, provider, cache, requireArabic = true) {
  const key = subtitleCacheKey(candidate, context);
  let buffer = await cache.getFile(key);
  let normalized;
  if (buffer) {
    normalized = normalizeSubtitle(buffer, {
      season: context.media.season,
      episode: context.media.episode,
      fileName: candidate.fileName,
      requireArabic,
      preserveFormat: true,
      allowFormatMismatch: true
    });
  } else {
    const downloaded = await provider.download({
      provider: candidate.provider,
      ref: candidate.downloadRef ?? candidate.fileId,
      season: context.media.season,
      episode: context.media.episode
    });
    normalized = normalizeSubtitle(downloaded.buffer, {
      season: context.media.season,
      episode: context.media.episode,
      fileName: downloaded.fileName || candidate.fileName,
      requireArabic,
      preserveFormat: true,
      allowFormatMismatch: true
    });
    buffer = normalized.buffer;
    await cache.setFile(key, buffer);
  }
  const text = normalized.buffer.toString("utf8");
  return {
    candidate,
    buffer: normalized.buffer,
    extension: normalized.extension,
    analysis: normalized.analysis,
    timeline: parseTimeline(text),
    styling: inspectStyling(text, normalized.extension)
  };
}

async function loadReference(context, provider, cache) {
  if (!context.extra.videoHash || typeof provider.findTimingReference !== "function") return null;
  const candidate = await provider.findTimingReference(context);
  if (!candidate) return null;
  return loadNormalized(candidate, context, provider, cache, false);
}

function applyEvidence(candidate, inspected, reference) {
  const reasons = [...candidate.reasons];
  let confidence = candidate.confidence;
  let timing;
  if (reference?.timeline?.length) {
    timing = ["audio-whisper", "embedded-sample"].includes(reference.candidate?.timingReferenceKind)
      ? compareSpeechActivity(reference.timeline, inspected.timeline)
      : compareTimelines(reference.timeline, inspected.timeline);
    const exactReference = ["exact-hash", "embedded", "embedded-sample", "audio-whisper"].includes(reference.candidate?.timingReferenceKind);
    if (timing.score >= 0.82) {
      confidence += exactReference ? 18 : 12;
      reasons.push("timing-reference");
    } else if (timing.score >= 0.65) {
      confidence += exactReference ? 11 : 7;
      reasons.push("timing-reference");
    } else if (timing.score >= 0.45) {
      confidence += exactReference ? 5 : 2;
      reasons.push("timing-reference-weak");
    } else if (timing.score < (exactReference ? 0.25 : 0.15)) {
      confidence -= exactReference ? 18 : 9;
      reasons.push("timing-mismatch");
    }
  }
  if (inspected.styling.styled && !reasons.includes("timing-mismatch")) {
    confidence += Math.min(8, 3 + inspected.styling.strength);
    reasons.push("rich-styling");
  }
  if (candidate.reasons.includes("exact-hash")) confidence = 100;
  else confidence = Math.max(5, Math.min(99, Math.round(confidence)));
  const tier = candidate.reasons.includes("exact-hash") ? 4 : candidate.reasons.includes("exact-release") ? 3 : confidence >= 70 ? 2 : 1;
  return {
    ...candidate,
    reasons,
    confidence,
    tier,
    actualFormat: inspected.extension,
    styled: inspected.styling.styled,
    styleStrength: inspected.styling.strength,
    styleFeatures: inspected.styling.features,
    timingScore: timing?.score,
    timingError: timing?.medianError,
    timingScale: timing?.scale ?? 1,
    timingOffset: timing?.offset ?? 0,
    timingReferenceKind: reference?.candidate?.timingReferenceKind,
    deepAnalyzed: true
  };
}

function presentationTier(candidate) {
  if (candidate.downloadFailed) return 0;
  if (candidate.reasons?.includes("exact-hash")) return 5;
  if ((candidate.timingScore || 0) >= 0.82) return 4;
  if (candidate.styled && candidate.confidence >= 65 && !candidate.reasons?.includes("timing-mismatch")) return 3;
  if (candidate.reasons?.includes("exact-release")) return 2;
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
    String(a.fileId).localeCompare(String(b.fileId))
  );
}

export async function deepAnalyzeCandidates(candidates, context, provider, cache, options = {}) {
  const limit = Math.min(candidates.length, Math.max(0, options.limit || 0));
  if (!limit || typeof provider.download !== "function") return candidates;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 18000);
  const deadline = Date.now() + timeoutMs;
  const within = (promise, milliseconds) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deep-analysis-timeout")), Math.max(1, milliseconds));
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
  const referenceBudget = Math.min(6500, Math.max(1000, deadline - Date.now()));
  const reference = options.reference || await within(loadReference(context, provider, cache), referenceBudget).catch(() => null);
  const results = new Array(selected.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(5, selected.length) }, async () => {
    while (cursor < selected.length) {
      if (Date.now() >= deadline) return;
      const index = cursor;
      cursor += 1;
      const candidate = selected[index];
      try {
        const inspected = await within(loadNormalized(candidate, context, provider, cache, true), deadline - Date.now());
        if (
          context.media.type === "series" &&
          Number(options.maxSeriesSubtitleSeconds) > 0 &&
          inspected.analysis.durationSeconds > Number(options.maxSeriesSubtitleSeconds)
        ) {
          throw new Error("series-subtitle-duration-mismatch");
        }
        results[index] = applyEvidence(candidate, inspected, reference);
      } catch {
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
  });
  await Promise.all(workers);
  for (let index = 0; index < selected.length; index += 1) {
    if (!results[index]) results[index] = { ...selected[index], deepAnalyzed: false };
  }
  return sortDeepCandidates([...results, ...candidates.filter((candidate) => !selectedSet.has(candidate))]);
}
