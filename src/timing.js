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

// ---------------------------------------------------------------------------
// Multi-window alignment engine
//
// correctedTime = scale * originalTime + offset
//
// 1. Candidate scales come from real frame-rate conversions (23.976/24/25/
//    29.97, PAL speed-up) plus 1.0.
// 2. For each scale, several windows spread across the reference (beginning,
//    quarters, middle, near the end) are matched independently by sliding the
//    candidate's speech/cue activity over the reference activity. Each window
//    yields one alignment point.
// 3. RANSAC picks the line explained by the most alignment points and rejects
//    outliers; a least-squares refit on the inliers gives scale and offset.
// 4. If one line cannot explain the points but consecutive groups agree
//    (different opening length, recap, missing scene), a piecewise model is
//    built, but only when every piece is supported by real evidence and the
//    mapping stays monotonic.
// ---------------------------------------------------------------------------

const GRID = 0.2;
const FPS_VALUES = [23.976, 24, 25, 29.97];
export const STANDARD_SCALES = [...new Set([1, ...FPS_VALUES.flatMap((a) => FPS_VALUES.map((b) => Number((a / b).toFixed(6))))])]
  .filter((value) => value > 0.78 && value < 1.28)
  .sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1));

function activityGrid(cues, scale, length) {
  const grid = new Uint8Array(length);
  for (const cue of cues) {
    const first = Math.max(0, Math.floor((cue.start * scale) / GRID));
    const last = Math.min(length - 1, Math.ceil((cue.end * scale) / GRID));
    for (let index = first; index <= last; index += 1) grid[index] = 1;
  }
  return grid;
}

function windowsFor(reference, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.filter((window) => window.end - window.start >= 8).map((window) => ({ start: window.start, end: window.end }));
  }
  const first = reference[0].start;
  const last = reference.at(-1).end;
  const span = last - first;
  const count = Math.max(5, Math.min(12, Math.floor(span / 360)));
  const length = Math.min(90, Math.max(40, span / (count * 1.5)));
  const centers = Array.from({ length: count }, (_, index) => first + span * ((index + 0.5) / count));
  // Extra windows in the first and last few minutes: openings, recaps and
  // credits are exactly where two releases of the same episode differ.
  if (span > 900) {
    for (const at of [length * 0.6, length * 1.7, length * 2.8]) centers.push(first + at, last - at);
  }
  return [...new Set(centers.map((center) => Math.round(center)))].sort((a, b) => a - b).map((center) => ({
    start: Math.max(first, center - length / 2),
    end: Math.min(last, center + length / 2)
  }));
}

function bestWindowShift(referenceGrid, candidateGrid, window, maxShift) {
  const from = Math.floor(window.start / GRID);
  const to = Math.min(referenceGrid.length - 1, Math.ceil(window.end / GRID));
  let referenceActive = 0;
  for (let index = from; index <= to; index += 1) referenceActive += referenceGrid[index];
  if (referenceActive < 15) return null;
  const evaluate = (shiftSamples) => {
    let overlap = 0;
    let candidateActive = 0;
    for (let index = from; index <= to; index += 1) {
      const source = index - shiftSamples;
      const value = source >= 0 && source < candidateGrid.length ? candidateGrid[source] : 0;
      candidateActive += value;
      if (value && referenceGrid[index]) overlap += 1;
    }
    const denominator = Math.sqrt(referenceActive * candidateActive);
    return denominator ? overlap / denominator : 0;
  };
  const coarseStep = 2;
  const limit = Math.round(maxShift / GRID);
  let best = { shift: 0, score: -1 };
  const scores = [];
  for (let shift = -limit; shift <= limit; shift += coarseStep) {
    const score = evaluate(shift);
    scores.push(score);
    if (score > best.score) best = { shift, score };
  }
  for (let shift = best.shift - coarseStep + 1; shift <= best.shift + coarseStep - 1; shift += 1) {
    const score = evaluate(shift);
    if (score > best.score) best = { shift, score };
  }
  // Parabolic interpolation around the peak gives sub-grid precision.
  const left = evaluate(best.shift - 1);
  const right = evaluate(best.shift + 1);
  const curvature = left - 2 * best.score + right;
  const fraction = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curvature))) : 0;
  // Peak distinctness: a flat correlation (music, constant chatter) cannot
  // identify an offset reliably.
  const sorted = [...scores].sort((a, b) => b - a);
  const typical = sorted[Math.floor(sorted.length / 2)] || 0;
  return { offset: (best.shift + fraction) * GRID, score: best.score, distinct: best.score - typical };
}

