$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDirectory

if (-not (Test-Path -LiteralPath ".env")) {
    $Template = Get-Content -LiteralPath ".env.example" -Raw
    $SecretBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $Secret = [Convert]::ToHexString($SecretBytes).ToLowerInvariant()
    $Template = $Template.Replace("change-this-to-a-long-random-secret", $Secret)
    Set-Content -LiteralPath ".env" -Value $Template -Encoding utf8NoBOM
    Write-Host "Created .env. Add your OPENSUBTITLES_API_KEY, then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Arabic SyncRank: http://127.0.0.1:7000/configure" -ForegroundColor Cyan
node --env-file-if-exists=.env src/server.js
