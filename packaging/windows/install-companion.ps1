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

function Ensure-NpmGlobalBinOnPath {
  try {
    $npmPrefix = (& npm config get prefix 2>$null).Trim()
    if ($npmPrefix -and (Test-Path $npmPrefix)) {
      if ($env:PATH -notlike "*$npmPrefix*") {
        $env:PATH = "$npmPrefix;$env:PATH"
        Write-InstallerLog "Added npm global prefix to PATH: $npmPrefix"
      }
    }
  } catch {
    Write-InstallerLog "Warning: could not resolve npm global prefix: $_"
  }

  $appDataNpm = Join-Path $env:APPDATA "npm"
  if ((Test-Path $appDataNpm) -and ($env:PATH -notlike "*$appDataNpm*")) {
    $env:PATH = "$appDataNpm;$env:PATH"
    Write-InstallerLog "Added APPDATA npm dir to PATH: $appDataNpm"
  }
}

function Bootstrap-Companion {
  if (-not (Ensure-Node)) {
    return $false
  }

  Ensure-NpmGlobalBinOnPath

  # Clean previous global install to avoid stale state on reinstall/upgrade
  $existingCli = Get-Command trapezohe-companion -ErrorAction SilentlyContinue
  if ($existingCli) {
    Write-InstallerLog "Removing previous global install before reinstall..."
    & npm uninstall -g trapezohe-companion 2>&1 | ForEach-Object { Write-InstallerLog "  npm-uninstall: $_" }
  }

  # Determine install source: bundled .tgz (preferred) or npm registry fallback
  $bundledTgz = Join-Path $PSScriptRoot "trapezohe-companion-package.tgz"
  if (Test-Path $bundledTgz) {
    # Copy tgz to a path without spaces/parens to avoid cmd.exe parsing issues
    # (e.g. "C:\Program Files (x86)\..." breaks npm's internal shell escaping)
    $safeTgz = Join-Path $env:TEMP "trapezohe-companion-package.tgz"
    Copy-Item $bundledTgz $safeTgz -Force
    $npmInstallTarget = $safeTgz
    Write-InstallerLog "Using bundled package (copied to safe path): $safeTgz"
  } else {
    $npmInstallTarget = "trapezohe-companion@$version"
    Write-InstallerLog "No bundled package found; installing from npm registry: $npmInstallTarget"
  }

  Write-InstallerLog "Running: npm install -g $npmInstallTarget"
  & npm install -g $npmInstallTarget 2>&1 | ForEach-Object { Write-InstallerLog "  npm: $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-InstallerLog "npm install failed with exit code $LASTEXITCODE. Installation continues for manual retry."
    return $false
  }
  Write-InstallerLog "npm install -g succeeded."

  # Clean up temp copy
  if ($safeTgz -and (Test-Path $safeTgz)) {
    Remove-Item $safeTgz -Force -ErrorAction SilentlyContinue
  }

  Ensure-NpmGlobalBinOnPath

  $cli = Get-Command trapezohe-companion -ErrorAction SilentlyContinue
  if (-not $cli) {
    Write-InstallerLog "ERROR: trapezohe-companion not found on PATH after npm install -g. PATH=$($env:PATH)"
    return $false
  }
  Write-InstallerLog "Resolved CLI at: $($cli.Source)"

  & trapezohe-companion bootstrap --mode workspace --workspace "$workspace" 2>&1 | ForEach-Object { Write-InstallerLog "  bootstrap: $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-InstallerLog "bootstrap failed with exit code $LASTEXITCODE. Installation continues for manual retry."
    return $false
  }

  Write-InstallerLog "Bootstrap finished successfully."
  return $true
}

function Restart-CompanionDaemon {
  $configPath = Join-Path $trapezoheDir "companion.json"
  if (-not (Test-Path $configPath)) {
    Write-InstallerLog "Companion config missing at $configPath; skipping runtime handoff"
    return
  }

  Ensure-NpmGlobalBinOnPath

  $cli = Get-Command trapezohe-companion -ErrorAction SilentlyContinue
  if (-not $cli) {
    Write-InstallerLog "Installed companion CLI is not on PATH; skipping runtime handoff. PATH=$($env:PATH)"
    return
  }

  & trapezohe-companion stop --force 2>&1 | ForEach-Object { Write-InstallerLog "  stop: $_" }
  if ($LASTEXITCODE -eq 0) {
    Write-InstallerLog "Stopped any existing companion daemon before handoff"
  } else {
    Write-InstallerLog "Installed CLI stop command exited with $LASTEXITCODE during runtime handoff"
  }

  & trapezohe-companion start -d 2>&1 | ForEach-Object { Write-InstallerLog "  start: $_" }
  if ($LASTEXITCODE -eq 0) {
    Write-InstallerLog "Started installed companion daemon after handoff"
  } else {
    Write-InstallerLog "Installed CLI start command exited with $LASTEXITCODE during runtime handoff"
  }
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
Write-InstallerLog "USERPROFILE=$($env:USERPROFILE) APPDATA=$($env:APPDATA) PATH=$($env:PATH)"
Write-StartupPolicy
Remove-LegacyDaemonAutostart
Register-TrayAutoStart

$bootstrapOk = Bootstrap-Companion
if (-not $bootstrapOk) {
  Write-InstallerLog "Bootstrap failed; aborting installer. Review $logFile for details."
  throw "Trapezohe Companion bootstrap failed. Review installer log at $logFile."
}

Write-InstallerLog "Bootstrap succeeded, proceeding with daemon handoff."
Restart-CompanionDaemon
Launch-TrayOnce
Write-InstallerLog "Windows installer bootstrap finished."
exit 0
