import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

import { createFileBackedStore } from './file-backed-store.mjs'

function createTracingFs() {
  const operations = []
  return {
    operations,
    async readFile(filePath, encoding) {
      operations.push({ type: 'readFile', filePath })
      return fs.readFile(filePath, encoding)
    },
    async writeFile(filePath, data, options) {
      operations.push({ type: 'writeFile', filePath })
      return fs.writeFile(filePath, data, options)
    },
    async copyFile(source, destination) {
      operations.push({ type: 'copyFile', source, destination })
      return fs.copyFile(source, destination)
    },
    async rename(source, destination) {
      operations.push({ type: 'rename', source, destination })
      return fs.rename(source, destination)
    },
    async unlink(filePath) {
      operations.push({ type: 'unlink', filePath })
      return fs.unlink(filePath)
    },
    async chmod(filePath, mode) {
      operations.push({ type: 'chmod', filePath, mode })
      return fs.chmod(filePath, mode)
    },
  }
}

async function withTempStore(t, options, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trapezohe-file-backed-store-'))
  const primaryPath = path.join(dir, 'store.json')
  const backupPath = path.join(dir, 'store.json.bak')
  const tmpPath = path.join(dir, 'store.json.tmp')
  const tracingFs = createTracingFs()
  let serializeCount = 0

  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const store = createFileBackedStore({
    label: 'file-backed-store-test',
    fs: tracingFs,
    primaryPath,
    backupPath: options.useBackup === false ? null : backupPath,
    tmpPath,
    debounceMs: options.debounceMs || 0,
    fileMode: 0o600,
    ensureDir: async () => {
      await fs.mkdir(dir, { recursive: true })
    },
    fallbackState: { items: [] },
    parse: JSON.parse,
    normalize: (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : { items: [] }),
    serialize: (value) => {
      serializeCount += 1
      return `${JSON.stringify(value, null, 2)}\n`
    },
    logger: {
      warn: () => {},
      error: () => {},
    },
  })

  await run({
    dir,
    store,
    tracingFs,
    primaryPath,
    backupPath,
    tmpPath,
    getSerializeCount: () => serializeCount,
  })
}

test('file-backed store persists atomically through a tmp file and rename', async (t) => {
  await withTempStore(t, {}, async ({ store, tracingFs, primaryPath, tmpPath }) => {
    await store.persistSnapshot({ items: ['alpha'] })

    const persisted = JSON.parse(await fs.readFile(primaryPath, 'utf8'))
    assert.deepEqual(persisted, { items: ['alpha'] })
    await assert.rejects(fs.access(tmpPath))

    assert.deepEqual(
      tracingFs.operations
        .filter((operation) => operation.type === 'writeFile' || operation.type === 'rename')
        .map((operation) => [operation.type, operation.filePath || operation.source, operation.destination || null]),
      [
        ['writeFile', tmpPath, null],
        ['rename', tmpPath, primaryPath],
      ],
    )
  })
})

test('file-backed store creates a backup from the previous primary snapshot on overwrite', async (t) => {
  await withTempStore(t, {}, async ({ store, primaryPath, backupPath }) => {
    await store.persistSnapshot({ items: ['first'] })
    await store.persistSnapshot({ items: ['second'] })

    const primary = JSON.parse(await fs.readFile(primaryPath, 'utf8'))
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'))

    assert.deepEqual(primary, { items: ['second'] })
    assert.deepEqual(backup, { items: ['first'] })
  })
})

test('file-backed store debounces scheduled writes and flush persists the latest snapshot once', async (t) => {
  await withTempStore(t, { debounceMs: 40 }, async ({ store, primaryPath, getSerializeCount }) => {
    let state = { items: ['alpha'] }

    store.schedulePersist(() => state)
    state = { items: ['alpha', 'beta'] }
    store.schedulePersist(() => state)

    await new Promise((resolve) => setTimeout(resolve, 10))
    await assert.rejects(fs.access(primaryPath))
    assert.equal(getSerializeCount(), 0)

    await store.flush()

    const persisted = JSON.parse(await fs.readFile(primaryPath, 'utf8'))
    assert.deepEqual(persisted, { items: ['alpha', 'beta'] })
    assert.equal(getSerializeCount(), 1)
  })
})

test('file-backed store cleans orphan tmp files on load and keeps the primary snapshot', async (t) => {
  await withTempStore(t, {}, async ({ store, primaryPath, tmpPath }) => {
    await fs.writeFile(primaryPath, '{"items":["primary"]}\n', 'utf8')
    await fs.writeFile(tmpPath, '{"items":["stale-tmp"]}\n', 'utf8')

    const loaded = await store.load()

    assert.deepEqual(loaded.state, { items: ['primary'] })
    assert.equal(loaded.recoveredFromBackup, false)
    await assert.rejects(fs.access(tmpPath))
  })
})

test('file-backed store recovers from backup when the primary file is corrupted', async (t) => {
  await withTempStore(t, {}, async ({ store, primaryPath, backupPath }) => {
    await fs.writeFile(primaryPath, '{ invalid json', 'utf8')
    await fs.writeFile(backupPath, '{"items":["backup"]}\n', 'utf8')

    const loaded = await store.load()

    assert.deepEqual(loaded.state, { items: ['backup'] })
    assert.equal(loaded.recoveredFromBackup, true)
  })
})

test('file-backed store can replace the primary snapshot without leaving a stale backup behind', async (t) => {
  await withTempStore(t, {}, async ({ store, primaryPath, backupPath }) => {
    await store.persistSnapshot({ items: ['first'] })
    await store.persistSnapshot({ items: ['second'] })

    assert.deepEqual(JSON.parse(await fs.readFile(backupPath, 'utf8')), { items: ['first'] })

    await store.replaceSnapshot({ items: [] })

    assert.deepEqual(JSON.parse(await fs.readFile(primaryPath, 'utf8')), { items: [] })
    await assert.rejects(fs.access(backupPath))
  })
})