function fitLine(points) {
  const weight = points.reduce((sum, point) => sum + point.weight, 0);
  const meanX = points.reduce((sum, point) => sum + point.x * point.weight, 0) / weight;
  const meanY = points.reduce((sum, point) => sum + point.y * point.weight, 0) / weight;
  const denominator = points.reduce((sum, point) => sum + point.weight * (point.x - meanX) ** 2, 0);
  const scale = denominator > 1 ? points.reduce((sum, point) => sum + point.weight * (point.x - meanX) * (point.y - meanY), 0) / denominator : 1;
  return { scale, offset: meanY - scale * meanX };
}

const residual = (point, line) => Math.abs(point.y - (line.scale * point.x + line.offset));

function ransac(points, tolerance) {
  if (points.length < 2) return null;
  let best = null;
  const consider = (line) => {
    if (!(line.scale > 0.75 && line.scale < 1.3)) return;
    const inliers = points.filter((point) => residual(point, line) <= tolerance);
    const support = inliers.reduce((sum, point) => sum + point.weight, 0);
    if (!best || support > best.support + 1e-9 || (Math.abs(support - best.support) < 1e-9 && Math.abs(line.scale - 1) < Math.abs(best.line.scale - 1))) {
      best = { line, inliers, support };
    }
  };
  // Exhaustive pairs: there are at most a dozen alignment points, so this is
  // deterministic and still cheap. Single-point constant offsets cover the
  // common "same scale, constant delay" case.
  for (let i = 0; i < points.length; i += 1) {
    consider({ scale: 1, offset: points[i].y - points[i].x });
    for (let j = i + 1; j < points.length; j += 1) {
      if (Math.abs(points[j].x - points[i].x) < 30) continue;
      const scale = (points[j].y - points[i].y) / (points[j].x - points[i].x);
      consider({ scale, offset: points[i].y - scale * points[i].x });
    }
  }
  if (!best || best.inliers.length < 2) return best;
  const refined = fitLine(best.inliers);
  const inliers = points.filter((point) => residual(point, refined) <= tolerance);
  return { line: refined, inliers, support: inliers.reduce((sum, point) => sum + point.weight, 0) };
}

function snapScale(scale) {
  const nearest = STANDARD_SCALES.reduce((best, value) => Math.abs(value - scale) < Math.abs(best - scale) ? value : best, 1);
  return Math.abs(nearest - scale) < 0.0015 ? nearest : scale;
}

function largestGap(cues, from, to) {
  let best = { size: -1, at: (from + to) / 2 };
  for (let index = 1; index < cues.length; index += 1) {
    const gapStart = cues[index - 1].end;
    const gapEnd = cues[index].start;
    if (gapEnd < from || gapStart > to) continue;
    const size = gapEnd - gapStart;
    if (size > best.size) best = { size, at: gapStart + size / 2, gapStart, gapEnd };
  }
  return best;
}

function piecewiseModel(points, candidateCues, tolerance) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const groups = [];
  for (const point of sorted) {
    const group = groups.at(-1);
    const offset = point.y - point.x * point.scaleHint;
    if (group && Math.abs(group.offset - offset) <= tolerance) {
      group.points.push(point);
      group.offset = group.points.reduce((sum, item) => sum + (item.y - item.x * item.scaleHint), 0) / group.points.length;
    } else groups.push({ offset, points: [point] });
  }
  // Every piece must be supported by at least two independent windows.
  if (groups.length < 2 || groups.some((group) => group.points.length < 2)) return null;
  const segments = groups.map((group) => {
    const line = group.points.length >= 3 ? fitLine(group.points) : { scale: group.points[0].scaleHint, offset: group.offset };
    return { line, first: group.points[0].x, last: group.points.at(-1).x };
  });
  const result = [];
  for (let index = 0; index < segments.length; index += 1) {
    const start = index === 0 ? -Infinity : largestGap(candidateCues, segments[index - 1].last, segments[index].first).at;
    const end = index === segments.length - 1 ? Infinity : largestGap(candidateCues, segments[index].last, segments[index + 1].first).at;
    result.push({ start, end, scale: snapScale(segments[index].line.scale), offset: segments[index].line.offset });
  }
  return result;
}

