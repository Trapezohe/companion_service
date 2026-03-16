$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "__COMPANION_VERSION__"
$nodeVersion = "v22.12.0"
$minNodeMajor = 18
$workspace = Join-Path $env:USERPROFILE "trapezohe-workspace"
$trapezoheDir = Join-Path $env:USERPROFILE ".trapezohe"
$localNodeDir = Join-Path $trapezoheDir "node"
$startupPolicyPath = Join-Path $trapezoheDir "companion-startup.json"
$legacyTrayPrefsPath = Join-Path $trapezoheDir "companion-tray.json"
$packageTarballPath = Join-Path $PSScriptRoot "trapezohe-companion-package.tgz"
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

function Write-InstallerStatus([string]$message) {
  Write-Host $message
  Write-InstallerLog $message
}

function Write-InstallerStep([int]$step, [int]$total, [string]$message) {
  Write-InstallerStatus ("Step {0}/{1}: {2}" -f $step, $total, $message)
}

function Invoke-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [string]$LogPrefix
  )

  $stdoutPath = Join-Path $env:TEMP ("trapezohe-companion-" + [guid]::NewGuid().ToString("N") + ".stdout.log")
  $stderrPath = Join-Path $env:TEMP ("trapezohe-companion-" + [guid]::NewGuid().ToString("N") + ".stderr.log")

  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    if (Test-Path $stdoutPath) {
      Get-Content $stdoutPath -ErrorAction SilentlyContinue | ForEach-Object { Write-InstallerLog "  ${LogPrefix}: $_" }
    }
    if (Test-Path $stderrPath) {
      Get-Content $stderrPath -ErrorAction SilentlyContinue | ForEach-Object { Write-InstallerLog "  ${LogPrefix}: $_" }
    }

    return $process.ExitCode
  } catch {
    Write-InstallerLog "  ${LogPrefix}: failed to launch process: $_"
    return -1
  } finally {
    Remove-Item -Path $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $stderrPath -Force -ErrorAction SilentlyContinue
  }
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
  Write-InstallerStep 1 6 "Checking for Node.js runtime."

  if (Test-UsableNode) {
    $ver = & node -v
    Write-InstallerStatus "Using the Node.js version already installed on this PC: $ver"
    Write-InstallerLog "Using system Node.js: $ver"
    return $true
  }

  $localNode = Join-Path $localNodeDir "node.exe"
  if (Test-Path $localNode) {
    $env:PATH = "$localNodeDir;$env:PATH"
    if (Test-UsableNode) {
      $ver = & node -v
      Write-InstallerStatus "Using the local Node.js runtime already prepared for this Windows user: $ver"
      Write-InstallerLog "Using local Node.js: $ver"
      return $true
    }
  }

  $arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  } else { "x86" }

  $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$arch.zip"
  $zipPath = Join-Path $env:TEMP "node-$nodeVersion-win-$arch.zip"

  Write-InstallerStatus "Node.js was not found. Downloading a local runtime for this Windows user."
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
    Write-InstallerStatus "Node.js download completed."
    Write-InstallerStatus "Local Node.js is ready to use: $ver"
    Write-InstallerLog "Installed local Node.js: $ver -> $localNodeDir"
    return $true
  } catch {
    Write-InstallerStatus "Node.js download failed. Please install Node.js $minNodeMajor or newer, then run this installer again."
    Write-InstallerLog "Failed to download Node.js: $_"
    Write-InstallerLog "Please install Node.js $minNodeMajor+ manually from https://nodejs.org"
    return $false
  }
}

function Write-StartupPolicy {
  try {
    New-Item -ItemType Directory -Force -Path $trapezoheDir | Out-Null
    @{
      loginItem = 'tray'
      ensureDaemonOnTrayLaunch = $true
    } | ConvertTo-Json | Set-Content -Path $startupPolicyPath -Encoding UTF8
    Remove-Item -Path $legacyTrayPrefsPath -Force -ErrorAction SilentlyContinue
    Write-InstallerLog "Wrote unified startup policy to $startupPolicyPath"
  } catch {
    Write-InstallerLog "Warning: failed to write unified startup policy: $_"
  }
}

function Remove-LegacyDaemonAutostart {
  try {
    & schtasks /Delete /TN $legacyDaemonTaskName /F | Out-Null
    Write-InstallerLog "Removed legacy daemon scheduled task if present"
  } catch {
    Write-InstallerLog "Warning: failed to remove legacy daemon scheduled task: $_"
  }
}

