const SOURCE_ALIASES = [
  ["remux", [/\bbd\s*remux\b/, /\bblu\s*ray\s*remux\b/, /\bremux\b/]],
  ["bluray", [/\bblu\s*ray\b/, /\bbluray\b/, /\bbd\s*rip\b/, /\bbdrip\b/, /\bbd\b/]],
  ["web-dl", [/\bweb\s*dl\b/, /\bwebdl\b/]],
  ["webrip", [/\bweb\s*rip\b/, /\bwebrip\b/]],
  ["hdtv", [/\bhdtv\b/]],
  ["dvdrip", [/\bdvd\s*rip\b/, /\bdvdrip\b/]]
];
const EDITIONS = ["extended", "directors cut", "director's cut", "imax", "theatrical", "unrated"];
// Only genuine release markers. "CR" and "MAX" are matched as whole tokens
// next to a web source (e.g. "CR WEB-DL", "MAX.WEB-DL") because both appear as
// ordinary words in titles.
const PLATFORMS = [
  ["netflix", ["netflix", "nf"]],
  ["crunchyroll", ["crunchyroll", "cr web", "cr webrip", "cr webdl", "cr web dl"]],
  ["amazon", ["amazon", "amzn"]],
  ["max", ["hmax", "hbomax", "max web", "max webrip", "max web dl"]],
  ["disney", ["disney", "dsnp", "dsny"]],
  ["hulu", ["hulu"]],
  ["apple-tv", ["atvp", "apple tv"]],
  ["paramount", ["pmtp", "paramount"]],
  ["peacock", ["pcok", "peacock"]],
  ["shahid", ["shahid"]],
  ["osn", ["osn", "osnplus"]],
  ["hidive", ["hidive", "hidi"]]
];
const TITLE_STOP_WORDS = new Set(["the", "a", "an", "and", "of", "in", "on", "to", "with", "no", "de"]);

