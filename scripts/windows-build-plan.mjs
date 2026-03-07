import path from 'node:path'

const DEFAULT_WINDOWS_TARGET = 'x86_64-pc-windows-msvc'
const TRAY_MANIFEST_PATH = 'tray/Cargo.toml'
const TRAY_EXE_NAME = 'trapezohe-companion-tray.exe'

export function getWindowsTrayBuildPlan({
  hostPlatform = process.platform,
  targetTriple = process.env.TRAPEZOHE_WINDOWS_TARGET || '',
} = {}) {
  const normalizedPlatform = String(hostPlatform || '').trim().toLowerCase()
  const normalizedTarget = String(targetTriple || '').trim()
  const needsCrossTarget = normalizedPlatform !== 'win32'
  const finalTarget = needsCrossTarget ? (normalizedTarget || DEFAULT_WINDOWS_TARGET) : null
  const cargoArgs = ['build', '--manifest-path', TRAY_MANIFEST_PATH, '--release']

  if (needsCrossTarget) {
    cargoArgs.unshift('xwin')
    cargoArgs.push('--target', finalTarget)
  }

  const exeRelativePath = finalTarget
    ? path.posix.join('tray', 'target', finalTarget, 'release', TRAY_EXE_NAME)
    : path.posix.join('tray', 'target', 'release', TRAY_EXE_NAME)

  return {
    cargoCommand: 'cargo',
    cargoArgs,
    targetTriple: finalTarget,
    exeName: TRAY_EXE_NAME,
    exeRelativePath,
  }
}

export function resolvePwshCommand({
  pwsh = process.env.TRAPEZOHE_PWSH_PATH || '',
  powershell = process.env.TRAPEZOHE_POWERSHELL_PATH || '',
} = {}) {
  if (String(pwsh || '').trim()) return 'pwsh'
  if (String(powershell || '').trim()) return 'powershell'
  return 'pwsh'
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(getWindowsTrayBuildPlan())}\n`)
}
