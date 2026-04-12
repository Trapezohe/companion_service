param(
  [switch]$StopTrayOnly,
  [switch]$Cleanup
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "__COMPANION_VERSION__"
$installerFlowMarker = "tray-launch-v1"
$workspace = Join-Path $env:USERPROFILE "trapezohe-workspace"
$trapezoheDir = Join-Path $env:USERPROFILE ".trapezohe"
$stagedCompanionBinDir = Join-Path $trapezoheDir "bin"
$stagedCompanionCliPath = Join-Path $stagedCompanionBinDir "trapezohe-companion.exe"
$startupPolicyPath = Join-Path $trapezoheDir "companion-startup.json"
$legacyTrayPrefsPath = Join-Path $trapezoheDir "companion-tray.json"
$bundledCompanionCliPath = Join-Path $PSScriptRoot "trapezohe-companion.exe"
$trayExePath = Join-Path $PSScriptRoot "trapezohe-companion-tray.exe"
$trayForegroundArgs = @("--show-panel")
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

function Write-FileUtf8NoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Contents
  )

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Contents, $utf8NoBom)
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

function Write-StartupPolicy {
  try {
    New-Item -ItemType Directory -Force -Path $trapezoheDir | Out-Null
    # Windows PowerShell writes a UTF-8 BOM by default, which breaks the
    # Rust tray JSON parser and prevents automatic daemon startup.
    $policyJson = @{
      loginItem = 'tray'
      ensureDaemonOnTrayLaunch = $true
    } | ConvertTo-Json
    Write-FileUtf8NoBom -Path $startupPolicyPath -Contents ($policyJson + [Environment]::NewLine)
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

function Get-CompanionCliCandidates {
  $candidates = @()

  if (Test-Path $stagedCompanionCliPath) {
    $candidates += $stagedCompanionCliPath
  }

  if ((Test-Path $bundledCompanionCliPath) -and ($bundledCompanionCliPath -notin $candidates)) {
    $candidates += $bundledCompanionCliPath
  }

  $pathCli = Resolve-InstallerCommand @("trapezohe-companion.exe", "trapezohe-companion.cmd", "trapezohe-companion")
  if ($pathCli -and ($pathCli -notin $candidates)) {
    $candidates += $pathCli
  }

  return $candidates
}

function Stop-InstalledCompanionDaemon {
  try {
    $cliCandidates = @(Get-CompanionCliCandidates)
    if ($cliCandidates.Count -eq 0) {
      Write-InstallerLog "No companion CLI found; skipping daemon stop."
      return
    }

    foreach ($cliPath in $cliCandidates) {
      $exitCode = Invoke-LoggedProcess -FilePath $cliPath -ArgumentList @("stop", "--force") -LogPrefix "companion-stop"
      if ($exitCode -eq 0) {
        Write-InstallerLog "Requested companion daemon stop via CLI: $cliPath"
        return
      }
      Write-InstallerLog "Warning: companion CLI stop returned exit code $exitCode for $cliPath"
    }
  } catch {
    Write-InstallerLog "Warning: failed to stop installed companion daemon: $_"
  }
}

function Bootstrap-Companion {
  Write-InstallerStep 1 4 "Checking bundled companion runtime."

  if (-not (Test-Path $bundledCompanionCliPath)) {
    Write-InstallerStatus "The bundled companion runtime is missing. Setup cannot continue."
    Write-InstallerLog "ERROR: bundled Rust companion CLI missing at $bundledCompanionCliPath"
    return $false
  }

  Write-InstallerStatus "Bundled companion runtime is ready."
  Write-InstallerLog "Using bundled Rust companion CLI: $bundledCompanionCliPath"

  Write-InstallerStep 2 4 "Stopping any previous companion process."
  Stop-InstalledCompanionDaemon
  Write-InstallerLog "Finished pre-bootstrap daemon stop check."

  Write-InstallerStep 3 4 "Running first-time companion setup."
  $bootstrapExitCode = Invoke-LoggedProcess -FilePath $bundledCompanionCliPath -ArgumentList @("bootstrap", "--mode", "workspace", "--workspace", $workspace, "--no-autostart", "--no-start") -LogPrefix "bootstrap"
  if ($bootstrapExitCode -ne 0) {
    Write-InstallerStatus "First-time companion setup failed. Review the installer log for details."
    Write-InstallerLog "bootstrap failed with exit code $bootstrapExitCode. Installation continues for manual retry."
    return $false
  }

  if (Test-Path $stagedCompanionCliPath) {
    Write-InstallerLog "Bootstrap staged companion CLI to $stagedCompanionCliPath"
  } else {
    Write-InstallerLog "Bootstrap completed, but staged companion CLI was not found at $stagedCompanionCliPath"
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
    $legacyShortcutPath = Join-Path $desktopPath "Trapezohe Companion.lnk"
    if (Test-Path $legacyShortcutPath) {
      Remove-Item -Path $legacyShortcutPath -Force -ErrorAction SilentlyContinue
      Write-InstallerLog "Removed legacy desktop shortcut at $legacyShortcutPath"
    }
    $shortcutPath = Join-Path $desktopPath "GhastAI Companion.lnk"
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $trayExePath
    $shortcut.Arguments = ($trayForegroundArgs -join " ")
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
    $legacyFolderPath = Join-Path $startMenuPath "Trapezohe"
    if (Test-Path $legacyFolderPath) {
      Remove-Item -Path $legacyFolderPath -Recurse -Force -ErrorAction SilentlyContinue
      Write-InstallerLog "Removed legacy start menu folder at $legacyFolderPath"
    }

    $folderPath = Join-Path $startMenuPath "GhastAI"
    New-Item -ItemType Directory -Force -Path $folderPath | Out-Null
    $shortcutPath = Join-Path $folderPath "GhastAI Companion.lnk"
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $trayExePath
    $shortcut.Arguments = ($trayForegroundArgs -join " ")
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
    $trayLaunchCommand = ((@($trayExePath) + $trayForegroundArgs) | ForEach-Object { ConvertTo-CmdArgument $_ }) -join " "

    $createExitCode = Invoke-LoggedProcess -FilePath "schtasks.exe" -ArgumentList @(
      "/Create", "/TN", $taskName, "/SC", "ONCE", "/ST", "00:00",
      "/TR", $trayLaunchCommand, "/RL", "LIMITED", "/F"
    ) -LogPrefix "schtasks-create"

    if ($createExitCode -ne 0) {
      Write-InstallerLog "Warning: failed to create scheduled task for tray launch (exit=$createExitCode); falling back to detached launch"
      Start-DetachedInstallerCommand -FilePath $trayExePath -ArgumentList $trayForegroundArgs
      return
    }

    $runExitCode = Invoke-LoggedProcess -FilePath "schtasks.exe" -ArgumentList @(
      "/Run", "/TN", $taskName
    ) -LogPrefix "schtasks-run"

    if ($runExitCode -ne 0) {
      Write-InstallerLog "Warning: scheduled task run failed (exit=$runExitCode); falling back to detached launch"
      Start-DetachedInstallerCommand -FilePath $trayExePath -ArgumentList $trayForegroundArgs
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
    $shortcutPaths = @(
      (Join-Path $desktopPath "GhastAI Companion.lnk"),
      (Join-Path $desktopPath "Trapezohe Companion.lnk")
    )
    foreach ($shortcutPath in $shortcutPaths) {
      if (Test-Path $shortcutPath) {
        Remove-Item -Path $shortcutPath -Force
        Write-InstallerLog "Removed desktop shortcut at $shortcutPath"
      }
    }
  } catch {
    Write-InstallerLog "Warning: failed to remove desktop shortcut: $_"
  }
}

function Remove-StartMenuShortcut {
  try {
    $startMenuPath = [Environment]::GetFolderPath("Programs")
    $folderPaths = @(
      (Join-Path $startMenuPath "GhastAI"),
      (Join-Path $startMenuPath "Trapezohe")
    )
    foreach ($folderPath in $folderPaths) {
      if (Test-Path $folderPath) {
        Remove-Item -Path $folderPath -Recurse -Force
        Write-InstallerLog "Removed start menu folder at $folderPath"
      }
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
    throw "GhastAI Companion bootstrap failed. Review installer log at $logFile."
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