export function normalizeName(value = "") {
  return value
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function releaseTitle(value = "") {
  let stem = String(value)
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:mkv|mp4|avi|mov|srt|vtt|ass|ssa|zip|gz)$/i, "")
    .replace(/^\s*\[[^\]]+\]\s*/, "");
  const boundaries = [
    /\s[-–—]\s*0*\d{1,3}(?:v\d+)?(?:\s|\[|\(|$)/i,
    /(?:^|[ ._-])s\d{1,2}[ ._-]*(?:e|ep|episode)[ ._-]*\d{1,3}/i,
    /(?:^|[ ._-])\d{1,2}x\d{1,3}/i,
    /(?:^|[ ._-])(?:episode|ep|e)[ ._-]*\d{1,3}/i,
    /(?:^|[ ._-])(?:19\d{2}|20\d{2})(?:[ ._-]|$)/i,
    /(?:^|[ ._-])(?:2160p|1080p|720p|480p|web[ ._-]*dl|webrip|blu[ ._-]*ray|bluray|remux|hdtv)(?:[ ._-]|$)/i
  ];
  const indexes = boundaries.map((pattern) => stem.search(pattern)).filter((index) => index >= 0);
  if (indexes.length) stem = stem.slice(0, Math.min(...indexes));
  // Do not use normalizeName() here: its extension stripping removed the last
  // word of every title ("The.Last.of.Us" -> "the last of").
  return stem.replace(/[\[\](){}]/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function titleTokens(value = "") {
  return releaseTitle(value).split(" ").filter((token) => token.length >= 2 && !TITLE_STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function tokenLikelyMatches(left, right) {
  if (left === right) return true;
  const longest = Math.max(left.length, right.length);
  if (longest < 5 || Math.abs(left.length - right.length) > 2) return false;
  return editDistance(left, right) <= Math.max(1, Math.floor(longest * 0.18));
}

export function titleSimilarity(left, right) {
  const a = [...new Set(titleTokens(left))];
  const b = [...new Set(titleTokens(right))];
  if (!a.length || !b.length) return 0;
  const used = new Set();
  let shared = 0;
  for (const token of a) {
    const index = b.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && tokenLikelyMatches(token, candidate));
    if (index >= 0) {
      used.add(index);
      shared += 1;
    }
  }
  return shared / Math.max(1, Math.min(a.length, b.length));
}

export function titlesLikelyMatch(left, right) {
  return titleSimilarity(left, right) >= 0.45;
}

function firstMatch(text, regex, group = 1) {
  const match = text.match(regex);
  return match ? match[group]?.toLowerCase() : undefined;
}

export function parseReleaseName(filename = "") {
  const normalized = normalizeName(filename);
  const seasonEpisode = filename.match(/s(\d{1,2})[ ._-]*(?:ep?|episode)[ ._-]*0*(\d{1,3})/i) || filename.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  const releaseSeason = filename.match(/(?:^|[^a-z0-9])r([12])(?:[^a-z0-9]|$)/i);
  const labeledEpisode = filename.match(/(?:^|[^a-z0-9])(?:episode|ep|e)[ ._-]*0*(\d{1,3})(?:v\d+)?(?:[^a-z0-9]|$)/i);
  const separatedEpisode = filename.match(/(?:\s[-–—]\s*|[_-])0*(\d{1,3})(?:v\d+)?(?=\s*(?:[._\s-]|\[|\(|$))/i);
  const episode = seasonEpisode ? Number(seasonEpisode[2]) : Number(labeledEpisode?.[1] || separatedEpisode?.[1]) || undefined;
  const season = seasonEpisode ? Number(seasonEpisode[1]) : Number(releaseSeason?.[1]) || undefined;
  const source = SOURCE_ALIASES.find(([, aliases]) => aliases.some((pattern) => pattern.test(normalized)))?.[0];
  const edition = EDITIONS.find((item) => normalized.includes(item.replace("'", "")));
  const platform = PLATFORMS.find(([, aliases]) => aliases.some((alias) => new RegExp(`(^| )${alias.replace(" ", " +")}( |$)`).test(normalized)))?.[0];
  const suffixGroup = filename.match(/-([A-Za-z0-9]+)(?:\.[A-Za-z0-9]{2,4})?$/)?.[1];
  const prefixGroup = filename.match(/^\s*\[([^\]]+)\]/)?.[1];
  // Absolute anime numbering ("[Group] Title - 1085 [1080p]") without a season.
  const absoluteMatch = !seasonEpisode && filename.match(/(?:\s[-–—]\s*|\s(?:ep?|episode)\s*)0*(\d{1,4})(?:v\d+)?(?=\s*(?:\[|\(|$|\.[a-z0-9]{2,4}$|\s))/i);
  const absoluteEpisode = absoluteMatch && !/^(?:19|20)\d{2}$/.test(absoluteMatch[1]) ? Number(absoluteMatch[1]) : undefined;
  // Read the frame rate from the raw name: normalizeName() turns "23.976fps"
  // into "23 976fps", which the previous parser could never match.
  const fpsMatch = String(filename).match(/(?<![0-9])(23\.976|23\.98|24|25|29\.97|30|50|59\.94|60)[ ._-]?fps(?:[^a-z]|$)/i);
  const fps = fpsMatch ? (fpsMatch[1] === "23.98" ? 23.976 : Number(fpsMatch[1])) : undefined;
  return {
    raw: filename,
    normalized,
    title: releaseTitle(filename),
    year: Number(firstMatch(normalized, /\b(19\d{2}|20\d{2})\b/)) || undefined,
    season,
    episode,
    source,
    platform,
    resolution: firstMatch(normalized, /\b(2160p|1080p|720p|480p)\b/),
    edition,
    group: (suffixGroup || prefixGroup)?.toLowerCase(),
    videoCodec: firstMatch(normalized, /\b(x265|x264|h265|h264|hevc|av1)\b/),
    audioCodec: firstMatch(normalized, /\b(ddp(?:5 1|7 1)?|dts(?: hd)?|aac|atmos|truehd)\b/),
    hdr: /\b(hdr10?\+?|dolby vision|dv)\b/i.test(normalized),
    absoluteEpisode,
    fps
  };
}

// Trailing episode number in names that carry no SxxEyy / " - 07" marker,
// e.g. "code-geass13.srt" or "Code Geass 11". Codec, resolution, audio and
// year tokens are removed first so "x264" or "2160p" never read as episodes.
export function looseEpisodeNumber(value = "") {
  const stem = String(value)
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(?:2160|1080|720|576|480)[pi]\b/gi, " ")
    .replace(/[xh][ ._-]?26[45]|hevc|av1|1[02]bit|8bit|e?ac-?3|aac(?:\d(?:[ ._]\d)?)?|ddp?(?:\d(?:[ ._]\d)?)?|dts(?:-?hd)?|truehd|atmos|[257][ ._]1|2[ ._]0/gi, " ")
    .replace(/(?:19|20)\d{2}/g, " ")
    .trim();
  const match = stem.match(/(?:^|[^0-9])0*(\d{1,3})(?:v\d)?$/i);
  return match ? Number(match[1]) : undefined;
}

export function parseVideoId(type, id) {
  const parts = String(id).split(":");
  const imdbMatch = parts[0].match(/^tt(\d+)$/i);
  if (!imdbMatch) throw new Error("Only IMDb-based Stremio IDs are supported");
  const media = { type, id, imdbId: imdbMatch[1] };
  if (type === "series") {
    media.season = Number(parts[1]);
    media.episode = Number(parts[2]);
    if (!Number.isInteger(media.season) || !Number.isInteger(media.episode)) {
      throw new Error("Series ID must include season and episode, for example tt1234567:1:2");
    }
  }
  return media;
}

export function parseExtra(segment = "") {
  const params = new URLSearchParams(segment);
  const size = Number(params.get("videoSize"));
  return {
    videoHash: params.get("videoHash") || "",
    videoSize: Number.isFinite(size) && size > 0 ? size : undefined,
    filename: params.get("filename") || ""
  };
}
