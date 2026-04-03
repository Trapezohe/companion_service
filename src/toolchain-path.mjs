import os from 'node:os'
import { delimiter as PATH_DELIMITER, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

const NODE_TOOLCHAIN_COMMANDS = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'corepack',
  'bun',
  'bunx',
])

function splitPathEntries(pathValue, pathDelimiter = PATH_DELIMITER) {
  if (!pathValue || typeof pathValue !== 'string') return []
  return pathValue.split(pathDelimiter).map((entry) => entry.trim()).filter(Boolean)
}

function getNvmNodeBinDirs(homeDir) {
  if (!homeDir) return []
  const nodeVersionsRoot = join(homeDir, '.nvm', 'versions', 'node')
  try {
    return readdirSync(nodeVersionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(nodeVersionsRoot, version, 'bin'))
      .filter((binDir) => existsSync(binDir))
  } catch {
    return []
  }
}

export function buildToolchainPath(basePath, opts = {}) {
  const homeDir = opts.homeDir !== undefined ? opts.homeDir : (process.env.HOME || os.homedir())
  const execDir = opts.execDir || ''
  const pathDelimiter = opts.pathDelimiter || PATH_DELIMITER
  const userBins = homeDir ? [join(homeDir, 'bin'), join(homeDir, '.local', 'bin')] : []
  const nvmNodeBins = getNvmNodeBinDirs(homeDir)
  const preferredEntries = opts.preferNodeToolchain
    ? [
        ...nvmNodeBins,
        ...userBins,
        execDir,
      ]
    : [
        execDir,
        ...userBins,
        ...nvmNodeBins,
      ]
  const entries = [
    ...(opts.preferNodeToolchain ? preferredEntries : splitPathEntries(basePath, pathDelimiter)),
    ...(opts.preferNodeToolchain ? splitPathEntries(basePath, pathDelimiter) : preferredEntries),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]

  const deduped = []
  const seen = new Set()
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    deduped.push(entry)
  }
  return deduped.join(pathDelimiter)
}

export function shouldPreferManagedNodeToolchain(command) {
  if (typeof command !== 'string') return false
  const normalized = command.trim().split(/[\\/]/).pop()?.toLowerCase() || ''
  const withoutExtension = normalized.replace(/\.(?:cmd|bat|exe|ps1)$/i, '')
  return NODE_TOOLCHAIN_COMMANDS.has(withoutExtension)
}
