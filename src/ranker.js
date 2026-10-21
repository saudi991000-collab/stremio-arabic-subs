import { normalizeName, parseReleaseName, titleSimilarity, titleTokens, titlesLikelyMatch } from "./media.js";
import { findArabicTeam } from "./teams.js";
import { explicitMachineLabel } from "./quality.js";

const NON_FEATURE_CONTENT = [
  /(?:^|[^a-z])(?:cinematic[ ._-]*)?(?:playthrough|walkthrough|gameplay|let'?s[ ._-]*play)(?:[^a-z]|$)/i,
  /(?:^|[^a-z])(?:official[ ._-]*)?(?:trailer|teaser)(?:[^a-z]|$)/i,
  /(?:^|[^a-z])(?:featurette|bloopers?|gag[ ._-]*reel|deleted[ ._-]*scenes?|behind[ ._-]*the[ ._-]*scenes|making[ ._-]*of|inside[ ._-]*the[ ._-]*episode)(?:[^a-z]|$)/i
];

// Share of title tokens matched, taking the better of the two directions.
export function titleCoverage(left, right) {
  const a = [...new Set(titleTokens(left))];
  const b = [...new Set(titleTokens(right))];
  if (!a.length || !b.length) return 1;
  const shared = titleSimilarity(left, right) * Math.min(a.length, b.length);
  return Math.max(shared / a.length, shared / b.length);
}

// These sources all serve the same OpenSubtitles catalogue. An identical file
// name from several of them is one subtitle, not several choices.
const OPENSUBTITLES_FAMILY = new Set(["opensubtitles", "opensubtitles-org", "stremio-v3"]);
const FAMILY_PREFERENCE = ["opensubtitles-org", "stremio-v3", "opensubtitles", "wyzie", "subkong"];
function familyKey(candidate) {
  const origin = String(candidate.origin || "").toLowerCase();
  const family = OPENSUBTITLES_FAMILY.has(candidate.provider) || /opensubtitles/.test(origin);
  return family ? `os:${normalizeName(candidate.fileName || candidate.release)}` : "";
}

// Team definitions live in config/arabic-teams.json.
export function arabicFansubTeam(candidate = {}) {
  return findArabicTeam(candidate);
}

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
  // Anime files are often numbered absolutely ("Title - 1085") while Stremio
  // asks for S21E13. Accept the absolute number only when it is known for the
  // requested episode and the file carries no conflicting season.
  const absoluteMatch = context.media.type === "series" && Number.isInteger(context.media.absoluteEpisode) &&
    details.episodeNumber == null && actual.season == null &&
    (actual.absoluteEpisode === context.media.absoluteEpisode || actual.episode === context.media.absoluteEpisode) &&
    context.media.absoluteEpisode !== context.media.episode;
  if (context.media.type === "series" && !absoluteMatch) {
    if (candidateSeason != null && Number(candidateSeason) !== context.media.season) return null;
    if (candidateEpisode != null && Number(candidateEpisode) !== context.media.episode) return null;
    // Provider catalogues sometimes attach other seasons' files to an episode
    // ("Code Geass R2 - 01" under S01E01). An explicit season/episode in the
    // filename that contradicts the request wins over the metadata.
    if (!candidate.hashMatch) {
      if (actual.season != null && actual.season !== context.media.season) return null;
      if (actual.episode != null && actual.season != null && actual.episode !== context.media.episode &&
        !new RegExp(`e0*${context.media.episode}(?!\\d)`, "i").test(candidate.fileName || candidate.release || "")) return null;
    }
    if (actual.absoluteEpisode != null && actual.season == null && details.episodeNumber == null &&
      actual.absoluteEpisode !== context.media.episode && actual.absoluteEpisode !== context.media.absoluteEpisode) return null;
  }
  // Movies: release years differ by one surprisingly often (festival vs. wide
  // release), but a larger gap means a different film (remake, sequel).
  const yearTolerance = context.media.type === "movie" ? 1 : 0;
  if (wanted.year && details.year && Math.abs(Number(details.year) - wanted.year) > yearTolerance) return null;
  if (wanted.year && actual.year && context.media.type === "movie" && Math.abs(actual.year - wanted.year) > 1) return null;
  if (wanted.edition && actual.edition && wanted.edition !== actual.edition) return null;
  if (candidate.language && !/^ar(a|abic)?$/i.test(candidate.language)) return null;
  if (candidate.flaggedBad) return null;
  const labelledMachine = explicitMachineLabel(candidate.fileName, candidate.release, candidate.comment);
  if ((candidate.machineTranslated || candidate.aiTranslated || labelledMachine) && !preferences.allowMachineTranslated) return null;
  const candidateName = candidate.fileName || candidate.release || "";
  // Without a filename (common for debrid/HTTP streams) match against the
  // catalogue titles instead: Kitsu's romaji title and Cinemeta's English one.
  const titleReferences = [context.extra.filename, context.media.title, context.media.catalogTitle, context.media.releaseTitle]
    .filter((value) => value && titleTokens(value).length);
  const titleMatch = Boolean(actual.title && titleReferences.some((reference) => titlesLikelyMatch(reference, candidateName)));
  if (!context.media.imdbId && wanted.title && actual.title && !titleMatch) return null;
  // Extras and unrelated media filed under the same id: game playthroughs,
  // trailers, featurettes, "making of"...
  const extraContent = NON_FEATURE_CONTENT.find((pattern) => pattern.test(candidateName) && !pattern.test(context.extra.filename || ""));
  if (extraContent && !candidate.hashMatch) return null;
  // A release-style name ("Lost.S01E01.1080p...") whose title shares nothing
  // with the playing file or the catalogue title belongs to another work.
  // Coverage is checked in both directions: "Blood-C: The Last Dark" or "The
  // Last Days of Ptolemy Grey" share one word with "The Last of Us" but cover
  // neither title well enough to be the same work.
  // One English catalogue title alone is not enough to reject: anime files
  // are usually named by their romaji title ("Boku no Kokoro no Yabai Yatsu"
  // for "The Dangers in My Heart").
  const enoughTitles = Boolean(context.extra.filename) || titleReferences.length >= 2;
  if (enoughTitles && !candidate.hashMatch && actual.title && (actual.season != null || actual.year || actual.absoluteEpisode != null) && titleTokens(candidateName).length) {
    if (titleReferences.length && titleReferences.every((name) => titleCoverage(name, candidateName) < 0.6)) return null;
  }

  let syncScore = 0;
  let qualityScore = 0;
  const reasons = [];
  if (context.media.type === "series") reasons.push("series");
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
  if (arabicFansubTeam(candidate)) {
    qualityScore += 6;
    reasons.push("arabic-fansub");
  }
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
  const filenameEpisodeMatch = context.media.type === "series" && (actual.episode === context.media.episode || absoluteMatch);
  // Some providers scope their API request to the exact season and episode but
  // return generic filenames (for example, "Arabic.srt"). Treat the scoped API
  // result as episode evidence instead of requiring the episode number to be
  // repeated in the subtitle filename.
  const scopedEpisodeMatch = context.media.type === "series" && candidate.episodeScoped === true;
  const episodeEvidence = metadataEpisodeMatch || filenameEpisodeMatch || releaseKind === "episode" || scopedEpisodeMatch;
  if (episodeEvidence) reasons.push("episode-evidence");
  if (absoluteMatch) reasons.push("absolute-episode");
  const releaseSignals = [
    wanted.source && actual.source && compatibleSource(wanted.source, actual.source),
    same(wanted.platform, actual.platform),
    same(wanted.group, actual.group),
    wanted.fps && candidate.fps && Math.abs(wanted.fps - candidate.fps) < 0.02,
    same(wanted.edition, actual.edition)
  ].filter(Boolean).length;
  const strongReleaseMatch = Boolean(
    titleMatch &&
    (context.media.type === "movie" || episodeEvidence) &&
    (exactRelease || releaseSignals >= 1 || same(wanted.resolution, actual.resolution))
  );
  if (strongReleaseMatch && !reasons.includes("exact-release")) {
    syncScore += 160;
    reasons.push("strong-release-match");
  }
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
  } else if (scopedEpisodeMatch) {
    confidence += 35;
    reasons.push("episode-catalog");
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
  } else if (exactRelease || strongReleaseMatch) {
    tier = 3;
    confidence = exactRelease ? 98 : Math.max(confidence, 92);
  }
  confidence = Math.max(5, Math.min(100, Math.round(confidence)));

  return { ...candidate, score: syncScore + qualityScore, syncScore, qualityScore, tier, confidence, reasons };
}

