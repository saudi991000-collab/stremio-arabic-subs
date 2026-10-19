import { readConfig } from "../src/config.js";
import { verifySubtitleToken } from "../src/token.js";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:7000").replace(/\/$/, "");
const config = readConfig();
const downloadSamples = Math.max(0, Math.min(4, Number.parseInt(process.env.BENCHMARK_DOWNLOADS || "0", 10) || 0));
const benchmarkFilter = String(process.env.BENCHMARK_FILTER || "").trim().toLowerCase();

const cases = [
  { category: "movie", title: "Oppenheimer", type: "movie", id: "tt15398776", filename: "Oppenheimer.2023.1080p.BluRay.x264.mkv" },
  { category: "movie", title: "Dune Part Two", type: "movie", id: "tt15239678", filename: "Dune.Part.Two.2024.1080p.WEB-DL.mkv" },
  { category: "movie", title: "Interstellar", type: "movie", id: "tt0816692", filename: "Interstellar.2014.1080p.BluRay.x264.mkv" },
  { category: "movie", title: "Parasite", type: "movie", id: "tt6751668", filename: "Parasite.2019.1080p.BluRay.x264.mkv" },
  { category: "movie", title: "The Shawshank Redemption", type: "movie", id: "tt0111161", filename: "The.Shawshank.Redemption.1994.1080p.BluRay.x264.mkv" },

  { category: "series", title: "Breaking Bad", type: "series", id: "tt0903747:1:1", filename: "Breaking.Bad.S01E01.1080p.BluRay.x264.mkv" },
  { category: "series", title: "Game of Thrones", type: "series", id: "tt0944947:1:1", filename: "Game.of.Thrones.S01E01.1080p.BluRay.x264.mkv" },
  { category: "series", title: "The Last of Us", type: "series", id: "tt3581920:1:1", filename: "The.Last.of.Us.S01E01.1080p.WEB-DL.mkv" },
  { category: "series", title: "Stranger Things", type: "series", id: "tt4574334:1:1", filename: "Stranger.Things.S01E01.1080p.NF.WEB-DL.mkv" },
  { category: "series", title: "Chernobyl", type: "series", id: "tt7366338:1:1", filename: "Chernobyl.S01E01.1080p.BluRay.mkv" },

  { category: "anime", title: "Attack on Titan", type: "series", id: "tt2560140:1:1", filename: "Attack.on.Titan.S01E01.1080p.BluRay.mkv" },
  { category: "anime", title: "Death Note", type: "series", id: "tt0877057:1:1", filename: "Death.Note.S01E01.1080p.BluRay.mkv" },
  { category: "anime", title: "Code Geass", type: "series", id: "tt0994314:1:8", filename: "Code.Geass.S01E08.1080p.BluRay.mkv" },
  { category: "anime", title: "Frieren", type: "series", id: "tt22248376:1:1", filename: "Frieren.Beyond.Journeys.End.S01E01.1080p.CR.WEB-DL.mkv" },
  { category: "anime", title: "Jujutsu Kaisen", type: "series", id: "tt12343534:1:1", filename: "Jujutsu.Kaisen.S01E01.1080p.CR.WEB-DL.mkv" },
  { category: "anime-kitsu", title: "Attack on Titan via Kitsu", type: "series", id: "kitsu:7442:1", filename: "Attack.on.Titan.S01E01.1080p.BluRay.mkv" },
  { category: "anime-kitsu", title: "One Punch Man via Kitsu", type: "series", id: "kitsu:10740:1", filename: "One.Punch.Man.S01E01.1080p.BluRay.mkv" },
  { category: "regression", title: "Smoking Behind the Supermarket E12", type: "series", id: "tt37614297:1:12", filename: "Smoking.Behind.the.Supermarket.with.You.S01E12.1080p.CR.WEB-DL.MULTi.AAC2.0.H.264.MSubs-ToonsHub.mkv", videoHash: "12e0b56d61931a66", videoSize: 1607369843 },
  { category: "regression", title: "Wednesday filename conflict", type: "series", id: "tt0877057:1:2", filename: "Wednesday.S01E02.Woe.is.the.Loneliest.Number.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-APEX.mkv" },
  { category: "regression", title: "Koori no Jouheki file episode 04", type: "series", id: "tt39123061:2:1", filename: "[NanakoRaws] Koori no Jouheki - 04 (AT-X 1080p HEVC AAC).mkv", videoHash: "52d8b24aad973a81", videoSize: 644029676 },
  { category: "regression", title: "The Apothecary Diaries E03", type: "series", id: "tt26743760:1:3", filename: "The.Apothecary.Diaries.S01E03.The.Unsettling.Matter.of.the.Spirit.1080p.BluRay.REMUX.AVC.FLAC.2.0-NAN0.mkv", videoHash: "a1e0726f9f5e202b", videoSize: 6085348173 },

  { category: "documentary", title: "Planet Earth II", type: "series", id: "tt5491994:1:1", filename: "Planet.Earth.II.S01E01.Islands.1080p.BluRay.mkv" },
  { category: "documentary", title: "Our Planet", type: "series", id: "tt9253866:1:1", filename: "Our.Planet.S01E01.1080p.NF.WEB-DL.mkv" },
  { category: "documentary", title: "The Last Dance", type: "series", id: "tt8420184:1:1", filename: "The.Last.Dance.S01E01.1080p.NF.WEB-DL.mkv" },
  { category: "documentary", title: "Free Solo", type: "movie", id: "tt7775622", filename: "Free.Solo.2018.1080p.BluRay.mkv" },
  { category: "documentary", title: "13th", type: "movie", id: "tt5895028", filename: "13th.2016.1080p.NF.WEB-DL.mkv" }
];

