import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

test('status panel window is configured like a tray dropdown instead of a normal app window', () => {
  const trayConfig = JSON.parse(read('tray/tauri.conf.json'))
  const statusWindow = trayConfig.app?.windows?.find((window) => window.label === 'status')

  assert.equal(statusWindow?.decorations, false)
  assert.equal(statusWindow?.alwaysOnTop, true)
  assert.equal(statusWindow?.skipTaskbar, true)
})

test('tray clicks are unified around the custom panel instead of a native right-click menu', () => {
  const trayRs = read('tray/src/tray.rs')
  const libRs = read('tray/src/lib.rs')

  assert.doesNotMatch(trayRs, /\.menu\(&menu\)/)
  assert.doesNotMatch(trayRs, /MenuBuilder::new/)
  assert.match(libRs, /MouseButton::Right/)
  assert.match(libRs, /should_open_status_panel_for_tray_event/)
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

test('macOS installer keeps the runtime inside the installed app bundle instead of deploying a second macOS service copy', () => {
  const postinstall = read('packaging/macos/postinstall')
  const trayScript = read('scripts/build-tray-macos.sh')
  const pkgScript = read('scripts/build-macos-pkg.sh')

  assert.match(trayScript, /COMPANION_DIR="\$\{RESOURCES_DIR\}\/companion"/)
  assert.match(trayScript, /RUNTIME_NODE_DIR="\$\{RESOURCES_DIR\}\/runtime\/node"/)
  assert.match(trayScript, /cp "\$\{ROOT_DIR\}\/bin\/cli\.mjs" "\$\{COMPANION_DIR\}\/bin\/cli\.mjs"/)
  assert.match(trayScript, /cp "\$\{ROOT_DIR\}\/bin\/native-host\.mjs" "\$\{COMPANION_DIR\}\/bin\/native-host\.mjs"/)
  assert.match(trayScript, /cp "\$\{ROOT_DIR\}\/package\.json" "\$\{COMPANION_DIR\}\/package\.json"/)
  assert.match(trayScript, /find "\$\{ROOT_DIR\}\/src" -maxdepth 1 -type f -name '\*\.mjs' ! -name '\*\.test\.mjs'/)
  assert.doesNotMatch(trayScript, /cp "\$\{ROOT_DIR\}"\/src\/\*\.mjs "\$\{COMPANION_DIR\}\/src\/"/)

  assert.doesNotMatch(pkgScript, /cp "\$\{ROOT_DIR\}\/bin\/native-host\.mjs" "\$\{PAYLOAD_DIR\}\/native-host\.mjs"/)
  assert.doesNotMatch(pkgScript, /cp "\$\{ROOT_DIR\}\/bin\/cli\.mjs" "\$\{PAYLOAD_DIR\}\/cli\.mjs"/)
  assert.doesNotMatch(pkgScript, /cp "\$\{ROOT_DIR\}\/package\.json" "\$\{PAYLOAD_DIR\}\/package\.json"/)
  assert.doesNotMatch(pkgScript, /mkdir -p "\$\{PAYLOAD_DIR\}\/src"/)

  assert.match(postinstall, /APP_RUNTIME_DIR="\$\{TRAY_APP_PATH\}\/Contents\/Resources\/companion"/)
  assert.match(postinstall, /APP_NODE_DIR="\$\{TRAY_APP_PATH\}\/Contents\/Resources\/runtime\/node"/)
  assert.match(postinstall, /restart_companion_daemon\(\)/)
  assert.match(postinstall, /"\$\{node_bin\}" "\$\{APP_RUNTIME_DIR\}\/bin\/cli\.mjs" stop --force/)
  assert.match(postinstall, /"\$\{node_bin\}" "\$\{APP_RUNTIME_DIR\}\/bin\/cli\.mjs" start -d/)
  assert.doesNotMatch(postinstall, /deploy_companion_service/)
  assert.doesNotMatch(postinstall, /service_dir="\$\{TRAPEZOHE_DIR\}\/service"/)
  assert.doesNotMatch(postinstall, /wrapper="\$\{LOCAL_NODE_DIR\}\/bin\/trapezohe-companion"/)
})

test('macOS build scripts wire Developer ID signing and notarization into the installer flow', () => {
  const trayScript = read('scripts/build-tray-macos.sh')
  const pkgScript = read('scripts/build-macos-pkg.sh')
  const signingLib = read('scripts/lib/macos-signing.sh')

  assert.match(trayScript, /source "\$\{ROOT_DIR\}\/scripts\/lib\/macos-signing\.sh"/)
  assert.match(trayScript, /TRAPEZOHE_MACOS_STAGE_ROOT/)
  assert.match(trayScript, /macos_sign_app_bundle "\$\{APP_DIR\}"/)

  assert.match(pkgScript, /source "\$\{ROOT_DIR\}\/scripts\/lib\/macos-signing\.sh"/)
  assert.match(pkgScript, /TRAPEZOHE_MACOS_STAGE_ROOT/)
  assert.match(pkgScript, /SIGNED_PACKAGE_FILE=/)
  assert.match(pkgScript, /macos_sign_pkg "\$\{PACKAGE_FILE\}" "\$\{SIGNED_PACKAGE_FILE\}"/)
  assert.match(pkgScript, /macos_notarize_artifact "\$\{PACKAGE_FILE\}"/)

  assert.match(signingLib, /APPLE_DEVELOPER_ID_APP_IDENTITY/)
  assert.match(signingLib, /APPLE_DEVELOPER_ID_INSTALLER_IDENTITY/)
  assert.match(signingLib, /TRAPEZOHE_MACOS_SIGNING_ENV_FILE/)
  assert.match(signingLib, /codesign --force --sign/)
  assert.match(signingLib, /productsign --sign/)
  assert.match(signingLib, /xcrun notarytool submit/)
  assert.match(signingLib, /xcrun stapler staple/)
})

test('macOS signing helpers normalize Developer ID subjects before checking identities', () => {
  const signingLibPath = path.join(root, 'scripts/lib/macos-signing.sh')
  const output = execFileSync(
    'bash',
    [
      '-lc',
      `
        source "${signingLibPath}"
        printf '%s\\n' "$(macos_normalize_identity_name 'Developer ID Application: peng wang (VW9LG92726),UID=VW9LG92726')"
        printf '%s\\n' "$(macos_normalize_identity_name 'Developer ID Installer: peng wang (VW9LG92726)')"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.deepEqual(output.trim().split('\n'), [
    'Developer ID Application: peng wang (VW9LG92726)',
    'Developer ID Installer: peng wang (VW9LG92726)',
  ])
})

test('macOS tray control and native host registration prefer the bundled app runtime', () => {
  const daemonRs = read('tray/src/daemon.rs')
  const cli = read('bin/cli.mjs')

  assert.match(daemonRs, /resolve_bundled_cli_invocation_from/)
  assert.match(daemonRs, /Resources"\)\s*\.join\("runtime"\)\s*\.join\("node"\)\s*\.join\("bin"\)\s*\.join\("node"/)
  assert.match(daemonRs, /Resources"\)\s*\.join\("companion"\)\s*\.join\("bin"\)\s*\.join\("cli\.mjs"/)

  assert.match(cli, /function resolveBundledMacosRuntime/)
  assert.match(cli, /async function resolveCliLaunchSpec/)
  assert.match(cli, /process\.platform === 'darwin'/)
  assert.match(cli, /native-host-launcher\.sh/)
  assert.match(cli, /const runtime = await resolveBundledMacosRuntime\(entryScript\)/)
  assert.match(cli, /const launchSpec = await resolveCliLaunchSpec\(\)/)
  assert.match(cli, /<string>\$\{launchSpec\.program\}<\/string>/)
  assert.match(cli, /launchSpec\.args\.map\(\(arg\) => `  <string>\$\{arg\}<\/string>`\)\.join\('\\n'\)/)
  assert.match(cli, /await execFileAsync\(launchSpec\.program, \[\.\.\.launchSpec\.args, '-d'\]\)/)
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
  assert.match(installer, /function Stop-InstalledCompanionDaemon/)
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
  assert.match(installer, /if \(\$StopTrayOnly\) \{[\s\S]+?Write-InstallerLog "Windows installer tray pre-stop started\."[\s\S]+?Stop-RunningTrayProcesses[\s\S]+?Stop-InstalledCompanionDaemon[\s\S]+?Write-InstallerLog "Windows installer tray pre-stop finished\."[\s\S]+?exit 0[\s\S]+?\}/s)
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
  assert.match(installer, /if \(\$Cleanup\) \{[\s\S]+?Stop-RunningTrayProcesses[\s\S]+?Stop-InstalledCompanionDaemon[\s\S]+?Remove-DesktopShortcut[\s\S]+?Remove-StartMenuShortcut[\s\S]+?Remove-TrayAutoStart[\s\S]+?exit 0[\s\S]+?\}/s)
  assert.match(wxs, /Id="UninstallCleanup"/)
  assert.match(wxs, /ExeCommand="cmd\.exe \/c run-install\.cmd -Cleanup"/)
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

  assert.equal(pkg.version, '0.1.18')
  assert.match(cargoToml, /^version = "0\.1\.18"$/m)
  assert.equal(tauriConfig.version, '0.1.18')
})

test('README and release copy describe the signed macOS flow without claiming every installer is unsigned', () => {
  const readme = read('README.md')
  const releaseWorkflow = read('.github/workflows/release-installers.yml')

  assert.doesNotMatch(readme, /Installers are currently unsigned/i)
  assert.match(readme, /macOS installer is signed and notarized/i)
  assert.match(readme, /Windows installer may still trigger SmartScreen/i)

  assert.doesNotMatch(releaseWorkflow, /Since these installers are not code-signed/i)
  assert.match(releaseWorkflow, /macOS installer is Developer ID signed and notarized/i)
  assert.match(releaseWorkflow, /Windows — SmartScreen/i)
})

test('macOS tray updater is wired for signed in-app updates with a manual-install fallback for unsupported app locations', () => {
  const cargoToml = read('tray/Cargo.toml')
  const tauriConfig = JSON.parse(read('tray/tauri.conf.json'))
  const capabilities = read('tray/capabilities/default.json')
  const trayUi = read('tray/ui/index.html')
  const trayLib = read('tray/src/lib.rs')
  const updaterRs = read('tray/src/update.rs')

  assert.match(cargoToml, /tauri-plugin-updater\s*=\s*(?:"2"|\{\s*version\s*=\s*"2")/)
  assert.match(capabilities, /updater:default/)

  assert.equal(tauriConfig.plugins?.updater?.active, true)
  assert.match(
    String(tauriConfig.plugins?.updater?.endpoints?.[0] || ''),
    /https:\/\/github\.com\/Trapezohe\/companion_service\/releases\/latest\/download\/latest\.json/,
  )
  assert.match(String(tauriConfig.plugins?.updater?.pubkey || ''), /\S+/)

  assert.match(trayLib, /tauri_plugin_updater::Builder/)
  assert.match(trayLib, /install_update/)
  assert.match(updaterRs, /download_and_install/)
  assert.match(updaterRs, /Automatic updates only work for the packaged app installed in \/Applications or ~\/Applications/)

  assert.match(trayUi, /install_update/)
  assert.match(trayUi, /open_release_page/)
  assert.match(trayUi, /updateManualInstall/)
  assert.match(trayUi, /update\.available && !update\.can_install/)
  assert.match(trayUi, /Download & Install|Installing|Downloading update/)
  assert.doesNotMatch(trayUi, /\$\('updateBanner'\)\.addEventListener\('click', async \(\) => \{\s*if \(invoke\) await invoke\('open_release_page'\)/)
})

test('tray panel surface is a narrow unified dashboard with built-in language switching', () => {
  const trayUi = read('tray/ui/index.html')

  assert.match(trayUi, /set_display_language/)
  assert.match(trayUi, /recentActions|action_logs/)
  assert.match(trayUi, /language-picker|language-option/)
  assert.match(trayUi, /panel-shell|panel-card|panel-footer/)
  assert.doesNotMatch(trayUi, /menuBtn/)
  assert.doesNotMatch(trayUi, /dropdown-item/)
})

test('tray panel exposes a release-page fallback and stable MCP status styling helpers', () => {
  const trayUi = read('tray/ui/index.html')

  assert.match(trayUi, /id="releasePageButton"/)
  assert.match(trayUi, /open_release_page/)
  assert.match(trayUi, /function serverStatusClass\(/)
  assert.match(trayUi, /function localizedServerStatus\(/)
  assert.match(trayUi, /status-\$\{esc\(serverStatusClass\(server\.status\)\)\}/)
})

test('tray panel uses a dark anchored dropdown surface instead of the previous light popup look', () => {
  const trayUi = read('tray/ui/index.html')
  const tauriConfig = JSON.parse(read('tray/tauri.conf.json'))

  assert.match(trayUi, /color-scheme:\s*dark/)
  assert.match(trayUi, /--window-bg:\s*transparent/i)
  assert.match(trayUi, /\.panel-shell::before/)
  assert.match(trayUi, /--panel:\s*rgba\(30,\s*30,\s*30,\s*0\.70\)/i)
  assert.equal(tauriConfig.app?.windows?.[0]?.width, 344)
  assert.equal(tauriConfig.app?.windows?.[0]?.minWidth, 344)
})

test('tray panel keeps only settings on the main footer, moves logs and service actions into settings, and hides latest-version noise', () => {
  const trayUi = read('tray/ui/index.html')

  assert.match(trayUi, /id="logsEntryButton"/)
  assert.match(trayUi, /id="serviceActionButton"/)
  assert.match(trayUi, /id="quitQuickButton"/)
  assert.match(trayUi, /id="versionMeta"/)
  assert.match(trayUi, /function shouldShowUpdateNote\(/)
  assert.match(trayUi, /updateNote'\)\.hidden = !shouldShowUpdateNote/)
  assert.doesNotMatch(trayUi, /id="showLogsButton"/)
  assert.doesNotMatch(trayUi, /id="serviceButton"/)
  assert.doesNotMatch(trayUi, /id="versionPill"/)
})

test('release workflow publishes macOS updater archive, signature, and latest manifest', () => {
  const workflow = read('.github/workflows/release-installers.yml')
  const updaterScript = read('scripts/build-macos-updater-artifacts.sh')
  const updaterLib = read('scripts/lib/tauri-updater.sh')
  const signingLib = read('scripts/lib/macos-signing.sh')

  assert.match(workflow, /build-macos-updater-artifacts\.sh/)
  assert.match(workflow, /trapezohe-companion-macos\.app\.tar\.gz/)
  assert.match(workflow, /trapezohe-companion-macos\.app\.tar\.gz\.sig/)
  assert.match(workflow, /latest\.json/)
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY|TRAPEZOHE_UPDATER_PRIVATE_KEY/)

  assert.match(updaterScript, /latest\.json/)
  assert.match(updaterScript, /\.app\.tar\.gz/)
  assert.match(updaterScript, /\.sig/)
  assert.match(updaterScript, /github\.com\/Trapezohe\/companion_service\/releases\/download\/v\$\{VERSION\}/)
  assert.match(updaterScript, /macos_notarize_app_bundle "\$\{APP_PATH\}"/)
  assert.doesNotMatch(updaterScript, /macos_notarize_artifact "\$\{APP_PATH\}"/)

  assert.match(updaterLib, /@tauri-apps\/cli@2\.10\.1/)
  assert.match(updaterLib, /signer[\s\S]+sign/)
  assert.match(updaterLib, /TAURI_PRIVATE_KEY_PASSWORD="\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD\}"/)
  assert.match(updaterLib, /case "\$\{TAURI_PRIVATE_KEY_PASSWORD:-\}" in[\s\S]+EMPTY[\s\S]+TAURI_PRIVATE_KEY_PASSWORD=""/)
  assert.match(updaterLib, /-u TAURI_SIGNING_PRIVATE_KEY/)
  assert.match(updaterLib, /-u TAURI_SIGNING_PRIVATE_KEY_PATH/)
  assert.match(updaterLib, /-u TAURI_SIGNING_PRIVATE_KEY_PASSWORD/)
  assert.match(updaterLib, /-u TAURI_PRIVATE_KEY/)
  assert.match(updaterLib, /-u TAURI_PRIVATE_KEY_PATH/)
  assert.match(updaterLib, /-u TAURI_PRIVATE_KEY_PASSWORD/)
  assert.match(signingLib, /macos_notarize_app_bundle\(\)/)
  assert.match(signingLib, /ditto -c -k --sequesterRsrc --keepParent/)
  assert.match(signingLib, /xcrun stapler staple "\$\{app_path\}"/)
})

test('tauri updater signer strips conflicting private key env vars before invoking tauri cli', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const capturePath = path.join(tempDir, 'capture.txt')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'TAURI_SIGNING_PRIVATE_KEY=%s\\n' "\${TAURI_SIGNING_PRIVATE_KEY-__UNSET__}"
  printf 'TAURI_SIGNING_PRIVATE_KEY_PATH=%s\\n' "\${TAURI_SIGNING_PRIVATE_KEY_PATH-__UNSET__}"
  printf 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%s\\n' "\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-__UNSET__}"
  printf 'TAURI_PRIVATE_KEY=%s\\n' "\${TAURI_PRIVATE_KEY-__UNSET__}"
  printf 'TAURI_PRIVATE_KEY_PATH=%s\\n' "\${TAURI_PRIVATE_KEY_PATH-__UNSET__}"
  printf 'TAURI_PRIVATE_KEY_PASSWORD=%s\\n' "\${TAURI_PRIVATE_KEY_PASSWORD-__UNSET__}"
  printf 'ARGS=%s\\n' "$*"
} > "${capturePath}"
printf 'signed' > "\${@: -1}.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_SIGNING_PRIVATE_KEY='inline-private-key'
        export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='EMPTY'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  const capture = readFileSync(capturePath, 'utf8')
  assert.match(capture, /TAURI_SIGNING_PRIVATE_KEY=__UNSET__/)
  assert.match(capture, /TAURI_SIGNING_PRIVATE_KEY_PATH=__UNSET__/)
  assert.match(capture, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD=__UNSET__/)
  assert.match(capture, /TAURI_PRIVATE_KEY=__UNSET__/)
  assert.match(capture, /TAURI_PRIVATE_KEY_PATH=__UNSET__/)
  assert.match(capture, /TAURI_PRIVATE_KEY_PASSWORD=__UNSET__/)
  assert.match(capture, /ARGS=-y @tauri-apps\/cli@2\.10\.1 signer sign -f /)
  assert.match(capture, new RegExp(`ARGS=.*${archivePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('tauri updater signer encodes raw minisign secret key files into the base64 format expected by tauri cli', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-key-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'source.key')
  const copiedKeyPath = path.join(tempDir, 'copied.key')
  const multiLineKey = 'untrusted comment: minisign secret key\\nABCDEF123456\\n'

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, multiLineKey)
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
key_path=""
archive_path=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then
    key_path="$2"
    shift 2
    continue
  fi
  archive_path="$1"
  shift
done
cp "$key_path" "${copiedKeyPath}"
printf 'signed' > "$archive_path.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
        export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='EMPTY'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(
    readFileSync(copiedKeyPath, 'utf8'),
    Buffer.from('untrusted comment: minisign secret key\nABCDEF123456\n').toString('base64'),
  )
})

test('tauri updater signer compacts wrapped base64 key files before signing', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-key-space-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'wrapped.key')
  const copiedKeyPath = path.join(tempDir, 'copied.key')
  const base64Key = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=='

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, `'dW50cn VzdGVk\nIGNvbW1l bnQ6IHJz\naWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=='\n`)
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
key_path=""
archive_path=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then
    key_path="$2"
    shift 2
    continue
  fi
  archive_path="$1"
  shift
done
cp "$key_path" "${copiedKeyPath}"
printf 'signed' > "$archive_path.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(readFileSync(copiedKeyPath, 'utf8'), base64Key)
})

test('tauri updater signer removes embedded quote characters from quoted base64 key files before signing', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-key-quote-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'quoted-lines.key')
  const copiedKeyPath = path.join(tempDir, 'copied.key')
  const base64Key = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=='

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, '"dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu"\n"IGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="\n')
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
key_path=""
archive_path=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then
    key_path="$2"
    shift 2
    continue
  fi
  archive_path="$1"
  shift
