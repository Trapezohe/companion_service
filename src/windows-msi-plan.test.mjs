import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getWindowsMsiBuildPlan,
  renderWindowsMsiSource,
} from '../scripts/windows-msi-plan.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

test('host windows uses WiX v4 build plan', () => {
  const plan = getWindowsMsiBuildPlan({ hostPlatform: 'win32' })
  assert.equal(plan.builder, 'wix')
  assert.equal(plan.schemaVersion, 'wix4')
  assert.equal(plan.wxsSourceMode, 'v4-template')
})

test('host macOS uses wixl build plan', () => {
  const plan = getWindowsMsiBuildPlan({ hostPlatform: 'darwin' })
  assert.equal(plan.builder, 'wixl')
  assert.equal(plan.schemaVersion, 'wix3')
  assert.equal(plan.wxsSourceMode, 'rendered')
})

test('wix4 source keeps WiX 4 authoring with bind variables', () => {
  const wxs = renderWindowsMsiSource({
    schemaVersion: 'wix4',
    productVersion: '0.1.2',
    installerSourceDir: 'C:\\temp\\source',
  })
  assert.match(wxs, /http:\/\/wixtoolset\.org\/schemas\/v4\/wxs/)
  assert.match(wxs, /MajorUpgrade AllowSameVersionUpgrades="yes" Schedule="afterInstallExecute"/)
  assert.match(wxs, /<Directory Id="INSTALLFOLDER" Name="TrapezoheCompanion" \/>/)
  assert.match(wxs, /Source="\$\(var\.InstallerSourceDir\)\/run-install\.cmd"/)
  assert.match(wxs, /Source="\$\(var\.InstallerSourceDir\)\/trapezohe-companion-package\.tgz"/)
  assert.match(wxs, /Id="StopTrayBeforeInstall"/)
  assert.match(wxs, /FileRef="RunInstallCmd"/)
  assert.match(wxs, /ExeCommand="-StopTrayOnly"/)
  assert.match(wxs, /Id="RunCompanionBootstrap"/)
  assert.match(wxs, /Return="ignore"/)
  assert.match(wxs, /FileRef="RunInstallCmd"/)
  assert.match(wxs, /Return="check"/)
  assert.match(wxs, /<Custom Action="StopTrayBeforeInstall" Before="InstallFiles" Condition="\(Installed OR WIX_UPGRADE_DETECTED\) AND NOT REMOVE~=&quot;ALL&quot;" \/>/)
  assert.match(wxs, /<Custom Action="RunCompanionBootstrap" After="InstallFiles" Condition="NOT REMOVE~=&quot;ALL&quot;" \/>/)
  assert.match(wxs, /Id="UninstallCleanup"/)
  assert.match(wxs, /ExeCommand="-Cleanup"/)
  assert.match(wxs, /<Custom Action="UninstallCleanup" Before="RemoveFiles" Condition="REMOVE~=&quot;ALL&quot;" \/>/)
})

test('wix3 source renders absolute posix file paths for wixl', () => {
  const wxs = renderWindowsMsiSource({
    schemaVersion: 'wix3',
    productVersion: '0.1.2',
    installerSourceDir: 'C:\\temp\\stage\\source',
  })
  assert.match(wxs, /http:\/\/schemas\.microsoft\.com\/wix\/2006\/wi/)
  assert.match(wxs, /MajorUpgrade AllowSameVersionUpgrades="yes" Schedule="afterInstallExecute"/)
  assert.match(wxs, /<Directory Id="INSTALLFOLDER" Name="TrapezoheCompanion">/)
  assert.match(wxs, /Source="C:\/temp\/stage\/source\/run-install\.cmd"/)
  assert.match(wxs, /Source="C:\/temp\/stage\/source\/trapezohe-companion-package\.tgz"/)
  assert.match(wxs, /<CustomAction Id="StopTrayBeforeInstall" FileKey="RunInstallCmd" ExeCommand="-StopTrayOnly" Execute="deferred" Return="ignore" Impersonate="yes" \/>/)
  assert.match(wxs, /FileKey="RunInstallCmd"/)
  assert.match(wxs, /Return="check"/)
  assert.match(wxs, /<Custom Action="StopTrayBeforeInstall" Before="InstallFiles">\(Installed OR WIX_UPGRADE_DETECTED\) AND NOT REMOVE~="ALL"<\/Custom>/)
  assert.match(wxs, /<Custom Action="RunCompanionBootstrap" After="InstallFiles">NOT REMOVE~="ALL"<\/Custom>/)
  assert.match(wxs, /<CustomAction Id="UninstallCleanup" FileKey="RunInstallCmd" ExeCommand="-Cleanup"/)
  assert.match(wxs, /<Custom Action="UninstallCleanup" Before="RemoveFiles">REMOVE~="ALL"<\/Custom>/)
})

test('Windows MSI build script pins WiX output to x64', () => {
  const script = readFileSync(path.join(root, 'scripts/build-windows-msi.ps1'), 'utf8')

  assert.match(script, /wix build[\s\S]+?-arch x64[\s\S]+?-ext WixToolset\.UI\.wixext/s)
})

