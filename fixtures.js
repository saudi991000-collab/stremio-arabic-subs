// Realistic subtitle fixtures for tests. Real subtitles have many cues; the
// content checks reject one-line "subtitles", so fixtures must look real.

const ARABIC_LINES = [
  "أين كنت طوال هذا الوقت؟",
  "لم أتوقع أن أراك هنا الليلة.",
  "علينا أن نغادر قبل شروق الشمس.",
  "هل تثق بي، أم لا؟",
  "سأعود إليك، أعدك بذلك.",
  "هذا ليس ما اتفقنا عليه.",
  "اسمعني جيداً، لا وقت لدينا.",
  "كانت أمي تقول ذلك دائماً.",
  "لماذا لم تخبرني بالحقيقة؟",
  "انتظر، هناك شخص بالخارج.",
  "لن أسمح لهم بإيذائك.",
  "الطريق إلى المدينة مغلق.",
  "أحتاج إلى بعض الوقت للتفكير.",
  "هل رأيت ما حدث في الأسفل؟",
  "لا أعرف كيف أشكرك.",
  "ابقَ هنا حتى أعود.",
  "هذه آخر فرصة لنا.",
  "قلت لك إنها فكرة سيئة.",
  "من أرسلك إلى هنا؟",
  "سنجد طريقة، كما نفعل دائماً."
];

const ENGLISH_LINES = [
  "Where have you been all this time?",
  "I didn't expect to see you here tonight.",
  "We have to leave before sunrise.",
  "Do you trust me or not?",
  "I'll come back for you, I promise.",
  "This is not what we agreed on.",
  "Listen to me, we don't have time.",
  "My mother always used to say that."
];

function clock(seconds, separator = ",") {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
}

function assClock(seconds) {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

// Irregular but deterministic dialogue timing, like real speech.
export function dialogueTimes(count = 60, { start = 5, seed = 7 } = {}) {
  const cues = [];
  let time = start;
  let value = seed;
  for (let index = 0; index < count; index += 1) {
    value = (value * 9301 + 49297) % 233280;
    const gap = 0.6 + (value / 233280) * 6.5;
    const length = 1.2 + ((value * 7) % 233280) / 233280 * 2.6;
    time += gap;
    cues.push({ start: time, end: time + length });
    time += length;
  }
  return cues;
}

export function srtFrom(cues, lines = ARABIC_LINES) {
  return `${cues.map((cue, index) => `${index + 1}\n${clock(cue.start)} --> ${clock(cue.end)}\n${lines[index % lines.length]}`).join("\n\n")}\n`;
}

export function arabicSrt(count = 60, options = {}) {
  return srtFrom(dialogueTimes(count, options), options.lines || ARABIC_LINES);
}

export function englishSrt(count = 60, options = {}) {
  return srtFrom(dialogueTimes(count, options), ENGLISH_LINES);
}

export function arabicAss(count = 40, { styled = true, karaoke = false, start = 5 } = {}) {
  const cues = dialogueTimes(count, { start });
  const header = `[Script Info]\nTitle: Arabic\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\nStyle: Top,Arial,44,&H00FFFF00,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = cues.map((cue, index) => {
    const line = ARABIC_LINES[index % ARABIC_LINES.length];
    const tags = karaoke ? `{\\k25}${line.split(" ").join("{\\k30}")}` : styled && index % 3 === 0 ? `{\\an8\\c&H00FFFF&}${line}` : line;
    return `Dialogue: 0,${assClock(cue.start)},${assClock(cue.end)},${index % 3 === 0 ? "Top" : "Default"},,0,0,0,,${tags}`;
  });
  return `${header}${events.join("\n")}\n`;
}

export function machineSrt(count = 80) {
  // A Whisper/MT loop: the same line repeated again and again.
  const cues = dialogueTimes(count);
  return `${cues.map((cue, index) => `${index + 1}\n${clock(cue.start)} --> ${clock(cue.end)}\n${index > 10 ? "شكرا لكم على المشاهدة" : ARABIC_LINES[index]}`).join("\n\n")}\n`;
}

// Minimal stored ZIP writer (no compression) for archive tests.
export function zipStore(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.declaredSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}
