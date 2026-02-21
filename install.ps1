# Trapezohe Companion — One-click installer for Windows
# Usage: irm https://raw.githubusercontent.com/trapezohe/companion/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host "   Trapezohe Companion Installer  " -ForegroundColor Cyan
Write-Host "  ===============================" -ForegroundColor Cyan
Write-Host ""

# ── Check Node.js ──

function Check-Node {
    try {
        $nodeVersion = & node -v 2>$null
    } catch {
        Write-Host "  ERROR: Node.js is not installed." -ForegroundColor Red
        Write-Host ""
        Write-Host "  Install Node.js 18+ from: https://nodejs.org/"
        Write-Host "  Or using winget: winget install OpenJS.NodeJS.LTS"
        Write-Host ""
        exit 1
    }

    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Host "  ERROR: Node.js 18+ required (found: $nodeVersion)" -ForegroundColor Red
        exit 1
    }

    Write-Host "  OK Node.js $nodeVersion detected" -ForegroundColor Green
}

# ── Install package ──

function Install-Companion {
    Write-Host "  -> Installing trapezohe-companion globally..." -ForegroundColor Yellow
    & npm install -g trapezohe-companion 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm install failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK Package installed" -ForegroundColor Green
}

# ── Initialize config ──

function Init-Config {
    Write-Host "  -> Initializing configuration..." -ForegroundColor Yellow
    & trapezohe-companion init 2>&1 | ForEach-Object { Write-Host "    $_" }
    Write-Host "  OK Config created" -ForegroundColor Green
}

# ── Optional: Auto-start ──

function Setup-Autostart {
    Write-Host ""
    $reply = Read-Host "  Set up auto-start on login? (y/N)"
    if ($reply -ne "y" -and $reply -ne "Y") { return }

    $cliPath = (Get-Command trapezohe-companion -ErrorAction SilentlyContinue).Source
    if (-not $cliPath) {
        Write-Host "  WARNING: Could not locate trapezohe-companion. Skipping." -ForegroundColor Yellow
        return
    }

    $taskName = "TrapezoheCompanion"
    $action = New-ScheduledTaskAction -Execute $cliPath -Argument "start"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "  OK Scheduled task '$taskName' created" -ForegroundColor Green
}

# ── Main ──

Check-Node
Install-Companion
Init-Config
Setup-Autostart

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:"
Write-Host "    trapezohe-companion start      # Start in foreground"
Write-Host "    trapezohe-companion start -d    # Start as daemon"
Write-Host "    trapezohe-companion status      # Check status"
Write-Host ""
Write-Host "  Config: $env:USERPROFILE\.trapezohe\companion.json"
Write-Host "  Docs:   https://github.com/trapezohe/companion"
Write-Host ""