done
cp "$key_path" "${copiedKeyPath}"
printf 'signed' > "$archive_path.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(readFileSync(copiedKeyPath, 'utf8'), base64Key)
})

test('tauri updater signer encodes raw key headers even when spaces were replaced with underscores', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-key-underscore-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'underscore.key')
  const copiedKeyPath = path.join(tempDir, 'copied.key')
  const rawKey = 'untrusted_comment:_minisign_secret_key\nABCDEF123456\n'

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, rawKey)
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
key_path=""
archive_path=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then
    key_path="$2"
    shift 2
    continue
  fi
  archive_path="$1"
  shift
done
cp "$key_path" "${copiedKeyPath}"
printf 'signed' > "$archive_path.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(readFileSync(copiedKeyPath, 'utf8'), Buffer.from('untrusted comment: minisign secret key\nABCDEF123456\n').toString('base64'))
})

test('tauri updater signer converts url-safe base64 key variants back to standard base64 before signing', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-key-urlsafe-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'urlsafe.key')
  const copiedKeyPath = path.join(tempDir, 'copied.key')
  const standardBase64Key = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=='
  const urlSafeBase64Key = standardBase64Key.replace(/\//g, '_').replace(/\+/g, '-')

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, urlSafeBase64Key)
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
key_path=""
archive_path=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then
    key_path="$2"
    shift 2
    continue
  fi
  archive_path="$1"
  shift
