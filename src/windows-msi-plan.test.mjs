import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getWindowsMsiBuildPlan,
  renderWindowsMsiSource,
} from '../scripts/windows-msi-plan.mjs'

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
  assert.match(wxs, /<Directory Id="INSTALLFOLDER" Name="TrapezoheCompanion" \/>/)
  assert.match(wxs, /Source="\$\(var\.InstallerSourceDir\)\/run-install\.cmd"/)
  assert.match(wxs, /FileRef="RunInstallCmd"/)
  assert.match(wxs, /Return="check"/)
  assert.doesNotMatch(wxs, /Return="ignore"/)
})

test('wix3 source renders absolute posix file paths for wixl', () => {
  const wxs = renderWindowsMsiSource({
    schemaVersion: 'wix3',
    productVersion: '0.1.2',
    installerSourceDir: 'C:\\temp\\stage\\source',
  })
  assert.match(wxs, /http:\/\/schemas\.microsoft\.com\/wix\/2006\/wi/)
  assert.match(wxs, /<Directory Id="INSTALLFOLDER" Name="TrapezoheCompanion">/)
  assert.match(wxs, /Source="C:\/temp\/stage\/source\/run-install\.cmd"/)
  assert.match(wxs, /FileKey="RunInstallCmd"/)
  assert.match(wxs, /Return="check"/)
  assert.doesNotMatch(wxs, /Return="ignore"/)
  assert.match(wxs, /<Custom Action="RunCompanionBootstrap" After="InstallFiles">NOT Installed<\/Custom>/)
})
