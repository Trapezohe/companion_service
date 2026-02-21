import path from 'node:path'
import os from 'node:os'

export const PERMISSION_MODE_WORKSPACE = 'workspace'
export const PERMISSION_MODE_FULL = 'full'

const VALID_MODES = new Set([PERMISSION_MODE_WORKSPACE, PERMISSION_MODE_FULL])

function normalizeWorkspaceRoots(rawRoots) {
  const roots = Array.isArray(rawRoots)
    ? rawRoots
    : (typeof rawRoots === 'string' && rawRoots.trim() ? [rawRoots] : [])

  const normalized = []
  for (const root of roots) {
    if (typeof root !== 'string') continue
    const trimmed = root.trim()
    if (!trimmed) continue
    const expanded = trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed
    normalized.push(path.resolve(expanded))
  }

  return Array.from(new Set(normalized))
}

export function normalizePermissionPolicy(input = {}, { strict = false } = {}) {
  const rawMode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : PERMISSION_MODE_FULL

  if (!VALID_MODES.has(rawMode)) {
    if (strict) {
      throw new Error(`Invalid permission mode: "${input.mode}". Expected "full" or "workspace".`)
    }
    // Default to workspace (more restrictive) rather than full when mode is unrecognized
    console.warn(`[permission-policy] Unrecognized mode "${input.mode}", defaulting to "workspace".`)
  }

  const normalizedMode = VALID_MODES.has(rawMode) ? rawMode : PERMISSION_MODE_WORKSPACE
  const workspaceRoots = normalizeWorkspaceRoots(input.workspaceRoots)

  return {
    mode: normalizedMode,
    workspaceRoots: normalizedMode === PERMISSION_MODE_WORKSPACE ? workspaceRoots : [],
  }
}

export function isPathWithinRoots(targetPath, roots) {
  const resolvedTarget = path.resolve(targetPath)
  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    if (resolvedTarget === resolvedRoot) return true
    const rel = path.relative(resolvedRoot, resolvedTarget)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  }
  return false
}
