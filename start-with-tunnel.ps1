$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerProcess = $null
$StartedServer = $false
Set-Location -LiteralPath $ProjectDirectory

if (-not (Test-Path -LiteralPath ".env")) {
    Write-Host "Run .\start.ps1 once, then add OPENSUBTITLES_API_KEY to .env." -ForegroundColor Yellow
    exit 1
}
$Cloudflared = Join-Path $ProjectDirectory "tools\cloudflared.exe"
$SshPath = (Get-Command ssh -ErrorAction SilentlyContinue).Source
if (-not $SshPath -and -not (Test-Path -LiteralPath $Cloudflared)) {
    Write-Host "Neither Windows OpenSSH nor tools\cloudflared.exe is available." -ForegroundColor Red
    exit 1
}

try {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:7000/health" -TimeoutSec 2
        Write-Host "Using the Arabic SyncRank server already running on port 7000." -ForegroundColor Green
    } catch {
        $NodePath = (Get-Command node -ErrorAction Stop).Source
        $ServerProcess = Start-Process -FilePath $NodePath -ArgumentList "--env-file-if-exists=.env", "src/server.js" -WorkingDirectory $ProjectDirectory -WindowStyle Hidden -PassThru
        $StartedServer = $true
        Start-Sleep -Seconds 2
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:7000/health" -TimeoutSec 5
        Write-Host "Started Arabic SyncRank on port 7000." -ForegroundColor Green
    }

    Write-Host "Starting a temporary HTTPS tunnel..." -ForegroundColor Cyan
    Write-Host "Keep this window open while using the addon. Press Ctrl+C to stop." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $Cloudflared) {
        Write-Host "Open the https://....trycloudflare.com/configure URL printed below." -ForegroundColor Cyan
        & $Cloudflared tunnel --url "http://127.0.0.1:7000" --no-autoupdate
    } else {
        Write-Host "Open the https://....lhr.life/configure URL printed below." -ForegroundColor Cyan
        & $SshPath -T -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=30 -R 80:127.0.0.1:7000 nokey@localhost.run
    }
} finally {
    if ($StartedServer -and $ServerProcess -and -not $ServerProcess.HasExited) {
        Stop-Process -Id $ServerProcess.Id
    }
}