function listingUrl(item) {
  const extra = new URLSearchParams({
    filename: item.filename,
    ...(item.videoHash ? { videoHash: item.videoHash } : {}),
    ...(item.videoSize ? { videoSize: String(item.videoSize) } : {})
  }).toString();
  return `${baseUrl}/subtitles/${item.type}/${item.id}/${encodeURIComponent(extra)}.json`;
}

function tokenPayload(subtitleUrl) {
  const path = new URL(subtitleUrl).pathname;
  const match = path.match(/^\/subtitle\/(.+)\.(srt|vtt|ass|ssa)$/i);
  if (!match) throw new Error("Unexpected subtitle URL");
  return verifySubtitleToken(match[1], config.tokenSecret);
}

function isEpisodeEvidence(reasons = []) {
  return reasons.some((reason) => ["exact-hash", "exact-release", "episode-metadata", "episode-filename", "single-episode"].includes(reason));
}

async function runCase(item) {
  const started = performance.now();
  try {
    const response = await fetch(listingUrl(item), { signal: AbortSignal.timeout(15000) });
    const elapsedMs = Math.round(performance.now() - started);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
    const first = subtitles[0];
    const signed = first ? tokenPayload(first.url) : null;
    const primary = signed?.items?.[0] || null;
    const reasons = primary?.reasons || [];
    const aiMarker = subtitles.some((subtitle) => /(?:\bAI\b|machine|🤖)/iu.test(`${subtitle.label || ""} ${subtitle.id || ""}`));
    return {
      ...item,
      ok: true,
      elapsedMs,
      count: subtitles.length,
      label: first?.label || "—",
      format: primary?.extension?.toUpperCase() || "—",
      provider: primary?.provider || "—",
      confidence: primary?.confidence ?? null,
      episodeEvidence: item.type === "movie" ? true : isEpisodeEvidence(reasons),
      aiFree: !aiMarker,
      reasons,
      firstUrl: first?.url || ""
    };
  } catch (error) {
    return { ...item, ok: false, elapsedMs: Math.round(performance.now() - started), count: 0, label: "ERROR", format: "—", confidence: null, episodeEvidence: false, aiFree: false, reasons: [], firstUrl: "", error: error.message };
  }
}

async function mapLimited(items, limit, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function validateDownload(result) {
  const started = performance.now();
  try {
    const response = await fetch(result.firstUrl, { signal: AbortSignal.timeout(20000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString("utf8");
    const cueCount = (text.match(/-->|^Dialogue:/gim) || []).length;
    return {
      category: result.category,
      title: result.title,
      ok: response.ok && buffer.length > 50 && cueCount > 0 && /[\u0600-\u06ff]/u.test(text),
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      bytes: buffer.length,
      cues: cueCount,
      arabic: /[\u0600-\u06ff]/u.test(text)
    };
  } catch (error) {
    return { category: result.category, title: result.title, ok: false, status: 0, elapsedMs: Math.round(performance.now() - started), bytes: 0, cues: 0, arabic: false, error: error.message };
  }
}

const testCases = benchmarkFilter
  ? cases.filter((item) => `${item.category} ${item.title}`.toLowerCase().includes(benchmarkFilter))
  : cases;
console.log(`Benchmarking ${testCases.length} works against ${baseUrl} (concurrency: 2)`);
const cold = await mapLimited(testCases, 2, runCase);
console.table(cold.map((item) => ({
  category: item.category,
  title: item.title,
  ms: item.elapsedMs,
  count: item.count,
  first: item.label,
  format: item.format,
  provider: item.provider,
  episode: item.type === "movie" ? "n/a" : item.episodeEvidence ? "strong" : item.count ? "weak" : "none",
  ai: item.aiFree ? "none" : "check",
  status: item.ok ? "ok" : item.error
})));

const warmCases = benchmarkFilter ? testCases.slice(0, 4) : [cases[0], cases[5], cases[10], cases[15]];
const warm = await mapLimited(warmCases, 2, runCase);
const latencies = cold.filter((item) => item.ok).map((item) => item.elapsedMs);
const warmLatencies = warm.filter((item) => item.ok).map((item) => item.elapsedMs);
const withResults = cold.filter((item) => item.ok && item.count > 0);
const seriesWithResults = withResults.filter((item) => item.type === "series");

console.log("\nSummary");
console.table([{
  works: cold.length,
  successfulRequests: cold.filter((item) => item.ok).length,
  worksWithArabic: withResults.length,
  totalOptions: cold.reduce((sum, item) => sum + item.count, 0),
  p50ColdMs: percentile(latencies, 0.5),
  p95ColdMs: percentile(latencies, 0.95),
  maxColdMs: Math.max(0, ...latencies),
  p50WarmMs: percentile(warmLatencies, 0.5),
  strongEpisodeTop: `${seriesWithResults.filter((item) => item.episodeEvidence).length}/${seriesWithResults.length}`,
  aiMarkers: cold.filter((item) => !item.aiFree).length
}]);

if (downloadSamples > 0) {
  const chosen = [];
  if (benchmarkFilter) {
    chosen.push(...cold.filter((item) => item.firstUrl).slice(0, downloadSamples));
  } else {
    for (const category of ["movie", "series", "anime", "documentary"]) {
      const candidate = cold.find((item) => item.category === category && item.firstUrl);
      if (candidate) chosen.push(candidate);
      if (chosen.length >= downloadSamples) break;
    }
  }
  const downloads = [];
  for (const candidate of chosen) downloads.push(await validateDownload(candidate));
  console.log("\nDownloaded subtitle samples");
  console.table(downloads);
  if (downloads.some((item) => !item.ok)) process.exitCode = 1;
}

if (cold.some((item) => !item.ok || !item.aiFree) || seriesWithResults.some((item) => !item.episodeEvidence)) process.exitCode = 1;
