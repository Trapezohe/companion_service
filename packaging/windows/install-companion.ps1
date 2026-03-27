param(
  [switch]$StopTrayOnly,
  [switch]$Cleanup
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "__COMPANION_VERSION__"
$installerFlowMarker = "tray-launch-v1"
$nodeVersion = "v22.12.0"
$minNodeMajor = 18
$workspace = Join-Path $env:USERPROFILE "trapezohe-workspace"
$trapezoheDir = Join-Path $env:USERPROFILE ".trapezohe"
$localNodeDir = Join-Path $trapezoheDir "node"
$startupPolicyPath = Join-Path $trapezoheDir "companion-startup.json"
$legacyTrayPrefsPath = Join-Path $trapezoheDir "companion-tray.json"
$packageTarballPath = Join-Path $PSScriptRoot "trapezohe-companion-package.tgz"
$trayExePath = Join-Path $PSScriptRoot "trapezohe-companion-tray.exe"
$logDir = Join-Path $env:ProgramData "TrapezoheCompanion"
$logFile = Join-Path $logDir "installer.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-InstallerLog([string]$message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$timestamp] $message`r`n"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
  for ($retry = 0; $retry -lt 3; $retry++) {
    try {
      $fs = [System.IO.FileStream]::new(
        $logFile,
        [System.IO.FileMode]::Append,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite
      )
      $fs.Write($bytes, 0, $bytes.Length)
      $fs.Close()
      return
    } catch {
      if ($retry -lt 2) { Start-Sleep -Milliseconds 100 }
    }
  }
}

function Write-InstallerStatus([string]$message) {
  Write-Host $message
  Write-InstallerLog $message
}

function Write-InstallerStep([int]$step, [int]$total, [string]$message) {
  Write-InstallerStatus ("Step {0}/{1}: {2}" -f $step, $total, $message)
}

function Resolve-InstallerCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
      continue
    }

    if ($command.Source) {
      return $command.Source
    }
    if ($command.Path) {
      return $command.Path
    }
    if ($command.Definition) {
      return $command.Definition
    }
  }

  return $null
}

function ConvertTo-CmdArgument {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  return '"' + ($Value -replace '"', '""') + '"'
}

function Build-CmdProcessArgumentList {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList
  )

  $cmdCommand = ((@($FilePath) + $ArgumentList) | ForEach-Object { ConvertTo-CmdArgument $_ }) -join " "
  return @("/d", "/s", "/c", '"' + $cmdCommand + '"')
}