export function mapTime(value, transform) {
  if (!transform) return value;
  if (Array.isArray(transform.segments) && transform.segments.length) {
    const segment = transform.segments.find((item) => value >= item.start && value < item.end) ||
      (value < transform.segments[0].start ? transform.segments[0] : transform.segments.at(-1));
    return value * segment.scale + segment.offset;
  }
  const scale = Number.isFinite(Number(transform.scale)) ? Number(transform.scale) : 1;
  const offset = Number.isFinite(Number(transform.offset)) ? Number(transform.offset) : 0;
  return value * scale + offset;
}

// A piecewise mapping is only safe when it never moves a later cue before an
// earlier one. Content removed from the video (negative jump) must fall inside
// the silent gap chosen as the boundary.
export function transformIsMonotonic(transform, cues) {
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  let previousEnd = -Infinity;
  for (const cue of ordered) {
    const start = mapTime(cue.start, transform);
    const end = mapTime(cue.end, transform);
    if (end < start) return false;
    if (start < previousEnd - 0.75) return false;
    previousEnd = Math.max(previousEnd, end);
  }
  return true;
}

/**
 * Aligns a candidate subtitle timeline to a reference timeline.
 * @param {Array<{start:number,end:number}>} referenceCues English/embedded subtitle cues or speech segments.
 * @param {Array<{start:number,end:number}>} candidateCues Cues of the Arabic subtitle being checked.
 * @param {{windows?: Array<{start:number,end:number}>, kind?: string, maxShift?: number}} options
 */
