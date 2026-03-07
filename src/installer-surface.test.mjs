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
