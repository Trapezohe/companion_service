$ErrorActionPreference = "Stop"

$version = "__COMPANION_VERSION__"
$nodeVersion = "v22.12.0"
$minNodeMajor = 18
$workspace = Join-Path $env:USERPROFILE "trapezohe-workspace"
$trapezoheDir = Join-Path $env:USERPROFILE ".trapezohe"
$localNodeDir = Join-Path $trapezoheDir "node"
$startupPolicyPath = Join-Path $trapezoheDir "companion-startup.json"
$legacyTrayPrefsPath = Join-Path $trapezoheDir "companion-tray.json"
$trayExePath = Join-Path $PSScriptRoot "trapezohe-companion-tray.exe"
$trayRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$trayRunValueName = "TrapezoheCompanionTray"
$legacyDaemonTaskName = "TrapezoheCompanion"
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
  if (Test-UsableNode) {
    $ver = & node -v
    Write-InstallerLog "Using system Node.js: $ver"
    return $true
  }

  $localNode = Join-Path $localNodeDir "node.exe"
  if (Test-Path $localNode) {
    $env:PATH = "$localNodeDir;$env:PATH"
    if (Test-UsableNode) {
      $ver = & node -v
      Write-InstallerLog "Using local Node.js: $ver"
      return $true
    }
  }

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

    $extracted = Join-Path $env:TEMP "node-$nodeVersion-win-$arch"
    Get-ChildItem -Path $extracted | Move-Item -Destination $localNodeDir -Force
    Remove-Item -Path $extracted -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

    $env:PATH = "$localNodeDir;$env:PATH"
    $ver = & node -v
    Write-InstallerLog "Installed local Node.js: $ver -> $localNodeDir"
    return $true
  } catch {
    Write-InstallerLog "Failed to download Node.js: $_"
    Write-InstallerLog "Please install Node.js $minNodeMajor+ manually from https://nodejs.org"
    return $false
  }
}

function Write-StartupPolicy {
  New-Item -ItemType Directory -Force -Path $trapezoheDir | Out-Null
  @{
    loginItem = 'tray'
    ensureDaemonOnTrayLaunch = $true
  } | ConvertTo-Json | Set-Content -Path $startupPolicyPath -Encoding UTF8
  Remove-Item -Path $legacyTrayPrefsPath -Force -ErrorAction SilentlyContinue
  Write-InstallerLog "Wrote unified startup policy to $startupPolicyPath"
}

function Remove-LegacyDaemonAutostart {
  schtasks /Delete /TN $legacyDaemonTaskName /F *> $null 2>&1
  Write-InstallerLog "Removed legacy daemon scheduled task if present"
}

function Register-TrayAutoStart {
  if (-not (Test-Path $trayExePath)) {
    Write-InstallerLog "Tray executable missing at $trayExePath; skipping tray auto-start registration"
    return
  }

  New-Item -Path $trayRunKey -Force | Out-Null
  $escaped = '"' + $trayExePath + '"'
  New-ItemProperty -Path $trayRunKey -Name $trayRunValueName -Value $escaped -PropertyType String -Force | Out-Null
  Write-InstallerLog "Registered tray desktop startup via HKCU Run"
}

function Bootstrap-Companion {
  if (-not (Ensure-Node)) {
    return $false
  }

  & npm install -g "trapezohe-companion@$version"
  if ($LASTEXITCODE -ne 0) {
    Write-InstallerLog "npm install failed with exit code $LASTEXITCODE. Installation continues for manual retry."
    return $false
  }

  & trapezohe-companion bootstrap --mode workspace --workspace "$workspace"
  if ($LASTEXITCODE -ne 0) {
    Write-InstallerLog "bootstrap failed with exit code $LASTEXITCODE. Installation continues for manual retry."
    return $false
  }

  Write-InstallerLog "Bootstrap finished successfully."
  return $true
}

function Launch-TrayOnce {
  if (-not (Test-Path $trayExePath)) {
    Write-InstallerLog "Tray executable missing at $trayExePath; skipping first launch"
    return
  }

  Start-Process -FilePath $trayExePath | Out-Null
  Write-InstallerLog "Launched tray executable once"
}

Write-InstallerLog "Windows installer bootstrap started (version=$version)."
Write-StartupPolicy
Remove-LegacyDaemonAutostart
Register-TrayAutoStart
Bootstrap-Companion | Out-Null
Launch-TrayOnce
exit 0
