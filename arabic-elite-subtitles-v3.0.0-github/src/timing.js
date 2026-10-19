function seconds(hours, minutes, secondsValue, fraction, fractionDigits = 3) {
  return Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(secondsValue) + Number(fraction) / (10 ** fractionDigits);
}

export function parseTimeline(text) {
  const cues = [];
  const arrow = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/g;
  for (const match of String(text).matchAll(arrow)) {
    cues.push({
      start: seconds(match[1], match[2], match[3], match[4]),
      end: seconds(match[5], match[6], match[7], match[8])
    });
  }
  const ass = /^Dialogue:\s*[^,]*,\s*(\d+):(\d{2}):(\d{2})[.](\d{1,2}),\s*(\d+):(\d{2}):(\d{2})[.](\d{1,2}),/gim;
  for (const match of String(text).matchAll(ass)) {
    cues.push({
      start: seconds(match[1], match[2], match[3], match[4], 2),
      end: seconds(match[5], match[6], match[7], match[8], 2)
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function quantile(values, ratio) {
  if (!values.length) return 0;
  const position = Math.min(values.length - 1, Math.max(0, ratio * (values.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export function compareTimelines(referenceCues, candidateCues) {
  if (referenceCues.length < 8 || candidateCues.length < 8) return { score: 0, medianError: Infinity, scale: 1, offset: 0 };
  const reference = referenceCues.map((cue) => cue.start);
  const candidate = candidateCues.map((cue) => cue.start);
  const ratios = Array.from({ length: 19 }, (_, index) => (index + 1) / 20);
  const pairs = ratios.map((ratio) => ({ x: quantile(candidate, ratio), y: quantile(reference, ratio) }));
  const meanX = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length;
  const denominator = pairs.reduce((sum, pair) => sum + (pair.x - meanX) ** 2, 0);
  const scale = denominator > 0
    ? pairs.reduce((sum, pair) => sum + (pair.x - meanX) * (pair.y - meanY), 0) / denominator
    : 1;
  const offset = meanY - scale * meanX;
  const errors = pairs.map((pair) => Math.abs(pair.y - (scale * pair.x + offset)));
  const medianError = median(errors);
  const countRatio = Math.min(reference.length, candidate.length) / Math.max(reference.length, candidate.length);
  const scalePenalty = Math.exp(-Math.abs(Math.log(Math.max(0.001, scale))) * 6);
  const timingPenalty = Math.exp(-medianError / 2.2);
  const score = Math.max(0, Math.min(1, timingPenalty * scalePenalty * (0.65 + 0.35 * Math.sqrt(countRatio))));
  return { score, medianError, scale, offset };
}

export function compareSpeechActivity(referenceCues, candidateCues) {
  if (referenceCues.length < 3 || candidateCues.length < 8) return { score: 0, offset: 0 };
  const start = Math.max(0, referenceCues[0].start - 2);
  const end = referenceCues.at(-1).end + 2;
  const step = 0.5;
  const samples = Math.ceil((end - start) / step) + 1;
  const mask = (cues, offset = 0) => {
    const values = new Uint8Array(samples);
    for (const cue of cues) {
      const first = Math.max(0, Math.floor((cue.start + offset - 0.25 - start) / step));
      const last = Math.min(samples - 1, Math.ceil((cue.end + offset + 0.25 - start) / step));
      for (let index = first; index <= last; index += 1) values[index] = 1;
    }
    return values;
  };
  const referenceMask = mask(referenceCues);
  const referenceActive = referenceMask.reduce((sum, value) => sum + value, 0);
  let best = { score: 0, offset: 0 };
  for (let offset = -90; offset <= 90; offset += 0.5) {
    const candidateMask = mask(candidateCues, offset);
    let overlap = 0;
    let candidateActive = 0;
    for (let index = 0; index < samples; index += 1) {
      candidateActive += candidateMask[index];
      if (referenceMask[index] && candidateMask[index]) overlap += 1;
    }
    const denominator = Math.sqrt(referenceActive * candidateActive);
    const score = denominator ? overlap / denominator : 0;
    if (score > best.score) best = { score: Math.min(1, score), offset };
  }
  return best;
}

export function inspectStyling(text, extension = "") {
  const value = String(text);
  const ass = /^(?:\ufeff)?\[Script Info\]/im.test(value) || /^(?:\ufeff)?\[V4\+? Styles\]/im.test(value) || /^(ass|ssa)$/i.test(extension);
  if (!ass) return { styled: false, strength: 0, features: [] };
  const features = [];
  if (/\\(?:1?c|2c|3c|4c)&H[0-9A-F]+&/i.test(value)) features.push("color");
  if (/\\(?:pos|move|org)\s*\(|\\an[1-9]\b/i.test(value)) features.push("position");
  if (/\\(?:k|K|kf|ko)\d+/i.test(value)) features.push("karaoke");
  if (/\\p[1-9]\b/i.test(value)) features.push("drawing");
  if (/\\(?:fad|fade|t)\s*\(/i.test(value)) features.push("effects");
  const styles = (value.match(/^Style:/gim) || []).length;
  if (styles > 2) features.push("multiple-styles");
  const unique = [...new Set(features)];
  return { styled: unique.length > 0, strength: unique.length, features: unique };
}

function transformSeconds(value, transform) {
  const scale = Number.isFinite(Number(transform?.scale)) ? Number(transform.scale) : 1;
  const offset = Number.isFinite(Number(transform?.offset)) ? Number(transform.offset) : 0;
  return Math.max(0, value * scale + offset);
}

function parseClock(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})([,.])(\d{1,3})$/);
  if (!match) return null;
  return {
    seconds: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[5].padEnd(3, "0")) / 1000,
    separator: match[4],
    fractionDigits: match[5].length,
    hourDigits: match[1].length
  };
}

function formatClock(value, template) {
  const digits = template.fractionDigits;
  const unitsPerSecond = digits === 2 ? 100 : 1000;
  const total = Math.max(0, Math.round(value * unitsPerSecond));
  const hours = Math.floor(total / (3600 * unitsPerSecond));
  const minutes = Math.floor((total % (3600 * unitsPerSecond)) / (60 * unitsPerSecond));
  const secondsValue = Math.floor((total % (60 * unitsPerSecond)) / unitsPerSecond);
  const fractionValue = total % unitsPerSecond;
  return `${String(hours).padStart(template.hourDigits, "0")}:${String(minutes).padStart(2, "0")}:${String(secondsValue).padStart(2, "0")}${template.separator}${String(fractionValue).padStart(digits, "0")}`;
}

function retimeClock(value, transform) {
  const parsed = parseClock(value);
  return parsed ? formatClock(transformSeconds(parsed.seconds, transform), parsed) : value;
}

export function retimeSubtitle(text, extension, transform) {
  if (!transform || (!Number.isFinite(Number(transform.offset)) && !Number.isFinite(Number(transform.scale)))) return String(text);
  if (/^(ass|ssa)$/i.test(extension)) {
    return String(text).replace(
      /^(Dialogue:\s*[^,]*,\s*)(\d{1,2}:\d{2}:\d{2}[.]\d{1,2})(\s*,\s*)(\d{1,2}:\d{2}:\d{2}[.]\d{1,2})(\s*,.*)$/gim,
      (_, prefix, start, separator, end, suffix) => `${prefix}${retimeClock(start, transform)}${separator}${retimeClock(end, transform)}${suffix}`
    );
  }
  return String(text).replace(
    /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})(\s*-->\s*)((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})/g,
    (_, start, arrow, end) => `${retimeClock(start, transform)}${arrow}${retimeClock(end, transform)}`
  );
}
