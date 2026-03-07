import test from 'node:test'
import assert from 'node:assert/strict'
import { getWindowsTrayBuildPlan, resolvePwshCommand } from '../scripts/windows-build-plan.mjs'

test('host windows uses native cargo release output', () => {
  const plan = getWindowsTrayBuildPlan({ hostPlatform: 'win32' })
  assert.equal(plan.cargoCommand, 'cargo')
  assert.deepEqual(plan.cargoArgs, ['build', '--manifest-path', 'tray/Cargo.toml', '--release'])
  assert.equal(plan.exeRelativePath, 'tray/target/release/trapezohe-companion-tray.exe')
  assert.equal(plan.targetTriple, null)
})

test('host macOS uses cargo xwin and windows target output path', () => {
  const plan = getWindowsTrayBuildPlan({ hostPlatform: 'darwin' })
  assert.equal(plan.cargoCommand, 'cargo')
  assert.deepEqual(plan.cargoArgs, [
    'xwin',
    'build',
    '--manifest-path',
    'tray/Cargo.toml',
    '--release',
    '--target',
    'x86_64-pc-windows-msvc',
  ])
  assert.equal(plan.exeRelativePath, 'tray/target/x86_64-pc-windows-msvc/release/trapezohe-companion-tray.exe')
  assert.equal(plan.targetTriple, 'x86_64-pc-windows-msvc')
})

test('explicit target override is respected for cross builds', () => {
  const plan = getWindowsTrayBuildPlan({
    hostPlatform: 'linux',
    targetTriple: 'aarch64-pc-windows-msvc',
  })
  assert.deepEqual(plan.cargoArgs.slice(-2), ['--target', 'aarch64-pc-windows-msvc'])
  assert.equal(plan.exeRelativePath, 'tray/target/aarch64-pc-windows-msvc/release/trapezohe-companion-tray.exe')
})

test('resolvePwshCommand prefers pwsh over legacy powershell', () => {
  assert.equal(resolvePwshCommand({ pwsh: '/tmp/pwsh', powershell: '/tmp/powershell' }), 'pwsh')
  assert.equal(resolvePwshCommand({ pwsh: '', powershell: '/tmp/powershell' }), 'powershell')
  assert.equal(resolvePwshCommand({ pwsh: '', powershell: '' }), 'pwsh')
})