export function alignTimelines(referenceCues, candidateCues, options = {}) {
  const none = { model: "none", scale: 1, offset: 0, segments: undefined, confidence: 0, anchors: 0, inliers: 0, outlierRatio: 1, medianError: Infinity, score: 0 };
  const reference = [...(referenceCues || [])].filter((cue) => cue.end > cue.start).sort((a, b) => a.start - b.start);
  const candidate = [...(candidateCues || [])].filter((cue) => cue.end > cue.start).sort((a, b) => a.start - b.start);
  const sparse = Array.isArray(options.windows) && options.windows.length > 0;
  if (reference.length < (sparse ? 6 : 20) || candidate.length < 20) return none;
  const maxShift = Number(options.maxShift) || 120;
  const windows = windowsFor(reference, options.windows);
  const extent = Math.max(reference.at(-1).end, candidate.at(-1).end * 1.3) + maxShift + 10;
  const length = Math.ceil(extent / GRID) + 1;
  const referenceGrid = activityGrid(reference, 1, length);

  const pointsFor = (scale, selection) => {
    const candidateGrid = activityGrid(candidate, scale, length);
    const points = [];
    for (const window of selection) {
      const match = bestWindowShift(referenceGrid, candidateGrid, window, maxShift);
      if (!match || match.score < 0.45 || match.distinct < 0.12) continue;
      const center = (window.start + window.end) / 2;
      // Alignment point: candidate time x maps to reference time y.
      points.push({ x: (center - match.offset) / scale, y: center, weight: match.score, score: match.score, scaleHint: scale });
    }
    return { scale, points, quality: points.reduce((sum, point) => sum + point.score, 0) };
  };
  // Stage 1: rank every standard frame-rate scale on three windows only.
  // Stage 2: evaluate the two best scales on all windows.
  const probeWindows = windows.length > 4 ? [windows[Math.floor(windows.length * 0.2)], windows[Math.floor(windows.length / 2)], windows[Math.floor(windows.length * 0.8)]] : windows;
  const shortlist = STANDARD_SCALES
    .map((scale) => pointsFor(scale, probeWindows))
    .sort((a, b) => b.quality - a.quality || Math.abs(a.scale - 1) - Math.abs(b.scale - 1))
    .slice(0, 2)
    .map((item) => item.scale);
  let best = null;
  for (const scale of shortlist) {
    const result = pointsFor(scale, windows);
    if (!best || result.quality > best.quality + 0.05) best = result;
  }
  if (!best || best.points.length < 3) return { ...none, anchors: best?.points.length || 0 };

  const tolerance = 0.45;
  const fitted = ransac(best.points, tolerance);
  if (!fitted || fitted.inliers.length < 2) return { ...none, anchors: best.points.length };
  const points = best.points;
  let line = { scale: fitted.line.scale, offset: fitted.line.offset };
  const snapped = snapScale(fitted.line.scale);
  if (snapped !== fitted.line.scale) {
    // Snap to the exact frame-rate ratio only if it still explains every
    // inlier; genuine clock drift (e.g. 0.9988) must keep its fitted value.
    const candidateLine = {
      scale: snapped,
      offset: fitted.inliers.reduce((sum, point) => sum + (point.y - snapped * point.x), 0) / fitted.inliers.length
    };
    if (fitted.inliers.every((point) => residual(point, candidateLine) <= 0.2)) line = candidateLine;
  }
  // Real timing differences come from frame-rate conversions or small clock
  // drift. Any other stretch factor means the timelines are unrelated.
  const nearestStandard = STANDARD_SCALES.reduce((nearest, value) => Math.abs(value - line.scale) < Math.abs(nearest - line.scale) ? value : nearest, 1);
  if (Math.abs(nearestStandard - line.scale) > 0.004) return { ...none, anchors: points.length, inliers: fitted.inliers.length };
  let inliers = points.filter((point) => residual(point, line) <= tolerance);
  let model = "linear";
  let segments;
  const outliers = points.length - inliers.length;
  if (outliers >= 2 && points.length >= 4) {
    const pieces = piecewiseModel(points, candidate, tolerance);
    const transform = pieces ? { segments: pieces } : null;
    if (transform && transformIsMonotonic(transform, candidate)) {
      const explained = points.filter((point) => Math.abs(point.y - mapTime(point.x, transform)) <= tolerance);
      if (explained.length / points.length >= 0.85 && explained.length > inliers.length) {
        model = "piecewise";
        segments = pieces;
        inliers = explained;
      }
    }
  }
  const transform = segments ? { segments } : line;
  const errors = inliers.map((point) => Math.abs(point.y - mapTime(point.x, transform))).sort((a, b) => a - b);
  const medianError = errors.length ? errors[Math.floor(errors.length / 2)] : Infinity;
  const outlierRatio = 1 - inliers.length / points.length;
  const span = inliers.length ? (Math.max(...inliers.map((p) => p.y)) - Math.min(...inliers.map((p) => p.y))) : 0;
  const referenceSpan = Math.max(1, reference.at(-1).end - reference[0].start);
  const coverage = Math.min(1, span / (referenceSpan * (sparse ? 0.5 : 0.6)));
  const meanScore = inliers.reduce((sum, point) => sum + point.score, 0) / Math.max(1, inliers.length);
  const evidence = Math.min(1, inliers.length / (sparse ? 4 : 5));
  const scalePlausible = STANDARD_SCALES.includes(line.scale) ? 1 : 0.85;
  const kindWeight = options.kind === "vad" ? 0.8 : options.kind === "audio-whisper" ? 0.92 : 1;
  const confidence = Math.max(0, Math.min(1,
    meanScore * 0.35 + (1 - outlierRatio) * 0.25 + evidence * 0.2 + coverage * 0.2
  ) * Math.exp(-medianError / 0.6) * scalePlausible * kindWeight * (model === "piecewise" ? 0.92 : 1));
  return {
    model,
    scale: segments ? undefined : line.scale,
    offset: segments ? undefined : line.offset,
    segments,
    confidence,
    score: confidence,
    anchors: points.length,
    inliers: inliers.length,
    outlierRatio,
    medianError
  };
}

