# Subtitle sources — live verification (2026-10-21)

Each row was tested live by `scripts/audit-live-sources.mjs`: search, download
and content inspection of real files (Spider-Man: No Way Home, The Last of Us
S01E01, Code Geass S01E01).

| Provider | Key | Status | Notes |
|---|---|---|---|
| OpenSubtitles.org REST (`opensubtitles-org`) | none | ✅ **new**, verified movie/TV/anime | 13 / 9 / 8 Arabic results; exposes machine-translation flag and hash matching. Also an English timing reference. |
| YIFY Subtitles (`yifysubtitles`) | none | ✅ **new**, verified (movies only) | 18 Arabic results for the test movie. |
| TheSubtitleDB | none | ✅ verified | Download host fixed (`files.thesubtitledb.org`). |
| Subf2m | none | ✅ verified movie/TV | Download CDN fixed (`isubcdn.com`). No result for the anime sample. |
| SubKong | none | ✅ verified | |
| OpenSubtitles v3 (Stremio) | none | ✅ verified | |
| MiraiAnime | none | ✅ verified (anime) | |
| AniKoto | none | ✅ repaired | AniList API is disabled (HTTP 403); mapping moved to arm.haglund.dev. Subtitles come from third-party streaming CDNs — keep or disable with `ENABLE_ANIKOTO=false`. |
| Mora (archive.org) | none | ⚠️ not verifiable today | archive.org connections timed out from the test network (worked in the first audit run). Code unchanged apart from safe fetching; isolated by timeouts. |
| OpenSubtitles.com API | key | ✅ verified with the owner's key | 50 / 13 / 7 results. Free accounts may download only 5 files per 24 h (HTTP 406); this is now treated as a temporary quota, never as a bad file. Set `OPENSUBTITLES_PASSWORD` to raise the quota. |
| SubSource | key | ✅ verified with the owner's key | 30 / 52 / 27 results, downloads verified (including season ZIPs). |
| Wyzie | key | ✅ verified with the owner's key | 32 / 9 / 7 results, downloads verified. |
| SubDL | key | ✅ **fixed**, verified | The old request sent `hi=1`, which SubDL treats as "hearing-impaired only" (1 result). Without it: 38 / 180 / 228 results. |
| TVsubtitles (`tvsubtitles`) | none | ✅ **new**, verified (TV only) | Arabic track on many shows (e.g. House of the Dragon, every S01 episode). No Arabic for the three audit samples. |
| ArabicSubs | key | ❌ key rejected | Server answers `invalid_api_key` ("مفتاح API غير صالح أو ملغى"). A new key is needed. |

Stremio add-on catalogue review (api.strem.io and stremio-addons.net, 140+ subtitle add-ons):
- Machine/AI translators (Auto Subtitle Translate, SubTranslate, MultiSub, AnySubs, Subtito, DualSubs, AIO PRO…) — excluded by design.
- Arabic aggregators ("ترجمة عربية مجمّعة", Wyzie AR, DZ-Arabic) — use SubDL/SubSource/Wyzie, already integrated directly, or are offline.
- Community Subtitles, SubSense, KONTYX — require per-user configuration; SubSense's sources were compared one by one (TVsubtitles was the only missing one with Arabic and was added).
- AnimeTosho — extracts subtitles from torrent releases; not added.

Investigated and **not added**:
- isubtitles.org — Subscene archive mirror already covered by Subf2m; search did not find the test film.
- Subscene mirrors, Subtitlist — Cloudflare challenge (not bypassed).
- Podnapisi — domain did not resolve (ENOTFOUND) from the test network.
- Gestdown / Addic7ed — API works but returned no Arabic subtitles for tested shows.
- BSPlayer subtitle API — endpoint returned 404.
- Netflix, Crunchyroll, Disney+, Amazon, Max: no public subtitle API exists; the
  add-on only reads platform markers (NF, CR, AMZN, DSNP, HMAX…) from indexed file names.

No source is accessed by bypassing CAPTCHA, Cloudflare, logins or DRM.
