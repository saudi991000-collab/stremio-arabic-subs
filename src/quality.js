// Content-based verification of downloaded Arabic subtitles.
//
// Provider metadata is only a hint: files labelled "ar" are sometimes English,
// and machine translations are often uploaded without the provider flag. This
// module looks at the decoded cue text itself and combines several independent
// signals. Only strong evidence rejects a file; weak signals lower its quality
// score so that a human translation from an unknown translator is still listed.

const ARABIC_LETTER = /[ء-يٱ-ۓۺ-ۿ]/gu;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/g;
const ARABIC_PUNCTUATION = /[،؛؟]/g;

// Explicit labels in a filename, release name, uploader comment or inside the
// subtitle text. These are phrases, not bare "ai"/"mt" tokens, because those
// tokens appear in many legitimate titles (e.g. "Ai no Kusabi", "A.I. 2001").
const MACHINE_LABELS = [
  /\b(?:ai|a\.i\.)[ ._-]*(?:translated|translation|translate|generated|subs?|subtitles?)\b/i,
  /\b(?:machine|auto(?:matic(?:ally)?)?)[ ._-]*(?:translated|translation|translate|generated|subs?|captions?)\b/i,
  /\bgoogle[ ._-]*(?:translate|translated|translation)\b/i,
  /\b(?:deepl|chat[ ._-]?gpt|gpt[ ._-]?4o?|whisper(?:x|ai)?|subtitle[ ._-]?edit[ ._-]?auto[ ._-]?translate)\b/i,
  /\[(?:ai|mt)\]/i,
  /ترجم(?:ة|ه)\s*(?:آلي|ألي|الي)(?:ة|ه)?/u,
  /(?:مترجم|ترجمت?)\s*(?:آليا|آلياً|اليا|ألياً|بواسطة\s*(?:جوجل|غوغل|google|الذكاء))/iu,
  /(?:ترجمة|مترجم)\s*(?:جوجل|غوغل|قوقل)/u,
  /(?:بالذكاء|ذكاء)\s*(?:الاصطناعي|اصطناعي)/u
];

export function explicitMachineLabel(...values) {
  const text = values.filter(Boolean).map(String).join(" \n ");
  return MACHINE_LABELS.find((pattern) => pattern.test(text))?.source || "";
}

function stripMarkup(value) {
  return String(value)
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\[Nnh]/g, " ")
    .trim();
}

export function extractCues(text) {
  const value = String(text).replace(/\r/g, "");
  const cues = [];
  const toSeconds = (h, m, s, f, digits) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(f) / 10 ** digits;
  if (/^\s*﻿?\[Script Info\]/i.test(value) || /^Dialogue:/im.test(value)) {
    for (const match of value.matchAll(/^Dialogue:\s*[^,]*,\s*(\d+):(\d{2}):(\d{2})[.](\d{1,3}),\s*(\d+):(\d{2}):(\d{2})[.](\d{1,3}),([^\n]*)$/gim)) {
      const fields = match[9].split(",");
      cues.push({
        start: toSeconds(match[1], match[2], match[3], match[4], match[4].length),
        end: toSeconds(match[5], match[6], match[7], match[8], match[8].length),
        text: stripMarkup(fields.slice(6).join(","))
      });
    }
    return cues;
  }
  for (const block of value.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const timing = lines[index].match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!timing) continue;
    cues.push({
      start: toSeconds(timing[1], timing[2], timing[3], timing[4], timing[4].length),
      end: toSeconds(timing[5], timing[6], timing[7], timing[8], timing[8].length),
      text: stripMarkup(lines.slice(index + 1).join("\n"))
    });
  }
  return cues;
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

/**
 * @returns {{
 *   verdict: "human" | "machine" | "not-arabic" | "broken",
 *   accepted: boolean, humanScore: number, reasons: string[],
 *   arabicRatio: number, arabicCueRatio: number, cueCount: number, durationSeconds: number,
 *   repetitionRatio: number, overlapRatio: number, bilingual: boolean
 * }}
 */
