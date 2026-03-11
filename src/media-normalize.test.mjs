import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeImagePayload, shouldNormalizeMimeType } from './media-normalize.mjs'

test('shouldNormalizeMimeType flags heic/heif and skips other image types', () => {
  assert.equal(shouldNormalizeMimeType('image/heic'), true)
  assert.equal(shouldNormalizeMimeType('image/heif'), true)
  assert.equal(shouldNormalizeMimeType('image/jpeg'), false)
  assert.equal(shouldNormalizeMimeType('', 'photo.heic'), true)
  assert.equal(shouldNormalizeMimeType('image/jpeg', 'renamed.heic'), false)
})

test('normalizeImagePayload rewrites heic/heif payloads to jpeg via converter', async () => {
  const payload = await normalizeImagePayload({
    name: 'photo.heic',
    mimeType: 'image/heic',
    bytesBase64: Buffer.from('heic-binary').toString('base64'),
  }, {
    convert: async (input) => ({
      bytes: Buffer.from('jpeg-binary'),
      mimeType: 'image/jpeg',
      name: input.name.replace(/\.heic$/i, '.jpg'),
      engine: 'test-engine',
    }),
  })

  assert.equal(payload.changed, true)
  assert.equal(payload.mimeType, 'image/jpeg')
  assert.equal(payload.name, 'photo.jpg')
  assert.equal(Buffer.from(payload.bytesBase64, 'base64').toString(), 'jpeg-binary')
  assert.deepEqual(payload.normalization, {
    status: 'normalized',
    sourceMimeType: 'image/heic',
    outputMimeType: 'image/jpeg',
    via: 'companion',
    engine: 'test-engine',
  })
  assert.deepEqual(payload.pipelineHints, {
    source: 'image',
    summary: 'Image normalized from image/heic to image/jpeg via test-engine. OCR hook not enabled yet.',
    ocrReady: false,
  })
})

test('normalizeImagePayload leaves non-heic payloads unchanged', async () => {
  const payload = await normalizeImagePayload({
    name: 'photo.png',
    mimeType: 'image/png',
    bytesBase64: Buffer.from('png-binary').toString('base64'),
  })

  assert.equal(payload.changed, false)
  assert.equal(payload.mimeType, 'image/png')
  assert.equal(payload.name, 'photo.png')
  assert.equal(Buffer.from(payload.bytesBase64, 'base64').toString(), 'png-binary')
  assert.deepEqual(payload.normalization, {
    status: 'unchanged',
    sourceMimeType: 'image/png',
    outputMimeType: 'image/png',
    via: 'none',
  })
  assert.deepEqual(payload.pipelineHints, {
    source: 'image',
    summary: 'Image retained as image/png. OCR hook not enabled yet.',
    ocrReady: false,
  })
})

test('normalizeImagePayload honors heic file extensions when mime is generic', async () => {
  const payload = await normalizeImagePayload({
    name: 'camera-roll.heic',
    mimeType: 'application/octet-stream',
    bytesBase64: Buffer.from('heic-binary').toString('base64'),
  }, {
    convert: async () => ({
      bytes: Buffer.from('jpeg-binary'),
      mimeType: 'image/jpeg',
      name: 'camera-roll.jpg',
      engine: 'test-engine',
    }),
  })

  assert.equal(payload.changed, true)
  assert.equal(payload.name, 'camera-roll.jpg')
  assert.equal(payload.mimeType, 'image/jpeg')
  assert.equal(payload.normalization.sourceMimeType, 'image/heic')
  assert.match(payload.pipelineHints.summary, /image\/heic/)
})

test('normalizeImagePayload does not let filename fallback override an explicit MIME type', async () => {
  const payload = await normalizeImagePayload({
    name: 'renamed.heic',
    mimeType: 'image/jpeg',
    bytesBase64: Buffer.from('jpeg-binary').toString('base64'),
  })

  assert.equal(payload.changed, false)
  assert.equal(payload.mimeType, 'image/jpeg')
  assert.equal(payload.normalization.sourceMimeType, 'image/jpeg')
})

test('normalizeImagePayload reports failure hints truthfully when HEIC conversion is unavailable', async () => {
  const payload = await normalizeImagePayload({
    name: 'photo.heic',
    mimeType: 'image/heic',
    bytesBase64: Buffer.from('heic-binary').toString('base64'),
  }, {
    support: { available: false, engine: null, reason: 'no_supported_image_converter' },
  })

  assert.equal(payload.changed, false)
  assert.deepEqual(payload.normalization, {
    status: 'failed',
    sourceMimeType: 'image/heic',
    outputMimeType: 'image/heic',
    via: 'companion',
    note: 'no_supported_image_converter',
  })
  assert.deepEqual(payload.pipelineHints, {
    source: 'image',
    summary: 'Image normalization failed (no_supported_image_converter); retained as image/heic. OCR hook not enabled yet.',
    ocrReady: false,
  })
})