done
cp "$key_path" "${copiedKeyPath}"
printf 'signed' > "$archive_path.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(readFileSync(copiedKeyPath, 'utf8'), standardBase64Key)
})

test('tauri updater signer strips a single wrapping quote pair from key files before signing', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-quoted-key-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'quoted.key')
  const copiedKeyPath = path.join(tempDir, 'copied.key')
  const quotedKey = '"dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="'

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, `${quotedKey}\n`)
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
key_path=""
archive_path=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then
    key_path="$2"
    shift 2
    continue
  fi
  archive_path="$1"
  shift
done
cp "$key_path" "${copiedKeyPath}"
printf 'signed' > "$archive_path.sig"
`,
    { mode: 0o755 },
  )

  execFileSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        PATH="${fakeBinDir}:$PATH"
        source "${updaterLibPath}"
        export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
        tauri_sign_archive "${archivePath}" "${signaturePath}"
      `,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(
    readFileSync(copiedKeyPath, 'utf8'),
    'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg==',
  )
})

test('tauri updater signer fails early with a secret-format error when base64 padding appears before the end', () => {
  const updaterLibPath = path.join(root, 'scripts/lib/tauri-updater.sh')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trapezohe-updater-key-invalid-padding-test-'))
  const fakeBinDir = path.join(tempDir, 'bin')
  const archivePath = path.join(tempDir, 'artifact.tar.gz')
  const signaturePath = path.join(tempDir, 'artifact.tar.gz.sig.out')
  const fakeNpxPath = path.join(fakeBinDir, 'npx')
  const sourceKeyPath = path.join(tempDir, 'invalid-padding.key')

  execFileSync('mkdir', ['-p', fakeBinDir])
  writeFileSync(archivePath, 'archive')
  writeFileSync(sourceKeyPath, 'YWJjZA==ZWY=')
  writeFileSync(
    fakeNpxPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'signed' > "$1.sig"
`,
    { mode: 0o755 },
  )

  assert.throws(
    () =>
      execFileSync(
        'bash',
        [
          '-lc',
          `
            set -euo pipefail
            PATH="${fakeBinDir}:$PATH"
            source "${updaterLibPath}"
            export TAURI_PRIVATE_KEY_PATH='${sourceKeyPath}'
            tauri_sign_archive "${archivePath}" "${signaturePath}"
          `,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    /Updater key secret is malformed: found '=' padding before the end of the base64 payload/,
  )
})

test('GitHub macOS release flow writes a signing env file and uses it as the default script input', () => {
  const workflow = read('.github/workflows/release-installers.yml')
  const signingLib = read('scripts/lib/macos-signing.sh')

  assert.match(workflow, /env:\s+APPLE_ID: \$\{\{ secrets\.APPLE_ID \}\}[\s\S]+APPLE_DEVELOPER_ID_APP_P12_BASE64: \$\{\{ secrets\.APPLE_DEVELOPER_ID_APP_P12_BASE64 \}\}/)
  assert.match(workflow, /APPLE_DEVELOPER_ID_APP_P12_PASSWORD: \$\{\{ secrets\.APPLE_DEVELOPER_ID_APP_P12_PASSWORD \}\}/)
  assert.match(workflow, /APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64: \$\{\{ secrets\.APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64 \}\}/)
  assert.match(workflow, /APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD: \$\{\{ secrets\.APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD \}\}/)
  assert.match(workflow, /Validate macOS signing inputs/)
  assert.match(workflow, /Missing required macOS signing secrets:/)
  assert.match(workflow, /APPLE_DEVELOPER_ID_APP_P12_BASE64/)
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/)
  assert.match(workflow, /brew --prefix openssl@3/)
  assert.match(workflow, /brew install openssl@3/)
  assert.match(workflow, /OPENSSL_BIN="\$\{BREW_OPENSSL_PREFIX\}\/bin\/openssl"/)
  assert.match(workflow, /"\$\{OPENSSL_BIN\}" version/)
  assert.match(workflow, /base64\.b64decode\(value, validate=True\)/)
  assert.match(workflow, /decoded to 0 bytes/)
  assert.match(workflow, /"\$\{OPENSSL_BIN\}" pkcs12 -legacy[\s\S]+-in "\$\{APP_P12\}"/)
  assert.match(workflow, /APP_PEM="\$\{RUNNER_TEMP\}\/developer-id-app\.pem"/)
  assert.match(workflow, /INSTALLER_PEM="\$\{RUNNER_TEMP\}\/developer-id-installer\.pem"/)
  assert.match(workflow, /security import "\$\{APP_PEM\}"[\s\S]+-k "\$\{KEYCHAIN_PATH\}"/)
  assert.match(workflow, /security import "\$\{INSTALLER_PEM\}"[\s\S]+-k "\$\{KEYCHAIN_PATH\}"/)
  assert.match(workflow, /DETECTED_APPLE_DEVELOPER_ID_APP_IDENTITY/)
  assert.match(workflow, /DETECTED_APPLE_DEVELOPER_ID_INSTALLER_IDENTITY/)
  assert.match(workflow, /SIGNING_ENV_FILE="\$\{RUNNER_TEMP\}\/trapezohe-macos-signing\.env"/)
  assert.match(workflow, /APP_IDENTITY="\$\{APPLE_DEVELOPER_ID_APP_IDENTITY:-\$\{DETECTED_APPLE_DEVELOPER_ID_APP_IDENTITY:-\}\}"/)
  assert.match(workflow, /INSTALLER_IDENTITY="\$\{APPLE_DEVELOPER_ID_INSTALLER_IDENTITY:-\$\{DETECTED_APPLE_DEVELOPER_ID_INSTALLER_IDENTITY:-\}\}"/)
  assert.match(workflow, /printf 'export APPLE_DEVELOPER_ID_APP_IDENTITY=%q\\n' "\$\{APP_IDENTITY\}"/)
  assert.match(workflow, /printf 'export APPLE_DEVELOPER_ID_INSTALLER_IDENTITY=%q\\n' "\$\{INSTALLER_IDENTITY\}"/)
  assert.match(workflow, /TAURI_KEY_FILE="\$\{RUNNER_TEMP\}\/tauri-updater-signing-key"/)
  assert.match(workflow, /printf '%s' "\$\{TAURI_SIGNING_PRIVATE_KEY\}" > "\$\{TAURI_KEY_FILE\}"/)
  assert.match(workflow, /printf 'export TAURI_PRIVATE_KEY_PATH=%q\\n' "\$\{TAURI_KEY_FILE\}"/)
  assert.match(workflow, /printf 'export TAURI_PRIVATE_KEY_PASSWORD=%q\\n' "\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-\}"/)
  assert.match(workflow, /echo "TRAPEZOHE_MACOS_SIGNING_ENV_FILE=\$\{SIGNING_ENV_FILE\}" >> "\$GITHUB_ENV"/)
  assert.match(workflow, /echo "TRAPEZOHE_UPDATER_ENV_FILE=\$\{SIGNING_ENV_FILE\}" >> "\$GITHUB_ENV"/)
  assert.match(workflow, /rm -f "\$\{RUNNER_TEMP\}\/tauri-updater-signing-key" \|\| true/)
  assert.match(workflow, /rm -f "\$\{RUNNER_TEMP\}\/developer-id-app\.p12" "\$\{RUNNER_TEMP\}\/developer-id-installer\.p12" "\$\{RUNNER_TEMP\}\/developer-id-app\.pem" "\$\{RUNNER_TEMP\}\/developer-id-installer\.pem" \|\| true/)
  assert.match(workflow, /Verify signed macOS release artifacts/)
  assert.match(workflow, /xcrun stapler validate dist\/installers\/trapezohe-companion-macos\.pkg/)
  assert.match(workflow, /latest = json\.loads\(Path\("dist\/installers\/latest\.json"\)\.read_text\(\)\)/)
  assert.match(signingLib, /source "\$\{TRAPEZOHE_MACOS_SIGNING_ENV_FILE\}"/)
})