function Resolve-LoggedProcessLaunchSpec {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList
  )

  $extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
  switch ($extension) {
    ".cmd" {
      return @{
        FilePath = if ($env:ComSpec) { $env:ComSpec } else { "cmd.exe" }
        ArgumentList = Build-CmdProcessArgumentList -FilePath $FilePath -ArgumentList $ArgumentList
      }
    }
    ".bat" {
      return @{
        FilePath = if ($env:ComSpec) { $env:ComSpec } else { "cmd.exe" }
        ArgumentList = Build-CmdProcessArgumentList -FilePath $FilePath -ArgumentList $ArgumentList
      }
    }
    ".ps1" {
      $powershellCli = Resolve-InstallerCommand @("powershell.exe", "powershell", "pwsh.exe", "pwsh")
      if (-not $powershellCli) {
        $powershellCli = "powershell.exe"
      }

      return @{
        FilePath = $powershellCli
        ArgumentList = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FilePath) + $ArgumentList
      }
    }
    default {
      return @{
        FilePath = $FilePath
        ArgumentList = $ArgumentList
      }
    }
  }
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

  try {
    $launchSpec = Resolve-LoggedProcessLaunchSpec -FilePath $FilePath -ArgumentList $ArgumentList
    $argsString = $launchSpec.ArgumentList -join ' '
    Write-InstallerLog "  ${LogPrefix}: launching $($launchSpec.FilePath) $argsString"

    # Use System.Diagnostics.Process directly with CreateNoWindow instead of
    # Start-Process -NoNewWindow. The latter requires a parent console which
    # does not exist inside a WiX MSI deferred custom action context.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $launchSpec.FilePath
    $psi.Arguments = $argsString
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = [System.Diagnostics.Process]::Start($psi)

    # Read stdout first (usually the larger stream), then WaitForExit,
    # then read stderr. This avoids the pipe-buffer deadlock.
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    $stderr = $proc.StandardError.ReadToEnd()

    if ($stdout) {
      $stdout -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-InstallerLog "  ${LogPrefix}: $_" }
    }
    if ($stderr) {
      $stderr -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-InstallerLog "  ${LogPrefix}: $_" }
    }

    $exitCode = $proc.ExitCode
    Write-InstallerLog "  ${LogPrefix}: exited with code $exitCode"
    return $exitCode
  } catch {
    Write-InstallerLog "  ${LogPrefix}: failed to launch process: $_"
    Write-InstallerLog "  ${LogPrefix}: stack: $($_.ScriptStackTrace)"
    return -1
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
  Write-InstallerStep 1 4 "Checking for Node.js runtime."

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

function Stop-RunningTrayProcesses {
  try {
    $trayProcesses = @(Get-Process -Name "trapezohe-companion-tray" -ErrorAction SilentlyContinue)
    if ($trayProcesses.Count -eq 0) {
      Write-InstallerLog "No running tray process found before install."
      return
    }

    foreach ($trayProcess in $trayProcesses) {
      try {
        Stop-Process -Force -ErrorAction SilentlyContinue -Id $trayProcess.Id
        Write-InstallerLog "Stopped running tray process (pid=$($trayProcess.Id))."
      } catch {
        Write-InstallerLog "Warning: failed to stop running tray process (pid=$($trayProcess.Id)): $($_.Exception.Message)"
      }
    }

    Start-Sleep -Milliseconds 500
  } catch {
    Write-InstallerLog "Warning: failed to enumerate running tray processes: $($_.Exception.Message)"
  }
}

function Start-DetachedInstallerCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList
  )

  $cmdCli = if ($env:ComSpec) { $env:ComSpec } else { "cmd.exe" }
  $detachedCommand = 'start "" ' + ((@($FilePath) + $ArgumentList) | ForEach-Object { ConvertTo-CmdArgument $_ }) -join " "
  Start-Process -FilePath $cmdCli -ArgumentList @("/d", "/s", "/c", '"' + $detachedCommand + '"') -WindowStyle Hidden | Out-Null
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

function Ensure-LocalNodeOnPath {
  if ((Test-Path $localNodeDir) -and ($env:PATH -notlike "*$localNodeDir*")) {
    $env:PATH = "$localNodeDir;$env:PATH"
    Write-InstallerLog "Added local Node dir to PATH: $localNodeDir"
  }
}

function Resolve-InstalledCompanionCliScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NpmCli
  )

  try {
    $prefixOutput = & $NpmCli prefix -g 2>$null
    if (-not $prefixOutput) {
      return $null
    }

    $npmPrefix = [string]::Join("", $prefixOutput).Trim()
    if ([string]::IsNullOrWhiteSpace($npmPrefix)) {
      return $null
    }

    $candidate = Join-Path $npmPrefix "node_modules\\trapezohe-companion\\bin\\cli.mjs"
    if (Test-Path $candidate) {
      return $candidate
    }
  } catch {
    Write-InstallerLog "Warning: failed to resolve installed companion CLI script: $($_.Exception.Message)"
  }

  return $null
}

function Stop-InstalledCompanionDaemon {
  try {
    Ensure-LocalNodeOnPath
    Ensure-NpmGlobalBinOnPath

    $nodeCli = Resolve-InstallerCommand @("node.exe", "node")
    $npmCli = Resolve-InstallerCommand @("npm.cmd", "npm")
    $companionCliScript = if ($npmCli) {
      Resolve-InstalledCompanionCliScript -NpmCli $npmCli
    } else {
      $null
    }

    if ($nodeCli -and $companionCliScript) {
      $exitCode = Invoke-LoggedProcess -FilePath $nodeCli -ArgumentList @($companionCliScript, "stop", "--force") -LogPrefix "companion-stop"
      if ($exitCode -eq 0) {
        Write-InstallerLog "Requested companion daemon stop via installed CLI script."
        return
      }
      Write-InstallerLog "Warning: installed companion CLI script stop returned exit code $exitCode"
    }

    $companionCli = Resolve-InstallerCommand @("trapezohe-companion.cmd", "trapezohe-companion")
    if ($companionCli) {
      $exitCode = Invoke-LoggedProcess -FilePath $companionCli -ArgumentList @("stop", "--force") -LogPrefix "companion-stop"
      if ($exitCode -eq 0) {
        Write-InstallerLog "Requested companion daemon stop via installed command shim."
        return
      }
      Write-InstallerLog "Warning: installed companion command shim stop returned exit code $exitCode"
    } else {
      Write-InstallerLog "No installed companion CLI found; skipping daemon stop."
    }
  } catch {
    Write-InstallerLog "Warning: failed to stop installed companion daemon: $_"
  }
}

