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

  assert.match(installer, /function Restart-CompanionDaemon/)
  assert.match(installer, /& trapezohe-companion stop --force/)
  assert.match(installer, /& trapezohe-companion start -d/)
  assert.match(installer, /Bootstrap-Companion \| Out-Null\s+Restart-CompanionDaemon\s+Launch-TrayOnce/s)
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

  assert.equal(pkg.version, '0.1.8')
  assert.match(cargoToml, /^version = "0\.1\.8"$/m)
  assert.equal(tauriConfig.version, '0.1.8')
})