export function assessSubtitle(text, options = {}) {
  const {
    fileName = "",
    release = "",
    comment = "",
    expectedDurationSeconds,
    allowMachineTranslated = false,
    allowBilingual = true,
    metadataMachineTranslated = false
  } = options;
  const cues = extractCues(text).filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end));
  const reasons = [];
  const dialogue = cues.map((cue) => cue.text).filter(Boolean);
  const joined = dialogue.join("\n");
  const arabicLetters = (joined.match(ARABIC_LETTER) || []).length;
  const latinLetters = (joined.match(LATIN_LETTER) || []).length;
  const arabicRatio = ratio(arabicLetters, arabicLetters + latinLetters);
  const arabicCues = dialogue.filter((line) => (line.match(ARABIC_LETTER) || []).length >= 2).length;
  const latinOnlyCues = dialogue.filter((line) => (line.match(ARABIC_LETTER) || []).length < 2 && (line.match(LATIN_LETTER) || []).length >= 4).length;
  const arabicCueRatio = ratio(arabicCues, dialogue.length);
  const bilingual = arabicCueRatio >= 0.5 && ratio(latinOnlyCues, dialogue.length) < 0.2 && arabicRatio < 0.7 && latinLetters > arabicLetters * 0.35;
  const durationSeconds = cues.reduce((max, cue) => Math.max(max, cue.end), 0);

  const base = {
    arabicRatio,
    arabicCueRatio,
    cueCount: cues.length,
    durationSeconds,
    bilingual,
    repetitionRatio: 0,
    overlapRatio: 0
  };

  if (cues.length < 3 || dialogue.length < 3) {
    return { ...base, verdict: "broken", accepted: false, humanScore: 0, reasons: ["too-few-cues"] };
  }
  // Language: the decoded dialogue must actually be Arabic. English files with
  // an "ar" tag usually have well under 5% Arabic letters.
  if (arabicLetters < 40 || arabicCueRatio < 0.35 || arabicRatio < 0.2) {
    return { ...base, verdict: "not-arabic", accepted: false, humanScore: 0, reasons: ["insufficient-arabic-text"] };
  }
  if (bilingual && !allowBilingual) {
    return { ...base, verdict: "not-arabic", accepted: false, humanScore: 0, reasons: ["bilingual-not-allowed"] };
  }

  let humanScore = 0.75;
  const label = explicitMachineLabel(fileName, release, comment, dialogue.slice(0, 6).join(" "), dialogue.slice(-6).join(" "));
  if (label || metadataMachineTranslated) reasons.push(label ? "machine-label" : "machine-metadata");

  // Repetition: automated transcription/translation loops repeat the same
  // line many times in a row ("شكرا لكم" x40). Human files rarely exceed a few
  // percent of consecutive duplicates.
  let consecutiveDuplicates = 0;
  for (let index = 1; index < dialogue.length; index += 1) {
    if (dialogue[index] && dialogue[index] === dialogue[index - 1]) consecutiveDuplicates += 1;
  }
  const counts = new Map();
  for (const line of dialogue) counts.set(line, (counts.get(line) || 0) + 1);
  const mostRepeated = Math.max(...counts.values());
  const repetitionRatio = Math.max(ratio(consecutiveDuplicates, dialogue.length), ratio(mostRepeated, dialogue.length) * (dialogue.length >= 50 ? 1 : 0));
  if (repetitionRatio > 0.35) reasons.push("repetition-loop");
  else if (repetitionRatio > 0.12) {
    humanScore -= 0.15;
    reasons.push("repetitive");
  }

  // Timing quality.
  let overlaps = 0;
  let negative = 0;
  let tiny = 0;
  let huge = 0;
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length; index += 1) {
    const cue = ordered[index];
    if (cue.end <= cue.start) negative += 1;
    if (cue.end - cue.start < 0.25) tiny += 1;
    if (cue.end - cue.start > 15) huge += 1;
    if (index && cue.start < ordered[index - 1].end - 0.5) overlaps += 1;
  }
  const overlapRatio = ratio(overlaps, cues.length);
  if (ratio(negative, cues.length) > 0.2) reasons.push("invalid-timing");
  if (overlapRatio > 0.3 && !/^\s*﻿?\[Script Info\]/i.test(String(text))) {
    humanScore -= 0.1;
    reasons.push("heavy-overlap");
  }
  if (ratio(tiny + huge, cues.length) > 0.3) {
    humanScore -= 0.1;
    reasons.push("poor-cue-durations");
  }

  // Punctuation: human Arabic subtitles normally use Arabic comma/question
  // marks. Their complete absence in a long file is a weak machine signal.
  const arabicPunctuation = (joined.match(ARABIC_PUNCTUATION) || []).length;
  const latinQuestion = (joined.match(/\?/g) || []).length;
  if (dialogue.length >= 150 && arabicPunctuation === 0 && latinQuestion === 0) {
    humanScore -= 0.08;
    reasons.push("no-arabic-punctuation");
  } else if (arabicPunctuation > 0) {
    humanScore += 0.05;
  }

  // Untranslated English words embedded inside Arabic lines are typical of
  // machine output that could not translate names/idioms consistently.
  const mixedLines = dialogue.filter((line) => /[ء-ي]/u.test(line) && /\b[a-z]{4,}\b/.test(line)).length;
  if (!bilingual && ratio(mixedLines, dialogue.length) > 0.25) {
    humanScore -= 0.12;
    reasons.push("mixed-script-lines");
  }

  // Cue density and completeness.
  const minutes = durationSeconds / 60;
  const cuesPerMinute = minutes > 0 ? cues.length / minutes : 0;
  if (minutes >= 20 && cuesPerMinute < 1) {
    // e.g. 65 cues over a two-hour film: a forced/"foreign parts only" or
    // unfinished subtitle, not a complete translation.
    return { ...base, verdict: "broken", accepted: false, humanScore: 0, reasons: ["partial-or-forced"] };
  }
  if (minutes >= 10 && (cuesPerMinute < 1.5 || cuesPerMinute > 45)) {
    humanScore -= 0.1;
    reasons.push("implausible-cue-density");
  }
  if (Number(expectedDurationSeconds) > 0) {
    const coverage = durationSeconds / Number(expectedDurationSeconds);
    if (coverage < 0.55) {
      humanScore -= 0.2;
      reasons.push("incomplete");
    } else if (coverage > 1.35) {
      reasons.push("longer-than-video");
      humanScore -= 0.25;
    }
  }

  humanScore = Math.max(0, Math.min(1, humanScore));
  const machine = reasons.includes("machine-label") || reasons.includes("machine-metadata") || reasons.includes("repetition-loop");
  if (reasons.includes("invalid-timing")) {
    return { ...base, repetitionRatio, overlapRatio, verdict: "broken", accepted: false, humanScore, reasons };
  }
  if (machine) {
    return { ...base, repetitionRatio, overlapRatio, verdict: "machine", accepted: Boolean(allowMachineTranslated), humanScore: Math.min(humanScore, 0.2), reasons };
  }
  return { ...base, repetitionRatio, overlapRatio, verdict: "human", accepted: true, humanScore, reasons };
}

export function looksLikeHtml(buffer) {
  const head = Buffer.from(buffer).subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || /^<(?:head|body|script|meta)\b/.test(head) ||
    (/<html[\s>]/.test(head) && !/<(?:sami|tt|ttml)\b/.test(head)) ||
    head.startsWith("{\"error") || head.startsWith("{\"message");
}
