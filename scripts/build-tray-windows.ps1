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
$stageDir = Join-Path $outDir "tray-windows-stage"
$zipPath = Join-Path $outDir "trapezohe-companion-tray-windows.zip"
$planJson = & node (Join-Path $root "scripts/windows-build-plan.mjs") --json
if ($LASTEXITCODE -ne 0) {
    throw "Failed to resolve Windows tray build plan."
}
$plan = $planJson | ConvertFrom-Json
$exeName = [string]$plan.exeName
$exeSource = Join-Path $root ([string]$plan.exeRelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)

if (Test-Path $stageDir) {
    Remove-Item $stageDir -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

& $plan.cargoCommand @($plan.cargoArgs)
if ($LASTEXITCODE -ne 0) {
    throw "Windows tray build failed."
}

Copy-Item $exeSource (Join-Path $stageDir $exeName)
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
