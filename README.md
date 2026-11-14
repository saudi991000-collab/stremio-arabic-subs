# Arabic Elite Subtitles 3.6.0

Stremio subtitle add-on that returns up to 30 verified, human-made Arabic subtitles
from many sources, ranked by how well they match the playing release.

```
npm start        # Node.js 22
npm test         # 141 automated tests
node --env-file-if-exists=.env scripts/audit-live-sources.mjs   # live provider audit
```

Routes: `/manifest.json`, `/configure`, `/health`, `/subtitles/...`, `/subtitle/...`.

## Pipeline
providers (parallel, per-provider AbortController + timeout, retries with backoff and
jitter, per-host rate limits, host allow-lists) → immutable snapshot → merged into a
persistent search cache (complete/partial per provider) → release matching (hash,
release name, season/episode/absolute episode, platform, source, group, FPS) →
download + content inspection (real format and encoding, archive safety, Arabic
text ratio, machine-translation and repetition checks, cue density and duration) →
optional timing alignment (multi-window, RANSAC, frame-rate scales, safe piecewise)
→ deterministic ranking and labels → signed subtitle URLs with fallbacks.

## Labels
`3 ✅ Memories • BD 720p DeadFish 🎨` — number, marks, who made it (Arabic team from
`config/arabic-teams.json`, else the source site), and the video it was made for
(platform or source, resolution, release group).
- ✅ made for this very release: same file hash, same release name, same group or
  frame rate, or same platform and source.
- 📌 picked for this episode before · ⭐/👎 rated · 🎯 timing checked · ⏱ timing
  corrected · ⚠️ references disagree on timing · 🎨 styling confirmed in the file.

Order: picked before, then closest to the video's release (hash, name, fps, platform,
source, group), then the team picked last in this series, Arabic teams, styling and
quality. The same file from several sources (same words, same length) is listed once.

Original ASS/SSA files are served unchanged except for timing. Stremio clients render
advanced ASS effects differently; VLC or mpv render them most faithfully.

## Stability
Search results are stored per request (type, id, filename, hash, size) on disk and,
when `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set, in Upstash Redis so
they survive Render restarts. Partial results never replace complete ones; providers
that answer late are merged in the background; stale entries are served while a
refresh runs. Validation verdicts are remembered, timeouts never count as rejections.

## Synchronization
Without the local companion the add-on cannot hear the video. It uses an English
reference subtitle (exact hash first, then best release match) when available.
With the local add-on + Stremio Enhanced plugin (`enhanced/`), it samples five points
of the real audio locally (Whisper if installed, else ffmpeg voice activity) or the
embedded text track. Corrections are applied only when confidence ≥
`SYNC_MIN_CONFIDENCE`; otherwise the original file is served unchanged.

See [README-AR.md](README-AR.md), [UPDATE-3.6.0-AR.md](UPDATE-3.6.0-AR.md) and
[SOURCES.md](SOURCES.md).
