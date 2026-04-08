$ErrorActionPreference = "Stop"

$ReleaseMsiUrl = "https://github.com/Trapezohe/companion_service/releases/latest/download/trapezohe-companion-windows.msi"
$Passive = $true
$IgnoredOptions = @()

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch ($arg) {
        "--non-interactive" { $Passive = $false; continue }
        "-y" { $Passive = $false; continue }
        "--yes" { $Passive = $false; continue }
        "--mode" {
            $IgnoredOptions += "--mode"
            if ($i + 1 -lt $args.Count) { $i++ }
            continue
        }
        "--workspace" {
            $IgnoredOptions += "--workspace"
            if ($i + 1 -lt $args.Count) { $i++ }
            continue
        }
        "--no-autostart" {
            $IgnoredOptions += "--no-autostart"
            continue
        }
        "--no-start" {
            $IgnoredOptions += "--no-start"
            continue
        }
        default { continue }
    }
}

Write-Host ""
Write-Host "GhastAI Companion installer" -ForegroundColor Cyan
Write-Host ""

if ($IgnoredOptions.Count -gt 0) {
    Write-Host "Warning: the Windows script now installs the signed MSI package directly." -ForegroundColor Yellow
    Write-Host "Ignored options: $($IgnoredOptions -join ', ')" -ForegroundColor Yellow
    Write-Host ""
}

$tempMsi = Join-Path $env:TEMP "ghastai-companion-latest.msi"

try {
    Write-Host "Downloading latest Windows installer..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $ReleaseMsiUrl -OutFile $tempMsi

    $msiArgs = @("/i", "`"$tempMsi`"", "/norestart")
    if ($Passive) {
        $msiArgs += "/passive"
    } else {
        $msiArgs += "/qn"
    }

    Write-Host "Launching Windows installer..." -ForegroundColor Yellow
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "msiexec exited with code $($proc.ExitCode)"
    }

    Write-Host ""
    Write-Host "GhastAI Companion installation complete." -ForegroundColor Green
    Write-Host "If the tray does not appear immediately, open GhastAI Companion from the Start menu once." -ForegroundColor Green
} finally {
    Remove-Item -Path $tempMsi -Force -ErrorAction SilentlyContinue
}
