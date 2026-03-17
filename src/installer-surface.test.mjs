import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

test('package scripts expose installer builds and internal tray staging separately', () => {
  const pkg = JSON.parse(read('package.json'))

  assert.ok(pkg.scripts['build:installer:macos'])
  assert.ok(pkg.scripts['build:installer:windows'])
  assert.ok(pkg.scripts['stage:tray:macos'])
  assert.ok(pkg.scripts['stage:tray:windows'])
  assert.equal(pkg.scripts['build:tray:macos'], undefined)
  assert.equal(pkg.scripts['build:tray:windows'], undefined)
})

test('tray stage scripts write internal artifacts outside dist/installers public surface', () => {
  const macosScript = read('scripts/build-tray-macos.sh')
  const windowsScript = read('scripts/build-tray-windows.ps1')

  assert.match(macosScript, /dist\/stage/)
  assert.doesNotMatch(macosScript, /OUT_DIR="\$\{ROOT_DIR\}\/dist\/installers"/)
  assert.match(windowsScript, /dist[\\\/]stage/)
  assert.doesNotMatch(windowsScript, /dist[\\\/]installers/)
})

test('public docs and release copy describe tray as bundled installer UX, not optional side bundle', () => {
  const readme = read('README.md')
  const releaseWorkflow = read('.github/workflows/release-installers.yml')

  assert.doesNotMatch(readme, /build:tray:/)
  assert.doesNotMatch(readme, /tray shell bundle is optional/i)
  assert.match(readme, /desktop tray panel is installed together/i)

  assert.doesNotMatch(releaseWorkflow, /tray shell bundle is optional/i)
  assert.match(releaseWorkflow, /desktop tray panel is installed together/i)
})

test('tray shell exposes the global Tauri bridge required by the static panel UI', () => {
  const trayConfig = JSON.parse(read('tray/tauri.conf.json'))
  const trayHtml = read('tray/ui/index.html')

  assert.match(trayHtml, /window\.__TAURI__/)
  assert.equal(trayConfig.app?.withGlobalTauri, true)
})

test('macOS installer bootstrap writes its temp script to a user-accessible path and targets the installed app bundle', () => {
  const postinstall = read('packaging/macos/postinstall')

  assert.match(postinstall, /mktemp "\/Users\/Shared\/trapezohe-companion-bootstrap\.XXXXXX"/)
  assert.doesNotMatch(postinstall, /mktemp -t trapezohe-companion-bootstrap/)
  assert.doesNotMatch(postinstall, /mktemp \/tmp\/trapezohe-companion-bootstrap\.XXXXXX\.sh/)
  assert.match(postinstall, /TRAY_APP_PATH="\/Applications\/Trapezohe Companion\.app"/)
  assert.match(postinstall, /TRAY_BIN_PATH="\$\{TRAY_APP_PATH\}\/Contents\/MacOS\/trapezohe-companion-tray"/)
})

test('macOS installer registers the fixed production extension origin for native messaging', () => {
  const postinstall = read('packaging/macos/postinstall')

  assert.match(postinstall, /local ext_id="nnhdkkgpoeojjddikcjadgpkbfbjhcal"/)
  assert.match(postinstall, /local origin="chrome-extension:\/\/\$\{ext_id\}\/"/)
  assert.doesNotMatch(postinstall, /olngglipkifpkolknipcbdcifbkcfhkk/)
})

test('macOS installer hands runtime over to the installed CLI after deploying the service payload', () => {
  const postinstall = read('packaging/macos/postinstall')

  assert.match(postinstall, /restart_companion_daemon\(\)/)
  assert.match(postinstall, /local wrapper="\$\{LOCAL_NODE_DIR\}\/bin\/trapezohe-companion"/)
  assert.match(postinstall, /"\$\{wrapper\}" stop --force/)
  assert.match(postinstall, /"\$\{wrapper\}" start -d/)
  assert.match(postinstall, /deploy_companion_service \|\| true\s+restart_companion_daemon \|\| true/s)
})

