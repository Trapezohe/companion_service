import os from 'node:os'
import path from 'node:path'

export const NATIVE_HOST_NAMES = ['com.ghast.companion', 'com.trapezohe.companion']
export const FIXED_EXTENSION_ID = 'nnhdkkgpoeojjddikcjadgpkbfbjhcal'
export const FIXED_EXTENSION_IDS = [FIXED_EXTENSION_ID]

export function normalizeExtensionIds(ids = []) {
  return Array.from(
    new Set(
      (Array.isArray(ids) ? ids : [])
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

export function getConfiguredExtensionIds(_config) {
  return [...FIXED_EXTENSION_IDS]
}

export function normalizeExtensionOrigin(origin = '') {
  if (typeof origin !== 'string') return ''
  return origin.trim().replace(/\/+$/, '')
}

export function isChromeExtensionOrigin(origin = '') {
  const normalized = normalizeExtensionOrigin(origin)
  return /^chrome-extension:\/\/[a-p]{32}$/.test(normalized)
}

export function resolveBootstrapExtensionIds(_options = {}) {
  return [...FIXED_EXTENSION_IDS]
}

export function resolveNativeHostExtensionIds(_config, _cliExtensionIds = [], _options = {}) {
  return [...FIXED_EXTENSION_IDS]
}

export function getAllowedOrigins(extensionIds) {
  return normalizeExtensionIds(extensionIds).map((id) => `chrome-extension://${id}/`)
}

export function getNativeHostManifestDirs({ platform = process.platform, homeDir = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return [
      path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      path.join(homeDir, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      path.join(homeDir, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
      path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
    ]
  }
  if (platform === 'linux') {
    return [
      path.join(homeDir, '.config', 'google-chrome', 'NativeMessagingHosts'),
      path.join(homeDir, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      path.join(homeDir, '.config', 'chromium', 'NativeMessagingHosts'),
      path.join(homeDir, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    ]
  }
  if (platform === 'win32') {
    return [path.join(homeDir, '.trapezohe')]
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

export function getNativeHostManifestTargets(options = {}) {
  const hostNames = Array.isArray(options.hostNames) && options.hostNames.length > 0
    ? normalizeExtensionIds(options.hostNames)
    : NATIVE_HOST_NAMES
  const dirs = getNativeHostManifestDirs(options)
  const targets = []
  for (const hostName of hostNames) {
    for (const dir of dirs) {
      targets.push({
        hostName,
        dir,
        manifestPath: path.join(dir, `${hostName}.json`),
      })
    }
  }
  return targets
}
