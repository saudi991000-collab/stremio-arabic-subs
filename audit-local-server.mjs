const base = "http://127.0.0.1:7000";
const samples = [
  ["movie", "tt10872600", "Spider.Man.No.Way.Home.2021.1080p.BluRay.mkv"],
  ["series", "tt3581920:1:1", "The.Last.of.Us.S01E01.1080p.WEB-DL.mkv"],
  ["series", "tt0994314:1:1", "Code.Geass.S01E01.1080p.BluRay.mkv"]
];

const report = [];
for (const [type, id, fileName] of samples) {
  const response = await fetch(`${base}/subtitles/${type}/${id}/filename=${encodeURIComponent(fileName)}.json`, { signal: AbortSignal.timeout(15000) });
  const payload = await response.json();
  const checks = [];
  for (const subtitle of (payload.subtitles || []).slice(0, 3)) {
    try {
      const file = await fetch(subtitle.url, { signal: AbortSignal.timeout(25000) });
      const text = await file.text();
      checks.push({ label: subtitle.label, status: file.status, arabic: /[\u0600-\u06ff]{4}/.test(text), bytes: Buffer.byteLength(text) });
    } catch (error) {
      checks.push({ label: subtitle.label, status: 0, arabic: false, error: error?.message || String(error) });
    }
  }
  report.push({ type, id, count: payload.subtitles?.length || 0, labels: (payload.subtitles || []).slice(0, 8).map((item) => item.label), checks });
}
console.log(JSON.stringify(report, null, 2));