test('Windows installer hands runtime over to the installed CLI after bootstrap', () => {
  const installer = read('packaging/windows/install-companion.ps1')
  const wxs = read('packaging/windows/installer.wxs')
  const runInstall = read('packaging/windows/run-install.cmd')

  assert.match(installer, /^param\(\s*\[switch\]\$StopTrayOnly,\s*\[switch\]\$Cleanup\s*\)/m)
  assert.match(installer, /\$ProgressPreference = "SilentlyContinue"/)
  assert.match(installer, /function Write-InstallerStatus/)
  assert.match(installer, /function Write-InstallerStep/)
  assert.match(installer, /function Resolve-InstallerCommand/)
  assert.match(installer, /function Build-CmdProcessArgumentList/)
  assert.match(installer, /function Resolve-LoggedProcessLaunchSpec/)
  assert.match(installer, /function Invoke-LoggedProcess/)
  assert.match(installer, /function Start-DetachedInstallerCommand/)
  assert.match(installer, /function Stop-RunningTrayProcesses/)
  assert.match(installer, /function Resolve-InstalledCompanionCliScript/)
  assert.match(installer, /Resolve-LoggedProcessLaunchSpec -FilePath \$FilePath -ArgumentList \$ArgumentList/)
  assert.match(installer, /switch \(\$extension\) \{[\s\S]+?"\.cmd" \{[\s\S]+?"\.bat" \{[\s\S]+?"\.ps1" \{/)
  assert.match(installer, /return @\("\/d", "\/s", "\/c", '"' \+ \$cmdCommand \+ '"'\)/)
  assert.match(installer, /ArgumentList = Build-CmdProcessArgumentList -FilePath \$FilePath -ArgumentList \$ArgumentList/)
  assert.match(installer, /\[System\.Diagnostics\.Process\]::Start\(\$psi\)/)
  assert.match(installer, /\$psi\.CreateNoWindow = \$true/)
  assert.match(installer, /\$psi\.RedirectStandardOutput = \$true/)
  assert.match(installer, /\$psi\.RedirectStandardError = \$true/)
  assert.match(installer, /\$proc\.StandardOutput\.ReadToEnd\(\)/)
  assert.match(installer, /Start-Process -FilePath \$cmdCli -ArgumentList @\("\/d", "\/s", "\/c", '"' \+ \$detachedCommand \+ '"'\) -WindowStyle Hidden \| Out-Null/)
  assert.match(installer, /schtasks\.exe/)
  assert.match(installer, /TrapezoheCompanionTrayOnce/)
  assert.match(installer, /MSI deferred custom actions run in Session 0/)
  assert.match(installer, /Get-Process -Name "trapezohe-companion-tray" -ErrorAction SilentlyContinue/)
  assert.match(installer, /Stop-Process -Force -ErrorAction SilentlyContinue/)
  assert.match(installer, /\$stagedPackageDir = Join-Path \(\[System\.IO\.Path\]::GetTempPath\(\)\)/)
  assert.match(installer, /\$stagedPackageTarballPath = Join-Path \$stagedPackageDir "trapezohe-companion-package\.tgz"/)
  assert.match(installer, /Copy-Item \$packageTarballPath \$stagedPackageTarballPath -Force/)
  assert.match(installer, /Write-InstallerLog "Installing bundled package over any existing global companion install to keep upgrades update-safe\."/)
  assert.match(installer, /\$npmCli = Resolve-InstallerCommand @\("npm\.cmd", "npm"\)/)
  assert.match(installer, /Invoke-LoggedProcess -FilePath \$npmCli -ArgumentList @\("install", "-g", \$npmInstallTarget\) -LogPrefix "npm"/)
  assert.match(installer, /Write-InstallerLog "Step 2 complete; resolving installed Node\.js and companion CLI handoff\."/)
  assert.match(installer, /\$nodeCli = Resolve-InstallerCommand @\("node\.exe", "node"\)/)
  assert.match(installer, /\$companionCliScript = Resolve-InstalledCompanionCliScript -NpmCli \$npmCli/)
  assert.match(installer, /Write-InstallerLog "Resolved Node CLI at: \$nodeCli"/)
  assert.match(installer, /Write-InstallerLog "Resolved installed companion CLI script at: \$companionCliScript"/)
  assert.match(installer, /Invoke-LoggedProcess -FilePath \$nodeCli -ArgumentList @\(\$companionCliScript, "bootstrap", "--mode", "workspace", "--workspace", \$workspace, "--no-autostart", "--no-start"\) -LogPrefix "bootstrap"/)
  assert.match(installer, /Start-DetachedInstallerCommand -FilePath \$trayExePath -ArgumentList @\(\)/)
  assert.match(installer, /Invoke-LoggedProcess -FilePath "schtasks\.exe" -ArgumentList @\(\s*"\/Create", "\/TN", \$taskName/)
  assert.match(installer, /if \(\$StopTrayOnly\) \{[\s\S]+?Write-InstallerLog "Windows installer tray pre-stop started\."[\s\S]+?Stop-RunningTrayProcesses[\s\S]+?Write-InstallerLog "Windows installer tray pre-stop finished\."[\s\S]+?exit 0[\s\S]+?\}/s)
  assert.doesNotMatch(installer, /& npm install -g \$packageTarballPath 2>&1 \| ForEach-Object/)
  assert.doesNotMatch(installer, /& trapezohe-companion bootstrap --mode workspace --workspace "\$workspace" 2>&1 \| ForEach-Object/)
  assert.doesNotMatch(installer, /Removing previous global install before reinstall\.\.\./)
  assert.doesNotMatch(installer, /npm-uninstall/)
  assert.match(installer, /\$packageTarballPath = Join-Path \$PSScriptRoot "trapezohe-companion-package\.tgz"/)
  assert.match(installer, /Write-InstallerStep 1 4 "Checking for Node\.js runtime\."/)
  assert.match(installer, /Write-InstallerStep 2 4 "Installing Trapezohe Companion from the bundled package\."/)
  assert.match(installer, /Write-InstallerStep 3 4 "Running first-time companion setup\."/)
  assert.match(installer, /Write-InstallerStep 4 4 "Saving tray startup preferences and launching the tray\."/)
  assert.match(installer, /Write-InstallerLog "Tray launch is responsible for syncing auto-start and ensuring the background service if needed\."/)
  assert.match(installer, /Write-InstallerStatus "Node\.js was not found\. Downloading a local runtime for this Windows user\./)
  assert.match(installer, /Write-InstallerStatus "Node\.js download completed\./)
  assert.match(installer, /Write-InstallerStatus "Windows installer completed successfully\./)
  assert.match(installer, /\$installerFlowMarker = "tray-launch-v1"/)
  assert.match(installer, /Write-InstallerLog "Windows installer bootstrap started \(version=\$version, flow=\$installerFlowMarker\)\."/)
  assert.match(installer, /\$bootstrapOk = Bootstrap-Companion/)
  assert.match(installer, /if \(-not \$bootstrapOk\) \{[\s\S]+?Write-InstallerLog "Bootstrap failed; aborting installer\./s)
  assert.match(runInstall, /install-companion\.ps1" %\*/)
  assert.match(installer, /\$bootstrapOk = Bootstrap-Companion[\s\S]+?if \(-not \$bootstrapOk\) \{[\s\S]+?throw "Trapezohe Companion bootstrap failed\.[\s\S]+?\}[\s\S]+?Write-InstallerStep 4 4 "Saving tray startup preferences and launching the tray\."[\s\S]+?Write-StartupPolicy[\s\S]+?Register-TrayAutoStart[\s\S]+?Launch-TrayOnce[\s\S]+?Write-InstallerStatus "Windows installer completed successfully\."[\s\S]+?exit 0/s)
  assert.match(installer, /function Register-TrayAutoStart/)
  assert.match(installer, /New-ItemProperty -Path \$trayRunKey -Name \$trayRunValueName/)
  assert.match(installer, /Write-InstallerLog "Bootstrap-Companion returned: \$bootstrapOk"/)
  assert.match(installer, /FATAL: unhandled exception:/)
  assert.match(installer, /FATAL: stack trace:/)
  assert.match(installer, /Warning: failed to write unified startup policy:/)
  assert.match(installer, /Warning: failed to launch tray executable:/)
  assert.match(installer, /throw "Trapezohe Companion bootstrap failed\./)
  assert.doesNotMatch(installer, /PostBootstrapFinish/)
  assert.doesNotMatch(installer, /Detached post-bootstrap finisher/)
  assert.doesNotMatch(installer, /Restart-CompanionDaemon/)
  assert.match(wxs, /Source="\$\(var\.InstallerSourceDir\)\/trapezohe-companion-package\.tgz"/)
  assert.match(wxs, /Return="check"/)
  assert.match(wxs, /Id="StopTrayBeforeInstall"/)
  assert.match(wxs, /Condition="\(Installed OR WIX_UPGRADE_DETECTED\) AND NOT REMOVE~=&quot;ALL&quot;"/)
  assert.match(wxs, /Return="ignore"/)
  assert.match(installer, /function Create-DesktopShortcut/)
  assert.match(installer, /function Create-StartMenuShortcut/)
  assert.match(installer, /New-Object -ComObject WScript\.Shell/)
  assert.match(installer, /\[Environment\]::GetFolderPath\("Desktop"\)/)
  assert.match(installer, /\[Environment\]::GetFolderPath\("Programs"\)/)
  assert.match(installer, /\.CreateShortcut\(/)
  assert.match(installer, /\.TargetPath = \$trayExePath/)
  assert.match(installer, /Create-DesktopShortcut[\s\S]+?Create-StartMenuShortcut[\s\S]+?Launch-TrayOnce/s)
  assert.match(installer, /function Remove-DesktopShortcut/)
  assert.match(installer, /function Remove-StartMenuShortcut/)
  assert.match(installer, /function Remove-TrayAutoStart/)
  assert.match(installer, /if \(\$Cleanup\) \{[\s\S]+?Stop-RunningTrayProcesses[\s\S]+?Remove-DesktopShortcut[\s\S]+?Remove-StartMenuShortcut[\s\S]+?Remove-TrayAutoStart[\s\S]+?exit 0[\s\S]+?\}/s)
  assert.match(wxs, /Id="UninstallCleanup"/)
  assert.match(wxs, /ExeCommand="-Cleanup"/)
  assert.match(wxs, /REMOVE~=&quot;ALL&quot;/)
})


test('README, CLI help, and install scripts no longer ask users for --ext-id', () => {
  const readme = read('README.md')
  const cli = read('bin/cli.mjs')
  const installer = read('install.sh')
  const windowsInstaller = read('install.ps1')

  assert.doesNotMatch(readme, /--ext-id/)
  assert.doesNotMatch(readme, /register <your-extension-id>/)
  assert.doesNotMatch(readme, /chrome:\/\/extensions/)

  assert.doesNotMatch(cli, /register <ext-id>/)
  assert.doesNotMatch(cli, /repair register_native_host --ext-id/)
  assert.doesNotMatch(cli, /bootstrap --ext-id/)

  assert.doesNotMatch(installer, /Extension ID \(or press Enter to skip\)/)
  assert.doesNotMatch(installer, /cmd\+=\(--ext-id/)

  assert.doesNotMatch(windowsInstaller, /--ext-id/)
  assert.doesNotMatch(windowsInstaller, /Extension ID \(or press Enter to skip\)/)
  assert.doesNotMatch(windowsInstaller, /chrome:\/\/extensions/)
  assert.doesNotMatch(windowsInstaller, /register <extension-id>/)
})

test('package, tray Cargo, and tauri config versions stay aligned for the next release', () => {
  const pkg = JSON.parse(read('package.json'))
  const cargoToml = read('tray/Cargo.toml')
  const tauriConfig = JSON.parse(read('tray/tauri.conf.json'))

  assert.equal(pkg.version, '0.1.9')
  assert.match(cargoToml, /^version = "0\.1\.9"$/m)
  assert.equal(tauriConfig.version, '0.1.9')
})
