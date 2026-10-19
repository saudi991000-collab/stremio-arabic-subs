import { readConfig } from "../src/config.js";
import { MultiProvider } from "../src/providers/multi.js";
import { OpenSubtitlesProvider } from "../src/providers/opensubtitles.js";
import { SubDLProvider } from "../src/providers/subdl.js";
import { SubSourceProvider } from "../src/providers/subsource.js";
import { ArabicSubsProvider } from "../src/providers/arabicsubs.js";
import { StremioV3Provider } from "../src/providers/stremio-v3.js";
import { alignMediaToFilename, resolveVideoId } from "../src/id-resolver.js";
import { rankCandidates } from "../src/ranker.js";

const config = readConfig();
const providers = [
  ...(config.openSubtitles.apiKey ? [new OpenSubtitlesProvider(config.openSubtitles)] : []),
  ...(config.subdl.apiKey ? [new SubDLProvider(config.subdl)] : []),
  ...(config.subsource.apiKey ? [new SubSourceProvider(config.subsource)] : []),
  ...(config.arabicSubs.apiKey ? [new ArabicSubsProvider(config.arabicSubs)] : []),
  new StremioV3Provider()
];
const [type = "series", id = "tt0994314:1:8", filename = "[neovzn] Code Geass Lelouch of the Rebellion - S01E08v2 (BD Remux 1080p FLAC).mkv", videoHash = "", videoSize = ""] = process.argv.slice(2);
const extra = {
  videoHash,
  videoSize: Number(videoSize) || undefined,
  filename
};
const media = await alignMediaToFilename(await resolveVideoId(type, id), extra);
const context = {
  media,
  extra
};
const candidates = await new MultiProvider(providers).search(context, config.maxSearchPages);
const ranked = rankCandidates(candidates, context, config);
const reference = await new MultiProvider(providers).findTimingReference(context).catch(() => null);
console.log("English timing reference:", reference ? {
  kind: reference.timingReferenceKind,
  score: reference.timingReferenceReleaseScore,
  file: reference.fileName
} : "none");
console.log("Resolved media:", {
  id: media.id,
  imdbId: media.imdbId || "filename-only",
  season: media.season,
  episode: media.episode,
  identityMismatch: Boolean(media.identityMismatch),
  numberingAdjusted: Boolean(media.numberingAdjusted)
});
console.table(ranked.slice(0, 30).map((item) => ({
  provider: item.provider,
  confidence: item.confidence,
  sync: item.syncScore,
  quality: item.qualityScore.toFixed(1),
  reasons: item.reasons.join(","),
  file: String(item.fileName || item.release || "").slice(0, 100)
})));
