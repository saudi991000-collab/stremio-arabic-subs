import { normalizeName, parseReleaseName, titlesLikelyMatch } from "./media.js";

function same(a, b) {
  return a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
}

function compatibleSource(a, b) {
  if (same(a, b)) return true;
  return new Set([a, b]).size === 2 && [a, b].every((value) => value === "remux" || value === "bluray");
}

function logarithmicPopularity(downloads) {
  if (!Number.isFinite(downloads) || downloads <= 0) return 0;
  return Math.min(2, Math.log10(downloads + 1) / 3);
}

function episodeReleaseKind(value, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return "unknown";
  const raw = String(value);
  const text = normalizeName(raw);
  const seasonText = `0*${season}`;
  const episodeText = `0*${episode}`;
  const explicitEpisode = [
    new RegExp(`\\bs${seasonText} +(?:e|ep|episode) *${episodeText}\\b`, "i"),
    new RegExp(`\\b${seasonText} *x *${episodeText}\\b`, "i"),
    new RegExp(`\\b(?:episode|ep|e) *${episodeText}\\b`, "i"),
    new RegExp(`(?:^| )0*${episode}(?:v\\d+)?(?: |$)`, "i")
  ].some((pattern) => pattern.test(text));
  if (explicitEpisode) return "episode";

  const seasonPack = [
    new RegExp(`\\b(?:season|s) *${seasonText}\\b`, "i"),
    /\bcomplete\b/i,
    /\b\d{1,3} *(?:to|through) *\d{1,3}\b/i,
    /\b\d{1,3}\s*[-~]\s*\d{1,3}\b/i
  ].some((pattern) => pattern.test(text));
  if (/\b\d{1,3}\s*[-~]\s*\d{1,3}\b/i.test(raw)) return "pack";
  return seasonPack ? "pack" : "unknown";
}

