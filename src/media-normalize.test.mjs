import test from "node:test"
import assert from "node:assert/strict"

import { normalizeImagePayload, shouldNormalizeMimeType } from "./media-normalize.mjs"

test("shouldNormalizeMimeType flags heic/heif and skips other image types", () => {
  assert.equal(shouldNormalizeMimeType("image/heic"), true)
  assert.equal(shouldNormalizeMimeType("image/heif"), true)
  assert.equal(shouldNormalizeMimeType("image/jpeg"), false)
})

test("normalizeImagePayload rewrites heic/heif payloads to jpeg via converter", async () => {
  const payload = await normalizeImagePayload({
    name: "photo.heic",
    mimeType: "image/heic",
    bytesBase64: Buffer.from("heic-binary").toString("base64"),
  }, {
    convert: async (input) => ({
      bytes: Buffer.from("jpeg-binary"),
      mimeType: "image/jpeg",
      name: input.name.replace(/\.heic$/i, ".jpg"),
      engine: "test-engine",
    }),
  })

  assert.equal(payload.changed, true)
  assert.equal(payload.mimeType, "image/jpeg")
  assert.equal(payload.name, "photo.jpg")
  assert.equal(Buffer.from(payload.bytesBase64, "base64").toString(), "jpeg-binary")
  assert.deepEqual(payload.normalization, {
    status: "normalized",
    sourceMimeType: "image/heic",
    outputMimeType: "image/jpeg",
    via: "companion",
    engine: "test-engine",
  })
})

test("normalizeImagePayload leaves non-heic payloads unchanged", async () => {
  const payload = await normalizeImagePayload({
    name: "photo.png",
    mimeType: "image/png",
    bytesBase64: Buffer.from("png-binary").toString("base64"),
  })

  assert.equal(payload.changed, false)
  assert.equal(payload.mimeType, "image/png")
  assert.equal(payload.name, "photo.png")
  assert.equal(Buffer.from(payload.bytesBase64, "base64").toString(), "png-binary")
  assert.deepEqual(payload.normalization, {
    status: "unchanged",
    sourceMimeType: "image/png",
    outputMimeType: "image/png",
    via: "none",
  })
})
