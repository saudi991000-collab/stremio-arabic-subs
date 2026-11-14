// Display polish applied to every subtitle file just before it is served.
//
// 1. Right-to-left marks: Android TV (Mi Box) and some iPad players lay out a
//    line by its first strong character. A line that starts with "-", "...",
//    a number or a Latin name then shows its full stop or question mark on the
//    wrong side. An invisible RIGHT-TO-LEFT MARK (U+200F) at the start of every
//    Arabic line fixes the direction without changing any visible character.
// 2. Advertising and mid-episode credit lines ("ترجمة فلان", web sites,
//    Telegram/Instagram handles) are removed. The first credit near the start
//    of the file is kept, so the translator is still credited.
// 3. Lines shown too briefly to read are extended into the following silence.
// 4. Lines that overlap the next one (one hides the other on TV players) are
//    shortened to end just before the next line. SRT/VTT only: overlaps in
//    ASS files are deliberate (signs, two speakers at once).

const RLM = "‏";
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const DIRECTION_MARKS = /^[‎‏‪-‮⁦-⁩]/;

const AD_PATTERNS = [
  /(?:https?:\/\/|www\.)\S+/i,
  /\b[a-z0-9-]{2,}\.(?:com|net|org|info|tv|me|io|co|xyz|site|online|cc)\b/i,
  /\bt\.me\//i,
  /(?:^|\s)@[a-z0-9_.]{3,}/i,
  // Platform names alone can be dialogue ("post it on Facebook"); only the
  // phrasing of an advert counts.
  /(?:تابعونا|تابعوني|زوروا موقع|زوروا قناة|حملوا الترجمة|للمزيد من الترجمات|الترجمة حصرية|حصرياً على موقع|انضموا (?:إلى|الى) (?:قناة|مجموعة|قناتنا))/,
  /\b(?:follow us|join us|join our|subscribe to our|support us) (?:on|at)?\s*(?:telegram|instagram|twitter|facebook|youtube|discord|patreon)\b/i,
  /\b(?:advertise your product|opensubtitles|subscene|subdl|subsource|yify|yts|downloaded from|support us and become vip)\b/i
];

const CREDIT_PATTERNS = [
  /^(?:ترجم(?:ة|ه|ها)?|مترجم|المترجم|تمت الترجمة|ترجمة وتعديل|تعديل التوقيت|ضبط التوقيت|تعديل وضبط|مزامنة|تدقيق|مراجعة|إعداد)\s*[:：\-–]?\s*\S/,
  /^(?:translated|subtitles?|subbed|synced|sync(?:ed)?|corrected|ripped|encoded)\s+(?:by|and)\b/i,
  /^(?:translation|sync|subtitles?)\s*[:：\-–]/i
];

function plainText(text) {
  return String(text)
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\[Nnh]/g, " ")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAdvert(text) {
  const plain = plainText(text);
  return plain.length > 0 && plain.length <= 160 && AD_PATTERNS.some((pattern) => pattern.test(plain));
}

export function isCredit(text) {
  const plain = plainText(text).replace(/^[-–•*♪\s]+/, "");
  if (!plain || plain.length > 90) return false;
  // Short lines only: dialogue that merely mentions "translation" stays.
  return plain.split(/\s+/).length <= 9 && CREDIT_PATTERNS.some((pattern) => pattern.test(plain));
}

// Adds a right-to-left mark at the start of an Arabic line (after any leading
// ASS override block or HTML-like tag, which are not displayed).
export function markLine(line) {
  const value = String(line);
  if (!ARABIC.test(value)) return value;
  const lead = value.match(/^(?:\s*(?:\{[^}]*\}|<[^>]+>))*/)?.[0] || "";
  const rest = value.slice(lead.length);
  if (DIRECTION_MARKS.test(rest)) return value;
  return `${lead}${RLM}${rest}`;
}

function clock(seconds, separator) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function parseClock(value) {
  const match = String(value).match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0")) / 1000;
}

const ARROW = /^\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})(.*)$/;

// Seconds a line needs on screen: about 17 Arabic characters per second plus
// a short reaction time, capped so long lines are not stretched for ever.
function neededSeconds(text) {
  return Math.min(4, 0.8 + plainText(text).length / 17);
}

