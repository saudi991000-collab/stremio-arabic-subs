$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $ProjectDirectory "enhanced\ArabicSyncAutoSelect.plugin.js"

Write-Host "In Stremio Enhanced, open Settings > OPEN PLUGINS FOLDER." -ForegroundColor Cyan
Write-Host "Copy this file into that folder:" -ForegroundColor Cyan
Write-Host $Source -ForegroundColor Green
Write-Host "Then restart Stremio Enhanced or press Ctrl+R."
