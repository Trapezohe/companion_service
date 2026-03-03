$ErrorActionPreference = "Stop"

$version = "__COMPANION_VERSION__"
$nodeVersion = "v22.12.0"
$minNodeMajor = 18
$workspace = Join-Path $env:USERPROFILE "trapezohe-workspace"
$trapezoheDir = Join-Path $env:USERPROFILE ".trapezohe"
$localNodeDir = Join-Path $trapezoheDir "node"
$logDir = Join-Path $env:ProgramData "TrapezoheCompanion"
$logFile = Join-Path $logDir "installer.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-InstallerLog([string]$message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$timestamp] $message"
}

function Test-UsableNode {
  $nodePath = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodePath) { return $false }
  try {
    $ver = & node -v 2>$null
    $major = [int]($ver -replace '^v','').Split('.')[0]
    return $major -ge $minNodeMajor
  } catch {
    return $false
  }
}

function Ensure-Node {
  # Check system Node.js
  if (Test-UsableNode) {
    $ver = & node -v
    Write-InstallerLog "Using system Node.js: $ver"
    return
  }

  # Check existing local copy
  $localNode = Join-Path $localNodeDir "node.exe"
  if (Test-Path $localNode) {
    $env:PATH = "$localNodeDir;$env:PATH"
    if (Test-UsableNode) {
      $ver = & node -v
      Write-InstallerLog "Using local Node.js: $ver"
      return
    }
  }

  # Download portable Node.js
  $arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  } else { "x86" }

  $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$arch.zip"
  $zipPath = Join-Path $env:TEMP "node-$nodeVersion-win-$arch.zip"

  Write-InstallerLog "Node.js not found - downloading $nodeVersion ($arch)..."
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    New-Item -ItemType Directory -Force -Path $localNodeDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $env:TEMP -Force

    # Move contents from extracted folder (node-vXX.XX.XX-win-x64/) to local dir
    $extracted = Join-Path $env:TEMP "node-$nodeVersion-win-$arch"
    Get-ChildItem -Path $extracted | Move-Item -Destination $localNodeDir -Force
    Remove-Item -Path $extracted -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

    $env:PATH = "$localNodeDir;$env:PATH"
    $ver = & node -v
    Write-InstallerLog "Installed local Node.js: $ver -> $localNodeDir"
  } catch {
    Write-InstallerLog "Failed to download Node.js: $_"
    Write-InstallerLog "Please install Node.js $minNodeMajor+ manually from https://nodejs.org"
    exit 1
  }
}

Write-InstallerLog "Windows installer bootstrap started (version=$version)."

Ensure-Node

npm install -g "trapezohe-companion@$version"
if ($LASTEXITCODE -ne 0) {
  Write-InstallerLog "npm install failed with exit code $LASTEXITCODE. Installation continues for manual retry."
  exit 0
}

trapezohe-companion bootstrap --mode workspace --workspace "$workspace"
if ($LASTEXITCODE -ne 0) {
  Write-InstallerLog "bootstrap failed with exit code $LASTEXITCODE. Installation continues for manual retry."
  exit 0
}

Write-InstallerLog "Bootstrap finished successfully."
exit 0