export function scoreCandidate(candidate, context, preferences = {}) {
  const wanted = parseReleaseName(context.extra.filename);
  const actual = parseReleaseName(candidate.fileName || candidate.release || "");
  const details = candidate.featureDetails || {};

  const candidateSeason = details.seasonNumber ?? actual.season;
  const candidateEpisode = details.episodeNumber ?? actual.episode;
  if (context.media.type === "series") {
    if (candidateSeason != null && Number(candidateSeason) !== context.media.season) return null;
    if (candidateEpisode != null && Number(candidateEpisode) !== context.media.episode) return null;
  }
  if (wanted.year && details.year && Number(details.year) !== wanted.year) return null;
  if (wanted.edition && actual.edition && wanted.edition !== actual.edition) return null;
  if (candidate.language && !/^ar(a|abic)?$/i.test(candidate.language)) return null;
  if ((candidate.machineTranslated || candidate.aiTranslated) && !preferences.allowMachineTranslated) return null;
  const titleMatch = Boolean(wanted.title && actual.title && titlesLikelyMatch(context.extra.filename, candidate.fileName || candidate.release || ""));
  if (!context.media.imdbId && wanted.title && actual.title && !titleMatch) return null;

  let syncScore = 0;
  let qualityScore = 0;
  const reasons = [];
  const exactHash = Boolean(candidate.hashMatch && context.extra.videoHash);

  if (exactHash) {
    syncScore += 1000;
    reasons.push("exact-hash");
  }

  const wantedName = normalizeName(context.extra.filename);
  const actualName = normalizeName(candidate.fileName || candidate.release || "");
  const releaseKind = context.media.type === "series"
    ? episodeReleaseKind(candidate.fileName || candidate.release || "", context.media.season, context.media.episode)
    : "unknown";
  const exactRelease = wantedName && actualName && wantedName === actualName;
  if (exactRelease) {
    syncScore += 300;
    reasons.push("exact-release");
  }
  if (titleMatch) {
    syncScore += 85;
    reasons.push("same-title");
  }
  if (wanted.source && actual.source && compatibleSource(wanted.source, actual.source)) {
    syncScore += same(wanted.source, actual.source) ? 90 : 75;
    reasons.push(same(wanted.source, actual.source) ? "same-source" : "compatible-source");
  }
  if (same(wanted.platform, actual.platform)) {
    syncScore += 100;
    reasons.push("same-platform");
  }
  if (same(wanted.group, actual.group)) {
    syncScore += 80;
    reasons.push("same-group");
  }
  if (same(wanted.edition, actual.edition)) syncScore += 55;
  if (same(wanted.resolution, actual.resolution)) syncScore += 8;
  if (same(wanted.videoCodec, actual.videoCodec)) syncScore += 5;
  if (same(wanted.audioCodec, actual.audioCodec)) syncScore += 4;
  if (wanted.fps && candidate.fps && Math.abs(wanted.fps - candidate.fps) < 0.02) {
    syncScore += 120;
    reasons.push("same-fps");
  }
  if (releaseKind === "episode") {
    syncScore += 140;
    reasons.push("single-episode");
  } else if (releaseKind === "pack") {
    syncScore -= 60;
    reasons.push("season-pack");
  }
  if (candidate.fromTrusted) qualityScore += 5;
  qualityScore += Math.min(5, Math.max(0, Number(candidate.rating) || 0) / 2);
  qualityScore += logarithmicPopularity(Number(candidate.downloadCount));
  if (candidate.aiTranslated) qualityScore -= 12;
  if (candidate.machineTranslated) qualityScore -= 20;
  if (candidate.hearingImpaired === preferences.preferHearingImpaired) qualityScore += 2;
  if (/\.(ass|ssa)(?:$|[?#])/i.test(candidate.fileName || candidate.release || "")) {
    qualityScore += 4;
    reasons.push("styled-format");
  }

  const metadataEpisodeMatch = context.media.type === "series" && Number(details.episodeNumber) === context.media.episode;
  const filenameEpisodeMatch = context.media.type === "series" && actual.episode === context.media.episode;
  const episodeEvidence = metadataEpisodeMatch || filenameEpisodeMatch || releaseKind === "episode";
  let confidence = context.media.type === "series" ? 25 : 45;
  if (metadataEpisodeMatch && filenameEpisodeMatch) {
    confidence += 35;
    reasons.push("episode-metadata");
  } else if (metadataEpisodeMatch) {
    confidence += 28;
    reasons.push("episode-metadata");
  } else if (filenameEpisodeMatch || releaseKind === "episode") {
    confidence += 30;
    if (filenameEpisodeMatch && releaseKind !== "episode") reasons.push("episode-filename");
  }
  if (actual.season === context.media.season) confidence += 5;
  if (titleMatch) confidence += 18;
  if (candidate.catalogMatch && (context.media.type === "movie" || episodeEvidence)) {
    syncScore += 40;
    confidence += context.media.type === "movie" ? 25 : 15;
    reasons.push("catalog-match");
  }
  if (wanted.source && actual.source && compatibleSource(wanted.source, actual.source)) confidence += same(wanted.source, actual.source) ? 18 : 15;
  if (same(wanted.platform, actual.platform)) confidence += 20;
  if (same(wanted.group, actual.group)) confidence += 18;
  if (wanted.fps && candidate.fps && Math.abs(wanted.fps - candidate.fps) < 0.02) confidence += 18;
  if (same(wanted.edition, actual.edition)) confidence += 7;
  if (same(wanted.resolution, actual.resolution)) confidence += 3;
  if (same(wanted.videoCodec, actual.videoCodec)) confidence += 2;
  if (same(wanted.audioCodec, actual.audioCodec)) confidence += 2;
  if (releaseKind === "pack") confidence -= 25;
  if (context.media.type === "series" && !episodeEvidence) confidence = Math.min(confidence, 45);
  if (releaseKind === "pack") confidence = Math.min(confidence, 45);

  let tier = confidence >= 70 ? 2 : 1;
  if (exactHash) {
    tier = 4;
    confidence = 100;
  } else if (exactRelease) {
    tier = 3;
    confidence = 98;
  }
  confidence = Math.max(5, Math.min(100, Math.round(confidence)));

  return { ...candidate, score: syncScore + qualityScore, syncScore, qualityScore, tier, confidence, reasons };
}

export function rankCandidates(candidates, context, preferences = {}) {
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, context, preferences))
    .filter(Boolean)
    .sort((a, b) => b.tier - a.tier || b.confidence - a.confidence || b.syncScore - a.syncScore || b.qualityScore - a.qualityScore || String(a.fileId).localeCompare(String(b.fileId)));

  const seen = new Set();
  return scored.filter((candidate) => {
    const key = `${normalizeName(candidate.fileName || candidate.release)}:${candidate.fileSize || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resultLabel(candidate, options = {}) {
  const format = candidate.actualFormat || String(candidate.fileName || candidate.release || "")
    .match(/\.(srt|vtt|ass|ssa)(?:$|[?#])/i)?.[1]?.toLowerCase();
  const styled = candidate.styled || format === "ass" || format === "ssa";
  const prefix = styled ? "💪 " : "";
  if (candidate.reasons?.includes("season-pack")) return `${prefix}▦ حزمة احتياطية`;
  if (candidate.confidence < 70) return `${prefix}○ احتياطية`;
  if (candidate.reasons?.includes("exact-hash") || Number(candidate.timingScore) >= 0.65) return `${prefix}✅ موثوقة`;
  if (options.recommended && candidate.confidence >= 70 && !candidate.reasons.includes("season-pack")) return `${prefix}👍 موثوقة`;
  return `${prefix}✓ موثوقة`;
}