function Bootstrap-Companion {
  if (-not (Ensure-Node)) {
    return $false
  }

  Ensure-NpmGlobalBinOnPath
  Write-InstallerLog "Installing bundled package over any existing global companion install to keep upgrades update-safe."
  Ensure-NpmGlobalBinOnPath

  $npmCli = Resolve-InstallerCommand @("npm.cmd", "npm")
  if (-not $npmCli) {
    Write-InstallerStatus "npm is not available after preparing Node.js. Setup cannot continue."
    Write-InstallerLog "ERROR: npm not found on PATH after preparing Node.js. PATH=$($env:PATH)"
    return $false
  }

  $stagedPackageDir = $null
  $npmInstallTarget = "trapezohe-companion@$version"
  if (Test-Path $packageTarballPath) {
    $stagedPackageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("trapezohe-companion-install-" + [guid]::NewGuid().ToString("N"))
    $stagedPackageTarballPath = Join-Path $stagedPackageDir "trapezohe-companion-package.tgz"
    try {
      New-Item -ItemType Directory -Force -Path $stagedPackageDir | Out-Null
      Copy-Item $packageTarballPath $stagedPackageTarballPath -Force
      $npmInstallTarget = $stagedPackageTarballPath
      Write-InstallerLog "Staged bundled package to $stagedPackageTarballPath"
    } catch {
      Write-InstallerStatus "The bundled package could not be staged to a temporary Windows path. Setup cannot continue."
      Write-InstallerLog "Failed to stage bundled package to temp path: $_"
      return $false
    }
  } else {
    Write-InstallerLog "Bundled companion package missing at $packageTarballPath; falling back to npm registry target $npmInstallTarget"
  }

  Write-InstallerStep 2 4 "Installing Trapezohe Companion from the bundled package."
  Write-InstallerLog "Running: npm install -g $npmInstallTarget"
  try {
    $npmExitCode = Invoke-LoggedProcess -FilePath $npmCli -ArgumentList @("install", "-g", $npmInstallTarget) -LogPrefix "npm"
    if ($npmExitCode -ne 0) {
      Write-InstallerStatus "The bundled package installation failed. Review the installer log for details."
      Write-InstallerLog "npm install failed with exit code $npmExitCode. Installation continues for manual retry."
      return $false
    }
  } finally {
    if ($stagedPackageDir) {
      Remove-Item -Path $stagedPackageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-InstallerStatus "Bundled package installation completed."
  Write-InstallerLog "npm install -g from bundled package succeeded."

  Write-InstallerLog "Step 2 complete; resolving installed Node.js and companion CLI handoff."
  Ensure-NpmGlobalBinOnPath

  $nodeCli = Resolve-InstallerCommand @("node.exe", "node")
  $companionCliScript = Resolve-InstalledCompanionCliScript -NpmCli $npmCli
  if (-not $nodeCli -or -not $companionCliScript) {
    Write-InstallerStatus "The Trapezohe Companion command was not found after installation. Setup cannot continue."
    Write-InstallerLog "ERROR: installed companion CLI script could not be resolved after npm install -g. node=$nodeCli script=$companionCliScript PATH=$($env:PATH)"
    return $false
  }
  Write-InstallerLog "Resolved Node CLI at: $nodeCli"
  Write-InstallerLog "Resolved installed companion CLI script at: $companionCliScript"

  Write-InstallerStep 3 4 "Running first-time companion setup."
  $bootstrapExitCode = Invoke-LoggedProcess -FilePath $nodeCli -ArgumentList @($companionCliScript, "bootstrap", "--mode", "workspace", "--workspace", $workspace, "--no-autostart", "--no-start") -LogPrefix "bootstrap"
  if ($bootstrapExitCode -ne 0) {
    Write-InstallerStatus "First-time companion setup failed. Review the installer log for details."
    Write-InstallerLog "bootstrap failed with exit code $bootstrapExitCode. Installation continues for manual retry."
    return $false
  }

  Write-InstallerStatus "First-time companion setup completed."
  Write-InstallerLog "Bootstrap finished successfully."
  return $true
}

function Register-TrayAutoStart {
  try {
    if (-not (Test-Path $trayExePath)) {
      Write-InstallerLog "Tray executable missing at $trayExePath; skipping auto-start registration"
      return
    }

    $trayRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $trayRunValueName = "TrapezoheCompanionTray"
    New-Item -Path $trayRunKey -Force | Out-Null
    $escaped = '"' + $trayExePath + '"'
    New-ItemProperty -Path $trayRunKey -Name $trayRunValueName -Value $escaped -PropertyType String -Force | Out-Null
    Write-InstallerLog "Registered tray auto-start via HKCU Run: $escaped"
  } catch {
    Write-InstallerLog "Warning: failed to register tray auto-start: $_"
  }
}

function Create-DesktopShortcut {
  try {
    if (-not (Test-Path $trayExePath)) {
      Write-InstallerLog "Tray executable missing at $trayExePath; skipping desktop shortcut"
      return
    }

    $WshShell = New-Object -ComObject WScript.Shell
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "Trapezohe Companion.lnk"
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $trayExePath
    $shortcut.WorkingDirectory = Split-Path $trayExePath
    $shortcut.IconLocation = "$trayExePath,0"
    $shortcut.Save()
    Write-InstallerLog "Created desktop shortcut at $shortcutPath"
  } catch {
    Write-InstallerLog "Warning: failed to create desktop shortcut: $_"
  }
}

function Create-StartMenuShortcut {
  try {
    if (-not (Test-Path $trayExePath)) {
      Write-InstallerLog "Tray executable missing at $trayExePath; skipping start menu shortcut"
      return
    }

    $WshShell = New-Object -ComObject WScript.Shell
    $startMenuPath = [Environment]::GetFolderPath("Programs")
    $folderPath = Join-Path $startMenuPath "Trapezohe"
    New-Item -ItemType Directory -Force -Path $folderPath | Out-Null
    $shortcutPath = Join-Path $folderPath "Trapezohe Companion.lnk"
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $trayExePath
    $shortcut.WorkingDirectory = Split-Path $trayExePath
    $shortcut.IconLocation = "$trayExePath,0"
    $shortcut.Save()
    Write-InstallerLog "Created start menu shortcut at $shortcutPath"
  } catch {
    Write-InstallerLog "Warning: failed to create start menu shortcut: $_"
  }
}

function Launch-TrayOnce {
  try {
    if (-not (Test-Path $trayExePath)) {
      Write-InstallerLog "Tray executable missing at $trayExePath; skipping first launch"
      return
    }

    # MSI deferred custom actions run in Session 0 (non-interactive).
    # Processes launched directly from here cannot show system tray icons.
    # Use schtasks to launch the tray in the user's interactive desktop session.
    $taskName = "TrapezoheCompanionTrayOnce"
    $escapedExe = '"' + $trayExePath + '"'

    $createExitCode = Invoke-LoggedProcess -FilePath "schtasks.exe" -ArgumentList @(
      "/Create", "/TN", $taskName, "/SC", "ONCE", "/ST", "00:00",
      "/TR", $escapedExe, "/RL", "LIMITED", "/F"
    ) -LogPrefix "schtasks-create"

    if ($createExitCode -ne 0) {
      Write-InstallerLog "Warning: failed to create scheduled task for tray launch (exit=$createExitCode); falling back to detached launch"
      Start-DetachedInstallerCommand -FilePath $trayExePath -ArgumentList @()
      return
    }

    $runExitCode = Invoke-LoggedProcess -FilePath "schtasks.exe" -ArgumentList @(
      "/Run", "/TN", $taskName
    ) -LogPrefix "schtasks-run"

    if ($runExitCode -ne 0) {
      Write-InstallerLog "Warning: scheduled task run failed (exit=$runExitCode); falling back to detached launch"
      Start-DetachedInstallerCommand -FilePath $trayExePath -ArgumentList @()
    }

    # Give the task a moment to launch, then clean up the one-shot task
    Start-Sleep -Milliseconds 2000
    Invoke-LoggedProcess -FilePath "schtasks.exe" -ArgumentList @(
      "/Delete", "/TN", $taskName, "/F"
    ) -LogPrefix "schtasks-delete"

    Write-InstallerLog "Launched tray executable via scheduled task in interactive session"
  } catch {
    Write-InstallerLog "Warning: failed to launch tray executable: $_"
  }
}

function Remove-DesktopShortcut {
  try {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "Trapezohe Companion.lnk"
    if (Test-Path $shortcutPath) {
      Remove-Item -Path $shortcutPath -Force
      Write-InstallerLog "Removed desktop shortcut at $shortcutPath"
    }
  } catch {
    Write-InstallerLog "Warning: failed to remove desktop shortcut: $_"
  }
}

function Remove-StartMenuShortcut {
  try {
    $startMenuPath = [Environment]::GetFolderPath("Programs")
    $folderPath = Join-Path $startMenuPath "Trapezohe"
    if (Test-Path $folderPath) {
      Remove-Item -Path $folderPath -Recurse -Force
      Write-InstallerLog "Removed start menu folder at $folderPath"
    }
  } catch {
    Write-InstallerLog "Warning: failed to remove start menu shortcut: $_"
  }
}

function Remove-TrayAutoStart {
  try {
    $trayRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $trayRunValueName = "TrapezoheCompanionTray"
    Remove-ItemProperty -Path $trayRunKey -Name $trayRunValueName -Force -ErrorAction SilentlyContinue
    Write-InstallerLog "Removed tray auto-start registry entry"
  } catch {
    Write-InstallerLog "Warning: failed to remove tray auto-start: $_"
  }
}

if ($StopTrayOnly) {
  Write-InstallerLog "Windows installer tray pre-stop started."
  Stop-RunningTrayProcesses
  Stop-InstalledCompanionDaemon
  Write-InstallerLog "Windows installer tray pre-stop finished."
  exit 0
}

if ($Cleanup) {
  Write-InstallerLog "Windows installer uninstall cleanup started."
  Stop-RunningTrayProcesses
  Stop-InstalledCompanionDaemon
  Remove-DesktopShortcut
  Remove-StartMenuShortcut
  Remove-TrayAutoStart
  Write-InstallerLog "Windows installer uninstall cleanup finished."
  exit 0
}

try {
  Write-InstallerLog "Windows installer bootstrap started (version=$version, flow=$installerFlowMarker)."
  Write-InstallerLog "USERPROFILE=$($env:USERPROFILE) APPDATA=$($env:APPDATA) PATH=$($env:PATH)"

  $bootstrapOk = Bootstrap-Companion
  Write-InstallerLog "Bootstrap-Companion returned: $bootstrapOk"
  if (-not $bootstrapOk) {
    Write-InstallerStatus "Windows installer stopped because bootstrap did not complete. Review the installer log and try again."
    Write-InstallerLog "Bootstrap failed; aborting installer. Review $logFile for details."
    throw "Trapezohe Companion bootstrap failed. Review installer log at $logFile."
  }

  Write-InstallerStep 4 4 "Saving tray startup preferences and launching the tray."
  Write-StartupPolicy
  Register-TrayAutoStart
  Create-DesktopShortcut
  Create-StartMenuShortcut
  Write-InstallerLog "Tray launch is responsible for syncing auto-start and ensuring the background service if needed."
  Launch-TrayOnce
  Write-InstallerStatus "Windows installer completed successfully."
  Write-InstallerLog "Windows installer bootstrap finished."
  exit 0
} catch {
  Write-InstallerLog "FATAL: unhandled exception: $_"
  Write-InstallerLog "FATAL: stack trace: $($_.ScriptStackTrace)"
  throw
}
