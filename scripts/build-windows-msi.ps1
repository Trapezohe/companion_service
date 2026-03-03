param(
  [Parameter(Mandatory = $false)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($Version)) {
  $pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
  $Version = [string]$pkg.version
}

$outDir = Join-Path $root "dist/installers"
$workDir = Join-Path $env:TEMP ("trapezohe-companion-msi-" + [guid]::NewGuid().ToString("N"))
$sourceDir = Join-Path $workDir "source"
$wxsPath = Join-Path $root "packaging/windows/installer.wxs"
$msiPath = Join-Path $outDir "trapezohe-companion-windows.msi"

New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Copy-Item (Join-Path $root "packaging/windows/run-install.cmd") (Join-Path $sourceDir "run-install.cmd")
$psTemplate = Get-Content (Join-Path $root "packaging/windows/install-companion.ps1") -Raw
$psRendered = $psTemplate -replace "__COMPANION_VERSION__", $Version
Set-Content -Path (Join-Path $sourceDir "install-companion.ps1") -Value $psRendered -Encoding UTF8

$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix) {
  dotnet tool install --global wix --version 4.0.5 | Out-Null
  $env:PATH += ";$env:USERPROFILE\\.dotnet\\tools"
}

wix build `
  -define ProductVersion=$Version `
  -define InstallerSourceDir=$sourceDir `
  -o $msiPath `
  $wxsPath

Write-Host "Built $msiPath"
