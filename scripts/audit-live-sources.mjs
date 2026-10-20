import { readConfig } from "../src/config.js";
import { normalizeSubtitle } from "../src/subtitle.js";
import { OpenSubtitlesProvider } from "../src/providers/opensubtitles.js";
import { SubDLProvider } from "../src/providers/subdl.js";
import { SubSourceProvider } from "../src/providers/subsource.js";
import { ArabicSubsProvider } from "../src/providers/arabicsubs.js";
import { WyzieProvider } from "../src/providers/wyzie.js";
import { TheSubtitleDbProvider } from "../src/providers/thesubtitledb.js";
import { Subf2mProvider } from "../src/providers/subf2m.js";
import { MoraProvider } from "../src/providers/mora.js";
import { SubKongProvider } from "../src/providers/subkong.js";
import { MiraiAnimeProvider } from "../src/providers/miraianime.js";
import { AniKotoProvider } from "../src/providers/anikoto.js";
import { StremioV3Provider } from "../src/providers/stremio-v3.js";

const config = readConfig();
const providers = [
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

const samples = [
  {
    name: "movie",
    context: { media: { type: "movie", id: "tt10872600", imdbId: "10872600", releaseTitle: "Spider Man No Way Home" }, extra: { filename: "Spider.Man.No.Way.Home.2021.1080p.BluRay.mkv" } }
  },
  {
    name: "series",
    context: { media: { type: "series", id: "tt3581920:1:1", imdbId: "3581920", season: 1, episode: 1, releaseTitle: "The Last of Us" }, extra: { filename: "The.Last.of.Us.S01E01.1080p.WEB-DL.mkv" } }
  },
  {
    name: "anime",
    context: { media: { type: "series", id: "tt0994314:1:1", imdbId: "0994314", season: 1, episode: 1, releaseTitle: "Code Geass" }, extra: { filename: "Code.Geass.S01E01.1080p.BluRay.mkv" } }
  }
];

async function audit(provider, sample) {
  const started = Date.now();
  try {
    const results = await provider.search(sample.context, 4);
    let verified = false;
    let error = "";
    for (const candidate of results.slice(0, 3)) {
      try {
        const downloaded = await provider.download(candidate.downloadRef ?? candidate.fileId);
        normalizeSubtitle(downloaded.buffer, {
          season: sample.context.media.season,
          episode: sample.context.media.episode,
          fileName: downloaded.fileName || candidate.fileName,
          fps: candidate.fps,
          outputExtension: "srt",
          preserveFormat: false,
          allowFormatMismatch: true
        });
        verified = true;
        error = "";
        break;
      } catch (downloadError) {
        error = downloadError?.message || String(downloadError);
      }
    }
    return { provider: provider.id, sample: sample.name, count: results.length, verified, error: results.length && !verified ? error : "", durationMs: Date.now() - started };
  } catch (error) {
    return { provider: provider.id, sample: sample.name, count: 0, verified: false, error: error?.message || String(error), durationMs: Date.now() - started };
  }
}

const rows = [];
for (const provider of providers) {
  for (const sample of samples) rows.push(await audit(provider, sample));
}
console.log(JSON.stringify(rows, null, 2));
