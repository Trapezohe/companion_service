import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif'])
const GENERIC_MIME_TYPES = new Set(['application/octet-stream'])
const MIME_BY_EXT = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase() || undefined
}

function getFileExtension(fileName) {
  const normalized = String(fileName || '').trim().toLowerCase()
  if (!normalized) return undefined
  const match = normalized.match(/\.[a-z0-9]+$/i)
  return match ? match[0].toLowerCase() : undefined
}

function resolveSourceMimeType(mimeType, fileName) {
  const normalizedMime = normalizeMimeType(mimeType)
  const extensionMime = MIME_BY_EXT[getFileExtension(fileName)]
  if (!normalizedMime) return extensionMime
  if (GENERIC_MIME_TYPES.has(normalizedMime) && extensionMime) return extensionMime
  return normalizedMime || extensionMime
}

export function shouldNormalizeMimeType(mimeType, fileName) {
  const resolvedMime = resolveSourceMimeType(mimeType, fileName)
  return HEIC_MIME_TYPES.has(resolvedMime)
}

function replaceExtension(name, nextExtension) {
  const normalized = String(name || 'attachment').trim() || 'attachment'
  if (/\.[A-Za-z0-9]+$/.test(normalized)) {
    return normalized.replace(/\.[A-Za-z0-9]+$/, nextExtension)
  }
  return `${normalized}${nextExtension}`
}

async function fileExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

async function canRunCommand(command, versionArgs = ['--version']) {
  try {
    await runProcess(command, versionArgs)
    return true
  } catch {
    return false
  }
}

export async function getMediaNormalizationSupport() {
  if (process.platform === 'darwin' && await fileExists('/usr/bin/sips')) {
    return { available: true, engine: 'sips' }
  }
  if (await canRunCommand('magick')) {
    return { available: true, engine: 'magick' }
  }
  return { available: false, engine: null, reason: 'no_supported_image_converter' }
}

async function convertWithSips({ inputPath, outputPath }) {
  await runProcess('/usr/bin/sips', ['-s', 'format', 'jpeg', inputPath, '--out', outputPath])
  return { engine: 'sips' }
}

async function convertWithMagick({ inputPath, outputPath }) {
  await runProcess('magick', [inputPath, outputPath])
  return { engine: 'magick' }
}

export function buildImagePipelineHints({ sourceMimeType, outputMimeType, engine, status, note }) {
  let summary
  if (status === 'normalized') {
    summary = `Image normalized from ${sourceMimeType} to ${outputMimeType} via ${engine}. OCR hook not enabled yet.`
  } else if (status === 'failed') {
    const detail = String(note || '').trim()
    summary = detail
      ? `Image normalization failed (${detail}); retained as ${outputMimeType}. OCR hook not enabled yet.`
      : `Image normalization failed; retained as ${outputMimeType}. OCR hook not enabled yet.`
  } else {
    summary = `Image retained as ${outputMimeType}. OCR hook not enabled yet.`
  }

  return {
    source: 'image',
    summary,
    ocrReady: false,
  }
}

function buildUnchangedResult(input, normalization) {
  return {
    changed: false,
    name: input.name,
    mimeType: input.mimeType,
    bytesBase64: input.bytesBase64,
    normalization,
    pipelineHints: buildImagePipelineHints({
      sourceMimeType: normalization.sourceMimeType,
      outputMimeType: normalization.outputMimeType,
      engine: normalization.engine || normalization.via || 'none',
      status: normalization.status,
      note: normalization.note,
    }),
  }
}

export async function normalizeImagePayload(input, options = {}) {
  const name = String(input?.name || 'attachment').trim() || 'attachment'
  const requestedMimeType = String(input?.mimeType || 'application/octet-stream').trim() || 'application/octet-stream'
  const sourceMimeType = resolveSourceMimeType(requestedMimeType, name) || requestedMimeType
  const bytesBase64 = String(input?.bytesBase64 || '').trim()
  if (!bytesBase64) {
    throw new Error('bytesBase64 is required.')
  }

  if (!shouldNormalizeMimeType(requestedMimeType, name)) {
    return buildUnchangedResult({ name, mimeType: sourceMimeType, bytesBase64 }, {
      status: 'unchanged',
      sourceMimeType,
      outputMimeType: sourceMimeType,
      via: 'none',
    })
  }

  const support = options.support || await getMediaNormalizationSupport()
  const convert = options.convert || (support.available
    ? support.engine === 'sips'
      ? convertWithSips
      : convertWithMagick
    : null)

  if (!convert) {
    return buildUnchangedResult({ name, mimeType: sourceMimeType, bytesBase64 }, {
      status: 'failed',
      sourceMimeType,
      outputMimeType: sourceMimeType,
      via: 'companion',
      note: support.reason || 'converter_unavailable',
    })
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-media-'))
  const inputPath = path.join(tempDir, path.basename(name))
  const outputName = replaceExtension(name, '.jpg')
  const outputPath = path.join(tempDir, outputName)

  try {
    const inputBytes = Buffer.from(bytesBase64, 'base64')
    await writeFile(inputPath, inputBytes)
    const converted = await convert({ inputPath, outputPath, name, mimeType: sourceMimeType, bytes: inputBytes, support })
    const outputBytes = converted?.bytes || await readFile(outputPath)
    const outputMimeType = String(converted?.mimeType || 'image/jpeg').trim() || 'image/jpeg'
    const finalName = String(converted?.name || outputName).trim() || outputName
    const engine = String(converted?.engine || support.engine || 'unknown').trim() || 'unknown'
    return {
      changed: true,
      name: finalName,
      mimeType: outputMimeType,
      bytesBase64: Buffer.from(outputBytes).toString('base64'),
      normalization: {
        status: 'normalized',
        sourceMimeType,
        outputMimeType,
        via: 'companion',
        engine,
      },
      pipelineHints: buildImagePipelineHints({
        sourceMimeType,
        outputMimeType,
        engine,
        status: 'normalized',
      }),
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
