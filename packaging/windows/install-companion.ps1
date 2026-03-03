$ErrorActionPreference = "Stop"

$version = "__COMPANION_VERSION__"
$workspace = Join-Path $env:USERPROFILE "trapezohe-workspace"
$logDir = Join-Path $env:ProgramData "TrapezoheCompanion"
$logFile = Join-Path $logDir "installer.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-InstallerLog([string]$message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$timestamp] $message"
}

Write-InstallerLog "Windows installer bootstrap started (version=$version)."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-InstallerLog "Node.js 18+ not found. Skipping bootstrap; user can retry from extension Settings > Companion."
  exit 0
}

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
