# Trapezohe Companion — One-click installer for Windows
# Usage: irm https://raw.githubusercontent.com/Trapezohe/companion_service/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$NonInteractive = $false
$Mode = "workspace"
$WorkspaceRoot = ""
$EnableAutostart = $true
$StartNow = $true

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch ($arg) {
        "--non-interactive" { $NonInteractive = $true; continue }
        "-y" { $NonInteractive = $true; continue }
        "--yes" { $NonInteractive = $true; continue }
        "--mode" {
            if ($i + 1 -lt $args.Count) {
                $i++
                $Mode = $args[$i]
            }
            continue
        }
        "--workspace" {
            if ($i + 1 -lt $args.Count) {
                $i++
                $WorkspaceRoot = $args[$i]
            }
            continue
        }
        "--no-autostart" { $EnableAutostart = $false; continue }
        "--no-start" { $StartNow = $false; continue }
        default { continue }
    }
}

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

function Run-Bootstrap {
    Write-Host "  -> Running one-shot bootstrap..." -ForegroundColor Yellow
    $bootstrapArgs = @("bootstrap", "--mode", $Mode)
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
        $bootstrapArgs += @("--workspace", $WorkspaceRoot)
    }
    if (-not $EnableAutostart) {
        $bootstrapArgs += "--no-autostart"
    }
    if (-not $StartNow) {
        $bootstrapArgs += "--no-start"
    }

    & trapezohe-companion @bootstrapArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
    Write-Host "  OK Bootstrap complete" -ForegroundColor Green
}

# ── Register Native Messaging Host ──

function Register-NativeHost {
    Write-Host ""
    Write-Host "  Chrome Native Messaging (auto-pairing)" -ForegroundColor White
    Write-Host ""
    Write-Host "  Registering the built-in Ghast extension pairing..."
    & trapezohe-companion register 2>&1 | ForEach-Object { Write-Host "    $_" }
    Write-Host "  OK Native messaging host registered for Ghast" -ForegroundColor Green
}

# ── Auto-start (default: enabled) ──

function Setup-Autostart {
    Write-Host ""
    $reply = Read-Host "  Enable auto-start on login? (Y/n)"
    if ($reply -eq "n" -or $reply -eq "N") {
        Write-Host "  WARNING: Skipped. You can set it up later manually." -ForegroundColor Yellow
        return
    }

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

if ($NonInteractive) {
    Run-Bootstrap
    Write-Host ""
    Write-Host "  Installation complete!" -ForegroundColor Green
    Write-Host "  Companion has been set up in non-interactive mode."
    Write-Host ""
    exit 0
}

Init-Config
Register-NativeHost
Setup-Autostart

if ($StartNow) {
    & trapezohe-companion start -d 2>$null | Out-Null
}

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:"
Write-Host "    trapezohe-companion start      # Start in foreground"
Write-Host "    trapezohe-companion start -d    # Start as daemon"
Write-Host "    trapezohe-companion status      # Check status"
Write-Host ""
Write-Host "  Config: $env:USERPROFILE\.trapezohe\companion.json"
Write-Host "  Docs:   https://github.com/Trapezohe/companion_service"
Write-Host ""
