param(
    [string]$Version = "",
    [switch]$StageOnly
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
    $Version = $package.version
}

$outDir = Join-Path $root "dist/installers"
$buildDir = Join-Path $root "tray/target/release"
$exeName = "trapezohe-companion-tray.exe"
$stageDir = Join-Path $outDir "tray-windows-stage"
$zipPath = Join-Path $outDir "trapezohe-companion-tray-windows.zip"

if (Test-Path $stageDir) {
    Remove-Item $stageDir -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

cargo build --manifest-path (Join-Path $root "tray/Cargo.toml") --release

Copy-Item (Join-Path $buildDir $exeName) (Join-Path $stageDir $exeName)
Copy-Item (Join-Path $root "tray/icons/icon.png") (Join-Path $stageDir "icon.png")
@"
Trapezohe Companion Tray
Version: $Version

This stage directory contains the tray executable used by the platform installers.
"@ | Set-Content (Join-Path $stageDir "README.txt")

if (-not $StageOnly) {
    Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
    Write-Host "Built $zipPath"
} else {
    Write-Host "Staged $stageDir"
}
