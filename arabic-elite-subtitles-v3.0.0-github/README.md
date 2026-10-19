# ترجمة النخبة 3.0.0

A dependency-free, self-hosted Stremio addon that returns up to 25 ranked human Arabic subtitles. It groups every result under `ara` and puts rank, trust, real format and provider in `label`, so compatible Stremio clients show one Arabic language with multiple variants. It supports SRT, VTT, ASS and SSA and does not generate AI translations. See [README-AR.md](README-AR.md) for complete Arabic setup instructions.

Requirements: Node.js 22+, an OpenSubtitles.com API consumer key, and a server reachable by the Stremio device.

```powershell
Copy-Item .env.example .env
# Edit .env
./start.ps1
node --test
```

Install URL: `http://YOUR-SERVER:7000/manifest.json`

Stremio accepts plain HTTP only on `127.0.0.1`. Run `./start-with-tunnel.ps1` to obtain a temporary HTTPS URL for Android TV or another device.

The optional Stremio Enhanced desktop helper is `enhanced/ArabicSyncAutoSelect.plugin.js`.