function Register-TrayAutoStart {
  try {
    if (-not (Test-Path $trayExePath)) {
      Write-InstallerLog "Tray executable missing at $trayExePath; skipping tray auto-start registration"
      return
    }

    New-Item -Path $trayRunKey -Force | Out-Null
    $escaped = '"' + $trayExePath + '"'
    New-ItemProperty -Path $trayRunKey -Name $trayRunValueName -Value $escaped -PropertyType String -Force | Out-Null
    Write-InstallerLog "Registered tray desktop startup via HKCU Run"
  } catch {
    Write-InstallerLog "Warning: failed to register tray desktop startup: $_"
  }
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

  if (-not (Test-Path $packageTarballPath)) {
    Write-InstallerStatus "The bundled Trapezohe Companion package is missing, so setup cannot continue."
    Write-InstallerLog "Bundled companion package missing at $packageTarballPath"
    return $false
  }

  $stagedPackageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("trapezohe-companion-install-" + [guid]::NewGuid().ToString("N"))
  $stagedPackageTarballPath = Join-Path $stagedPackageDir "trapezohe-companion-package.tgz"
  try {
    New-Item -ItemType Directory -Force -Path $stagedPackageDir | Out-Null
    Copy-Item $packageTarballPath $stagedPackageTarballPath -Force
    Write-InstallerLog "Staged bundled package to $stagedPackageTarballPath"
  } catch {
    Write-InstallerStatus "The bundled package could not be staged to a temporary Windows path. Setup cannot continue."
    Write-InstallerLog "Failed to stage bundled package to temp path: $_"
    return $false
  }

  Ensure-NpmGlobalBinOnPath

  $npmCli = (Get-Command npm -ErrorAction SilentlyContinue).Source
  if (-not $npmCli) {
    Write-InstallerStatus "npm is not available after preparing Node.js. Setup cannot continue."
    Write-InstallerLog "ERROR: npm not found on PATH after preparing Node.js. PATH=$($env:PATH)"
    return $false
  }

  Write-InstallerStep 2 6 "Installing Trapezohe Companion from the bundled package."
  Write-InstallerLog "Running: npm install -g $stagedPackageTarballPath"
  try {
    $npmExitCode = Invoke-LoggedProcess -FilePath $npmCli -ArgumentList @("install", "-g", $stagedPackageTarballPath) -LogPrefix "npm"
    if ($npmExitCode -ne 0) {
      Write-InstallerStatus "The bundled package installation failed. Review the installer log for details."
      Write-InstallerLog "npm install failed with exit code $npmExitCode. Installation continues for manual retry."
      return $false
    }
  } finally {
    Remove-Item -Path $stagedPackageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-InstallerStatus "Bundled package installation completed."
  Write-InstallerLog "npm install -g from bundled package succeeded."

  Ensure-NpmGlobalBinOnPath

  $cli = Get-Command trapezohe-companion -ErrorAction SilentlyContinue
  if (-not $cli) {
    Write-InstallerStatus "The Trapezohe Companion command was not found after installation. Setup cannot continue."
    Write-InstallerLog "ERROR: trapezohe-companion not found on PATH after npm install -g. PATH=$($env:PATH)"
    return $false
  }
  Write-InstallerLog "Resolved CLI at: $($cli.Source)"

  $companionCli = $cli.Source
  Write-InstallerStep 3 6 "Running first-time companion setup."
  $bootstrapExitCode = Invoke-LoggedProcess -FilePath $companionCli -ArgumentList @("bootstrap", "--mode", "workspace", "--workspace", $workspace) -LogPrefix "bootstrap"
  if ($bootstrapExitCode -ne 0) {
    Write-InstallerStatus "First-time companion setup failed. Review the installer log for details."
    Write-InstallerLog "bootstrap failed with exit code $bootstrapExitCode. Installation continues for manual retry."
    return $false
  }

  Write-InstallerStatus "First-time companion setup completed."
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

  $stopExitCode = Invoke-LoggedProcess -FilePath $cli.Source -ArgumentList @("stop", "--force") -LogPrefix "stop"
  if ($stopExitCode -eq 0) {
    Write-InstallerLog "Stopped any existing companion daemon before handoff"
  } else {
    Write-InstallerLog "Installed CLI stop command exited with $stopExitCode during runtime handoff"
  }

  $startExitCode = Invoke-LoggedProcess -FilePath $cli.Source -ArgumentList @("start", "-d") -LogPrefix "start"
  if ($startExitCode -eq 0) {
    Write-InstallerLog "Started installed companion daemon after handoff"
  } else {
    Write-InstallerLog "Installed CLI start command exited with $startExitCode during runtime handoff"
  }
}

function Launch-TrayOnce {
  try {
    if (-not (Test-Path $trayExePath)) {
      Write-InstallerLog "Tray executable missing at $trayExePath; skipping first launch"
      return
    }

    Start-Process -FilePath $trayExePath | Out-Null
    Write-InstallerLog "Launched tray executable once"
  } catch {
    Write-InstallerLog "Warning: failed to launch tray executable: $_"
  }
}

Write-InstallerLog "Windows installer bootstrap started (version=$version)."
Write-InstallerLog "USERPROFILE=$($env:USERPROFILE) APPDATA=$($env:APPDATA) PATH=$($env:PATH)"

$bootstrapOk = Bootstrap-Companion
if (-not $bootstrapOk) {
  Write-InstallerStatus "Windows installer stopped because bootstrap did not complete. Review the installer log and try again."
  Write-InstallerLog "Bootstrap failed; aborting installer. Review $logFile for details."
  throw "Trapezohe Companion bootstrap failed. Review installer log at $logFile."
}

Write-InstallerStatus "Bootstrap succeeded. Finishing Windows-specific startup setup."
Write-InstallerStep 4 6 "Saving startup preferences and login behavior."
Write-StartupPolicy
Remove-LegacyDaemonAutostart
Register-TrayAutoStart
Write-InstallerStep 5 6 "Starting the installed companion background service."
Write-InstallerLog "Bootstrap succeeded, proceeding with daemon handoff."
Restart-CompanionDaemon
Write-InstallerStep 6 6 "Launching the desktop tray panel."
Launch-TrayOnce
Write-InstallerStatus "Windows installer completed successfully."
Write-InstallerLog "Windows installer bootstrap finished."
exit 0