function polishTimed(text, extension, options) {
  const vtt = extension === "vtt";
  const separator = vtt ? "." : ",";
  const normalized = String(text).replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const header = vtt && /^\s*﻿?WEBVTT/.test(blocks[0] || "") ? blocks.shift() : null;
  const cues = [];
  const extras = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const arrowIndex = lines.findIndex((line) => ARROW.test(line));
    if (arrowIndex < 0) {
      if (block.trim()) extras.push(block);
      continue;
    }
    const [, from, to, settings] = lines[arrowIndex].match(ARROW);
    cues.push({ start: parseClock(from), end: parseClock(to), settings, id: vtt ? lines.slice(0, arrowIndex).join("\n") : "", body: lines.slice(arrowIndex + 1) });
  }
  if (!cues.length) return text;
  const lastEnd = Math.max(...cues.map((cue) => cue.end));
  let creditKept = false;
  let kept = cues.filter((cue) => {
    const body = cue.body.join("\n");
    if (options.removeAds && isAdvert(body)) return false;
    if (options.removeAds && isCredit(body)) {
      // One credit at the very start (or the very end) stays.
      const edge = cue.start < 300 || cue.start > lastEnd - 120;
      if (edge && !creditKept) {
        creditKept = true;
        return true;
      }
      return false;
    }
    return true;
  });
  // Never empty a file because of the filters.
  if (kept.length < Math.max(3, cues.length * 0.5)) kept = cues;
  kept.sort((a, b) => a.start - b.start);
  if (options.fixTiming) {
    for (let index = 0; index < kept.length; index += 1) {
      const cue = kept[index];
      const next = kept[index + 1];
      const limit = next ? next.start - 0.05 : Infinity;
      // Overlap: end just before the next line, unless that leaves it too short.
      if (next && cue.end > next.start + 0.05 && next.start - cue.start >= 0.6 && plainText(cue.body.join(" ")) !== plainText(next.body.join(" "))) {
        cue.end = next.start - 0.04;
      }
      const needed = neededSeconds(cue.body.join(" "));
      if (cue.end - cue.start < needed && cue.end < limit) {
        cue.end = Math.min(cue.start + needed, limit);
      }
    }
  }
  const out = kept.map((cue, index) => {
    const body = options.rtl ? cue.body.map(markLine) : cue.body;
    const timing = `${clock(cue.start, separator)} --> ${clock(cue.end, separator)}${cue.settings || ""}`;
    const id = vtt ? (cue.id ? `${cue.id}\n` : "") : `${index + 1}\n`;
    return `${id}${timing}\n${body.join("\n")}`;
  });
  return `${header ? `${header}\n\n` : ""}${[...(vtt ? extras : []), ...out].join("\n\n")}\n`;
}

function polishAss(text, options) {
  const lines = String(text).split(/\r?\n/);
  const dialogue = lines.filter((line) => /^Dialogue:/i.test(line)).length;
  let removed = 0;
  const out = [];
  for (const line of lines) {
    const match = line.match(/^(Dialogue:\s*(?:[^,]*,){9})(.*)$/i);
    if (!match) {
      out.push(line);
      continue;
    }
    if (options.removeAds && (isAdvert(match[2]) || (isCredit(match[2]) && /,\s*0:0[0-4]:/.test(match[1]) === false)) && removed < dialogue * 0.5) {
      removed += 1;
      continue;
    }
    const textField = options.rtl ? match[2].split(/(\\N)/).map((part) => part === "\\N" ? part : markLine(part)).join("") : match[2];
    out.push(`${match[1]}${textField}`);
  }
  return out.join("\n");
}

/**
 * @param {string} text normalized subtitle text
 * @param {"srt"|"vtt"|"ass"|"ssa"} extension
 * @param {{rtl?: boolean, removeAds?: boolean, fixTiming?: boolean}} options
 */
export function polishSubtitle(text, extension, options = {}) {
  const settings = { rtl: options.rtl !== false, removeAds: options.removeAds !== false, fixTiming: options.fixTiming !== false };
  try {
    if (extension === "ass" || extension === "ssa") return polishAss(text, settings);
    if (extension === "srt" || extension === "vtt") return polishTimed(text, extension, settings);
  } catch {
    // Polishing is optional; the original file is always better than none.
  }
  return text;
}