export function isIdentityTransform(transform) {
  if (!transform) return true;
  if (Array.isArray(transform.segments) && transform.segments.length) return false;
  return Math.abs((Number(transform.scale) || 1) - 1) < 0.0004 && Math.abs(Number(transform.offset) || 0) < 0.08;
}

function transformSeconds(value, transform) {
  return Math.max(0, mapTime(value, transform));
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

function localScale(value, transform) {
  if (Array.isArray(transform?.segments) && transform.segments.length) {
    const segment = transform.segments.find((item) => value >= item.start && value < item.end) || transform.segments.at(-1);
    return segment.scale;
  }
  return Number.isFinite(Number(transform?.scale)) ? Number(transform.scale) : 1;
}

// Karaoke (\k, \K, \kf, \ko) durations are centiseconds relative to the line
// start. When the timeline is stretched they are stretched by the same factor
// so syllables stay on the beat; every other override tag is left untouched.
function scaleKaraoke(text, scale) {
  if (Math.abs(scale - 1) < 0.0005) return text;
  return text.replace(/\\(k[fo]?|K)(\d+)/g, (_, tag, value) => `\\${tag}${Math.max(0, Math.round(Number(value) * scale))}`);
}

export function retimeSubtitle(text, extension, transform) {
  if (!transform || isIdentityTransform(transform)) return String(text);
  const source = String(text);
  if (/^(ass|ssa)$/i.test(extension)) {
    return source.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(Dialogue:\s*[^,]*,\s*)(\d{1,2}:\d{2}:\d{2}[.]\d{1,2})(\s*,\s*)(\d{1,2}:\d{2}:\d{2}[.]\d{1,2})(\s*,.*)$/i);
      if (!match) return [line];
      const [, prefix, start, separator, end, suffix] = match;
      const startClock = parseClock(start);
      const endClock = parseClock(end);
      if (!startClock || !endClock) return [line];
      const mappedEnd = mapTime(endClock.seconds, transform);
      if (mappedEnd <= 0.05) return [];
      const mappedStart = Math.max(0, mapTime(startClock.seconds, transform));
      const scale = localScale(startClock.seconds, transform);
      return [`${prefix}${formatClock(mappedStart, startClock)}${separator}${formatClock(Math.max(mappedStart + 0.01, mappedEnd), endClock)}${scaleKaraoke(suffix, scale)}`];
    }).join(source.includes("\r\n") ? "\r\n" : "\n");
  }
  if (/^vtt$/i.test(extension)) {
    return source.replace(
      /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})(\s*-->\s*)((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})/g,
      (_, start, arrow, end) => `${retimeClock(start, transform)}${arrow}${retimeClock(end, transform)}`
    );
  }
  // SRT: rebuild blocks so cues pushed before 0:00 are dropped, order is kept
  // and the sequence numbers stay contiguous.
  const blocks = source.replace(/\r/g, "").split(/\n\s*\n/);
  const output = [];
  let previousStart = 0;
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => /-->/.test(line));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/^\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})(.*)$/);
    if (!timing) continue;
    const startClock = parseClock(timing[1].length <= 9 ? `00:${timing[1]}` : timing[1]);
    const endClock = parseClock(timing[2].length <= 9 ? `00:${timing[2]}` : timing[2]);
    if (!startClock || !endClock) continue;
    const mappedEnd = mapTime(endClock.seconds, transform);
    if (mappedEnd <= 0.05) continue;
    const mappedStart = Math.max(previousStart, Math.max(0, mapTime(startClock.seconds, transform)));
    previousStart = mappedStart;
    const body = lines.slice(timingIndex + 1).join("\n");
    output.push(`${output.length + 1}\n${formatClock(mappedStart, startClock)} --> ${formatClock(Math.max(mappedStart + 0.05, mappedEnd), endClock)}${timing[3]}\n${body}`);
  }
  return `${output.join("\n\n")}\n`;
}