export function rankCandidates(candidates, context, preferences = {}) {
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, context, preferences))
    .filter(Boolean)
    .sort((a, b) => b.tier - a.tier || b.confidence - a.confidence || b.syncScore - a.syncScore || b.qualityScore - a.qualityScore || stableKey(a).localeCompare(stableKey(b)));

  // Only collapse identical names from the same provider here. Two providers
  // often carry different translations under the same release name; true
  // duplicates are removed later by comparing the downloaded content.
  const seen = new Set();
  const unique = scored.filter((candidate) => {
    const key = `${candidate.provider || "default"}:${normalizeName(candidate.fileName || candidate.release)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Keep one copy per OpenSubtitles-catalogue file, preferring the mirror
  // without a daily download quota; a hash match always wins.
  const best = new Map();
  for (const candidate of unique) {
    const key = familyKey(candidate);
    if (!key) continue;
    const current = best.get(key);
    const rank = (item) => (item.hashMatch ? -10 : 0) + (FAMILY_PREFERENCE.indexOf(item.provider) + 1 || 9);
    if (!current || rank(candidate) < rank(current)) best.set(key, candidate);
  }
  return unique.filter((candidate) => {
    const key = familyKey(candidate);
    return !key || best.get(key) === candidate;
  });
}

export function stableKey(candidate) {
  return `${candidate.provider || "default"}:${String(candidate.downloadRef ?? candidate.fileId)}`;
}

// 💪👍 means "this subtitle's release name matches the playing video". It is
// given to every qualifying result, not only the first one:
// exact hash, exact release name, a strong release match (title + episode +
// platform/source/group/resolution), or the same title with confirmed episode
// evidence for a series. A season pack or a timing mismatch never qualifies.
export function releaseMatched(candidate) {
  const reasons = candidate.reasons || [];
  if (reasons.includes("season-pack") || reasons.includes("timing-mismatch")) return reasons.includes("exact-hash");
  if (reasons.some((reason) => ["exact-hash", "exact-release", "strong-release-match"].includes(reason))) return true;
  return reasons.includes("same-title") && (!reasons.includes("series") || reasons.includes("episode-evidence"));
}

export function resultLabel(candidate) {
  return releaseMatched(candidate) ? "💪👍" : "";
}
