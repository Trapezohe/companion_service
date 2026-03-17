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
$trayStageRoot = Join-Path $root "dist/stage"
$tempRoot = if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
  $env:TEMP
} elseif (-not [string]::IsNullOrWhiteSpace($env:TMPDIR)) {
  $env:TMPDIR
} else {
  [System.IO.Path]::GetTempPath()
}
$workDir = Join-Path $tempRoot ("trapezohe-companion-msi-" + [guid]::NewGuid().ToString("N"))
$sourceDir = Join-Path $workDir "source"
$trayStageDir = Join-Path $trayStageRoot "windows-tray"
$msiPlanScript = Join-Path $root "scripts/windows-msi-plan.mjs"
$packageTarballPath = Join-Path $sourceDir "trapezohe-companion-package.tgz"
$msiPath = Join-Path $outDir "trapezohe-companion-windows.msi"
$generatedWxsPath = Join-Path $workDir "installer.generated.wxs"

New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Copy-Item (Join-Path $root "packaging/windows/run-install.cmd") (Join-Path $sourceDir "run-install.cmd")
Copy-Item (Join-Path $root "packaging/windows/license.rtf") (Join-Path $sourceDir "license.rtf")
$psTemplate = Get-Content (Join-Path $root "packaging/windows/install-companion.ps1") -Raw
$psRendered = $psTemplate -replace "__COMPANION_VERSION__", $Version
Set-Content -Path (Join-Path $sourceDir "install-companion.ps1") -Value $psRendered -Encoding UTF8

Push-Location $root
$packJson = & npm pack --pack-destination $workDir --json
$packExitCode = $LASTEXITCODE
Pop-Location
if ($packExitCode -ne 0) {
  throw "Failed to pack the companion npm payload for the Windows installer."
}

$packResult = $packJson | ConvertFrom-Json
$packFileName = if ($packResult -is [array]) { $packResult[0].filename } else { $packResult.filename }
if ([string]::IsNullOrWhiteSpace($packFileName)) {
  throw "npm pack did not report a tarball filename."
}

$packedTarball = Join-Path $workDir $packFileName
if (-not (Test-Path $packedTarball)) {
  throw "Packed tarball missing at $packedTarball"
}
Copy-Item $packedTarball $packageTarballPath

& (Join-Path $root "scripts/build-tray-windows.ps1") -Version $Version
Copy-Item (Join-Path $trayStageDir "trapezohe-companion-tray.exe") (Join-Path $sourceDir "trapezohe-companion-tray.exe")
Copy-Item (Join-Path $trayStageDir "README.txt") (Join-Path $sourceDir "tray.README.txt")

$planJson = & node $msiPlanScript --json
if ($LASTEXITCODE -ne 0) {
  throw "Failed to resolve Windows MSI build plan."
}
$plan = $planJson | ConvertFrom-Json

$renderedWxs = & node $msiPlanScript --render --schema-version $plan.schemaVersion --product-version $Version --installer-source-dir $sourceDir
if ($LASTEXITCODE -ne 0) {
  throw "Failed to render Windows MSI source."
}
Set-Content -Path $generatedWxsPath -Value $renderedWxs -Encoding UTF8

if ($plan.builder -eq "wix") {
  $wix = Get-Command wix -ErrorAction SilentlyContinue
  if (-not $wix) {
    dotnet tool install --global wix --version 4.0.5 | Out-Null
    $env:PATH += ";$env:USERPROFILE\\.dotnet\\tools"
  }
  wix extension add WixToolset.UI.wixext/4.0.5 | Out-Null

  wix build `
    -arch x64 `
    -ext WixToolset.UI.wixext `
    -define ProductVersion=$Version `
    -define InstallerSourceDir=$sourceDir `
    -o $msiPath `
    $generatedWxsPath
} elseif ($plan.builder -eq "wixl") {
  $wixl = Get-Command wixl -ErrorAction SilentlyContinue
  if (-not $wixl) {
    throw "wixl is required on non-Windows hosts. Install msitools (for example: brew install msitools)."
  }

  wixl -o $msiPath $generatedWxsPath
} else {
  throw "Unsupported Windows MSI builder: $($plan.builder)"
}

if (-not (Test-Path $msiPath)) {
  throw "Windows MSI build did not produce an output file at $msiPath"
}

Write-Host "Built $msiPath"
