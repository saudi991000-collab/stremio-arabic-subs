import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { polishSubtitle, isAdvert, isCredit, markLine } from "../src/polish.js";
import { TimingMemory, itemId } from "../src/timing-memory.js";
import { JsonStore } from "../src/store.js";
import { parseArabicRows, parseMovieTitle, parseSearchResults } from "../src/providers/moviesubtitles.js";
import { detailedResultLabel, sortForDisplay } from "../src/server.js";
import { parseTimeline } from "../src/timing.js";

const RLM = "\u200F";

test("marks every Arabic line right-to-left without touching other text", () => {
  assert.equal(markLine("- هل أنت بخير؟"), `${RLM}- هل أنت بخير؟`);
  assert.equal(markLine("<i>...نعم</i>"), `<i>${RLM}...نعم</i>`);
  assert.equal(markLine("{\an8}مرحبا"), `{\an8}${RLM}مرحبا`);
  assert.equal(markLine("Hello there"), "Hello there");
  assert.equal(markLine(`${RLM}مرحبا`), `${RLM}مرحبا`);
});

test("removes adverts and mid-episode credits but keeps the opening credit and dialogue", () => {
  assert.equal(isAdvert("تابعونا على قناتنا في تيليجرام"), true);
  assert.equal(isAdvert("www.example.com"), true);
  assert.equal(isAdvert("ضعها على فيسبوك يا رجل"), false);
  assert.equal(isCredit("ترجمة: أحمد علي"), true);
  assert.equal(isCredit("أحتاج ترجمة لهذا الكتاب قبل الغد"), false);
  const cues = [
    [1, 3, "ترجمة: أحمد علي"],
    ...Array.from({ length: 10 }, (_, index) => [10 + index * 60, 12 + index * 60, `جملة حوار رقم ${index}`]),
    [1200, 1203, "ترجمة وتعديل فريق النخبة"],
    [1300, 1303, "زوروا موقع subs-ar.com للمزيد"]
  ];
  const clock = (t) => new Date(t * 1000).toISOString().slice(11, 23).replace(".", ",");
  const srt = cues.map(([a, b, text], index) => `${index + 1}\n${clock(a)} --> ${clock(b)}\n${text}`).join("\n\n");
  const out = polishSubtitle(srt, "srt");
  assert.match(out, /أحمد علي/);
  assert.doesNotMatch(out, /فريق النخبة/);
  assert.doesNotMatch(out, /subs-ar\.com/);
  assert.match(out, /جملة حوار رقم 9/);
  assert.match(out, /^1\n/);
});

test("extends lines too short to read and ends overlapping lines before the next", () => {
  const srt = "1\n00:00:01,000 --> 00:00:01,300\nجملة طويلة نوعا ما تحتاج وقتا للقراءة\n\n2\n00:00:06,000 --> 00:00:09,000\nالجملة الثانية\n\n3\n00:00:08,000 --> 00:00:10,000\nالجملة الثالثة\n";
  const cues = parseTimeline(polishSubtitle(srt, "srt"));
  assert.ok(cues[0].end - cues[0].start >= 2, `${cues[0].end}`);
  assert.ok(cues[0].end < 6);
  assert.ok(cues[1].end <= 8, `${cues[1].end}`);
  // ASS overlaps are deliberate and stay.
  const ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:06.00,0:00:09.00,Default,,0,0,0,,{\an8}لافتة\nDialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,حوار";
  const polished = polishSubtitle(ass, "ass");
  assert.match(polished, /0:00:06\.00,0:00:09\.00,Default,,0,0,0,,\{\an8\}\u200Fلافتة/);
});

test("ratings put a liked subtitle first and a disliked one last", async () => {
  const memory = new TimingMemory(new JsonStore({ directory: await mkdtemp(path.join(tmpdir(), "ratings-")), namespace: "timing", ttlSeconds: 3600 }));
  const media = { type: "series", imdbId: "0165581", season: 1, episode: 1 };
  const key = "timing:v1:tt0165581:1:1|f:koq.mkv";
  const liked = itemId({ provider: "subdl", ref: "2" });
  await memory.rate(key, liked, 1);
  await memory.rate(key, itemId({ provider: "subdl", ref: "3" }), -1);
  const ratings = await memory.ratings({ media });
  assert.equal(ratings[liked], 1);
  const sorted = sortForDisplay([
    { provider: "subdl", fileId: 1, reasons: ["exact-hash"], deepAnalyzed: true },
    { provider: "subdl", fileId: 2, userRating: 1 },
    { provider: "subdl", fileId: 3, userRating: -1, reasons: ["exact-hash"] }
  ]);
  assert.deepEqual(sorted.map((item) => item.fileId), [2, 1, 3]);
  assert.match(detailedResultLabel({ provider: "subdl", fileName: "a.srt", userRating: 1, timingCorrected: true }, 0), /^1 ⭐.*⏱/);
  await assert.rejects(memory.rate("bad", liked, 1), /Unknown subtitle/);
});

test("reads MovieSubtitles search results and the Arabic block", () => {
  assert.deepEqual(parseMovieTitle("King and Four Queens, The (1956)"), { title: "The King and Four Queens", year: 1956 });
  assert.deepEqual(parseSearchResults('<a href="/movie-5012.html">Inception (2010)</a>'), [{ id: "5012", title: "Inception", year: 2010 }]);
  const html = `<b>English  subtitles:</b><a href="/subtitle-1.html"><b>Inception 2010 english subtitles (BluRay)</b>
    <b>Arabic  subtitles:</b></span><a href="/subtitle-61316.html" title="x"><div><a href="/subtitle-61316.html"><b>Inception 2010 arabic subtitles (DVDRip.MAXSPEED)</b>
    <span style="color:red">41</span>/<span style="color:green">48</span>
    <b>Greek  subtitles:</b><a href="/subtitle-9.html"><b>Inception greek (x)</b>`;
  const rows = parseArabicRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "61316");
  assert.equal(rows[0].release, "DVDRip.MAXSPEED");
  assert.equal(rows[0].good, 48);
});
