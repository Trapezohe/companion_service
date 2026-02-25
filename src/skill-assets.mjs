/**
 * Skill asset filesystem management.
 *
 * Writes skill script assets to ~/.trapezohe/skills/{skillName}/
 * so the companion runtime can execute them via run_local_command.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getConfigDir, ensureConfigDir } from './config.mjs'

const SKILLS_DIR = () => path.join(getConfigDir(), 'skills')

// ── Limits ──

const MAX_ASSET_FILES = 50
const MAX_ASSET_SIZE = 100_000 // 100 KB per file
const MAX_DEPTH = 4
const FILE_MODE = 0o644
const DIR_MODE = 0o755

// ── Validation ──

const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

/**
 * Validate a relative path segment to prevent path traversal.
 * Rejects: absolute paths, .., backslashes, control characters, depth > MAX_DEPTH.
 */
function validateRelativePath(relPath) {
  if (!relPath || typeof relPath !== 'string') return false
  if (/\\/.test(relPath)) return false
  if (relPath.startsWith('/')) return false
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (/[\x00-\x1f]/.test(seg)) return false
  }
  if (segments.length > MAX_DEPTH) return false
  return true
}

// ── Core functions ──

/**
 * Write SKILL.md and all asset files under ~/.trapezohe/skills/{skillName}/.
 *
 * @param {string} skillName  Validated skill identifier
 * @param {Array<{relativePath: string, content: string}>} assets
 * @param {string} [skillMd]  Raw SKILL.md content to write alongside assets
 * @returns {Promise<{baseDir: string, filesWritten: number}>}
 */
export async function extractSkillAssets(skillName, assets, skillMd) {
  if (!skillName || typeof skillName !== 'string' || !SAFE_SKILL_NAME.test(skillName)) {
    throw new Error(`Invalid skill name: "${skillName}"`)
  }
  if (!Array.isArray(assets)) {
    throw new Error('"assets" must be an array.')
  }
  if (assets.length > MAX_ASSET_FILES) {
    throw new Error(`Too many asset files (${assets.length}), maximum is ${MAX_ASSET_FILES}.`)
  }

  await ensureConfigDir()
  const skillDir = path.join(SKILLS_DIR(), skillName)
  await fs.mkdir(skillDir, { recursive: true, mode: DIR_MODE })

  let filesWritten = 0

  // Write SKILL.md if provided
  if (typeof skillMd === 'string' && skillMd.length > 0) {
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, {
      encoding: 'utf8',
      mode: FILE_MODE,
    })
    filesWritten += 1
  }

  // Write each asset file
  for (const asset of assets) {
    if (!validateRelativePath(asset.relativePath)) {
      throw new Error(`Invalid asset path: "${asset.relativePath}"`)
    }
    if (typeof asset.content !== 'string') {
      throw new Error(`Asset content must be a string: "${asset.relativePath}"`)
    }
    if (Buffer.byteLength(asset.content, 'utf8') > MAX_ASSET_SIZE) {
      throw new Error(`Asset exceeds ${MAX_ASSET_SIZE} bytes: "${asset.relativePath}"`)
    }

    const fullPath = path.resolve(skillDir, asset.relativePath)
    // Defense-in-depth: verify resolved path is within skill directory
    if (!fullPath.startsWith(skillDir + path.sep) && fullPath !== skillDir) {
      throw new Error(`Asset path escapes skill directory: "${asset.relativePath}"`)
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: DIR_MODE })
    await fs.writeFile(fullPath, asset.content, { encoding: 'utf8', mode: FILE_MODE })
    filesWritten += 1
  }

  return { baseDir: skillDir, filesWritten }
}

/**
 * Remove a skill's asset directory and all its contents.
 *
 * @param {string} skillName
 * @returns {Promise<{removed: boolean}>}
 */
export async function removeSkillAssets(skillName) {
  if (!skillName || typeof skillName !== 'string' || !SAFE_SKILL_NAME.test(skillName)) {
    throw new Error(`Invalid skill name: "${skillName}"`)
  }

  const skillDir = path.join(SKILLS_DIR(), skillName)
  const skillsRoot = SKILLS_DIR()
  // Verify the resolved path is within the skills root
  if (!skillDir.startsWith(skillsRoot + path.sep)) {
    throw new Error('Skill directory path escapes skills root.')
  }

  try {
    await fs.rm(skillDir, { recursive: true, force: true })
    return { removed: true }
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false }
    throw err
  }
}
