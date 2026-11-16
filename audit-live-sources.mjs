// Live audit of every configured provider: search, download and inspect real
// files. Run with: node --env-file-if-exists=.env scripts/audit-live-sources.mjs
// Optional: AUDIT_PROVIDERS=subdl,yifysubtitles  AUDIT_DOWNLOADS=3
import { readConfig } from "../src/config.js";
import { buildProviders } from "../src/server.js";
import { normalizeSubtitle } from "../src/subtitle.js";
import { assessSubtitle } from "../src/quality.js";
import { rankCandidates } from "../src/ranker.js";

const config = readConfig();
const only = new Set(String(process.env.AUDIT_PROVIDERS || "").split(",").map((item) => item.trim()).filter(Boolean));
const downloadsPerSample = Number(process.env.AUDIT_DOWNLOADS || 3);
const providers = buildProviders(config).filter((provider) => !only.size || only.has(provider.id));

const samples = [
  {
    name: "movie",
    context: { media: { type: "movie", id: "tt10872600", imdbId: "10872600", releaseTitle: "Spider Man No Way Home" }, extra: { filename: "Spider.Man.No.Way.Home.2021.1080p.BluRay.x264-SPARKS.mkv" } }
  },
  {
    name: "series",
    context: { media: { type: "series", id: "tt3581920:1:1", imdbId: "3581920", season: 1, episode: 1, releaseTitle: "The Last of Us" }, extra: { filename: "The.Last.of.Us.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv" } }
  },
  {
    name: "anime",
    context: { media: { type: "series", id: "tt0994314:1:1", imdbId: "0994314", season: 1, episode: 1, releaseTitle: "Code Geass" }, extra: { filename: "Code.Geass.S01E01.1080p.BluRay.mkv" } }
  }
];

async function audit(provider, sample) {
  const started = Date.now();
  try {
    const results = await provider.search(sample.context, 2, { signal: AbortSignal.timeout(20000) });
    const ranked = rankCandidates(results, sample.context, config);
    const checked = [];
    for (const candidate of ranked.slice(0, downloadsPerSample)) {
      try {
        const downloaded = await provider.download(candidate.downloadRef ?? candidate.fileId, { signal: AbortSignal.timeout(20000) });
        const normalized = normalizeSubtitle(downloaded.buffer, {
          season: sample.context.media.season,
          episode: sample.context.media.episode,
          fileName: downloaded.fileName || candidate.fileName,
          fps: candidate.fps,
          preserveFormat: false,
          allowFormatMismatch: true
        });
        const quality = assessSubtitle(normalized.buffer.toString("utf8"), { fileName: candidate.fileName, release: candidate.release, comment: candidate.comment });
        checked.push({ ok: quality.accepted, verdict: quality.verdict, format: normalized.extension, encoding: normalized.encoding, cues: quality.cueCount, arabic: Number(quality.arabicRatio.toFixed(2)) });
      } catch (error) {
        checked.push({ ok: false, error: String(error?.message || error).slice(0, 120) });
      }
    }
    return {
      provider: provider.id,
      sample: sample.name,
      found: results.length,
      afterRanking: ranked.length,
      verifiedDownloads: checked.filter((item) => item.ok).length,
      checked,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return { provider: provider.id, sample: sample.name, found: 0, error: String(error?.message || error).slice(0, 160), durationMs: Date.now() - started };
  }
}

const rows = [];
for (const provider of providers) {
  for (const sample of samples) rows.push(await audit(provider, sample));
}
console.log(JSON.stringify(rows, null, 2));
