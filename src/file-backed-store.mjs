import { promises as fs } from 'node:fs'

function cloneValue(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function resolveOption(value) {
  return typeof value === 'function' ? value() : value
}

async function safeChmod(fsImpl, target, mode) {
  if (!target || typeof fsImpl?.chmod !== 'function') return
  try {
    await fsImpl.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL' || err.code === 'ENOENT') return
    throw err
  }
}

function toSnapshotSource(snapshotOrGetter) {
  if (typeof snapshotOrGetter === 'function') return snapshotOrGetter
  return () => snapshotOrGetter
}

export function createFileBackedStore(options = {}) {
  const fsImpl = options.fs || fs
  const label = String(options.label || 'file-backed-store')
  const debounceMs = Math.max(0, Number(options.debounceMs) || 0)
  const fileMode = Number.isInteger(options.fileMode) ? options.fileMode : 0o600
  const ensureDir = typeof options.ensureDir === 'function' ? options.ensureDir : async () => {}
  const parse = typeof options.parse === 'function' ? options.parse : JSON.parse
  const normalize = typeof options.normalize === 'function' ? options.normalize : (value) => value
  const serialize = typeof options.serialize === 'function'
    ? options.serialize
    : (value) => `${JSON.stringify(value, null, 2)}\n`
  const logger = options.logger && typeof options.logger === 'object' ? options.logger : console
  const messages = options.messages && typeof options.messages === 'object' ? options.messages : {}
  const fallbackState = Object.prototype.hasOwnProperty.call(options, 'fallbackState')
    ? options.fallbackState
    : null

  let persistTimer = null
  let persistPromise = null
  let scheduledSnapshotSource = null

  function buildFallbackState() {
    const value = typeof fallbackState === 'function' ? fallbackState() : fallbackState
    return cloneValue(value)
  }

  function primaryPath() {
    return resolveOption(options.primaryPath)
  }

  function backupPath() {
    return resolveOption(options.backupPath)
  }

  function tmpPath() {
    const explicit = resolveOption(options.tmpPath)
    if (explicit) return explicit
    const primary = primaryPath()
    return primary ? `${primary}.tmp` : null
  }

  function logWarn(kind, error) {
    const formatter = messages[kind]
    const message = typeof formatter === 'function' ? formatter(error) : formatter
    if (message === null || message === undefined || message === '') return
    if (typeof logger.warn === 'function') logger.warn(`[${label}] ${message}`)
  }

  async function removeFileIfPresent(filePath) {
    if (!filePath) return
    try {
      await fsImpl.unlink(filePath)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  function queuePersist(snapshotOrGetter, persistOptions = {}) {
    const snapshotSource = toSnapshotSource(snapshotOrGetter)
    const replace = persistOptions?.replace === true
    persistPromise = (persistPromise || Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const snapshot = await snapshotSource()
        await ensureDir()
        const target = primaryPath()
        const backup = backupPath()
        const tmp = tmpPath()
        const payload = await serialize(snapshot)

        await fsImpl.writeFile(tmp, payload, { encoding: 'utf8', mode: fileMode })
        await safeChmod(fsImpl, tmp, fileMode)

        if (replace) {
          await removeFileIfPresent(backup)
        } else if (backup) {
          try {
            await fsImpl.copyFile(target, backup)
            await safeChmod(fsImpl, backup, fileMode)
          } catch (err) {
            if (err.code !== 'ENOENT') throw err
          }
        }

        try {
          await fsImpl.rename(tmp, target)
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
          await fsImpl.writeFile(tmp, payload, { encoding: 'utf8', mode: fileMode })
          await safeChmod(fsImpl, tmp, fileMode)
          await fsImpl.rename(tmp, target)
        }
        await safeChmod(fsImpl, target, fileMode)
      })
    return persistPromise
  }

  function replaceSnapshot(snapshotOrGetter) {
    return queuePersist(snapshotOrGetter, { replace: true })
  }

  function schedulePersist(snapshotOrGetter) {
    scheduledSnapshotSource = toSnapshotSource(snapshotOrGetter)
    if (persistTimer) return

    if (debounceMs <= 0) {
      const nextSource = scheduledSnapshotSource
      scheduledSnapshotSource = null
      void queuePersist(nextSource).catch((error) => {
        if (typeof logger.error === 'function') {
          logger.error(`[${label}] Persist failed: ${error.message}`)
        }
      })
      return
    }

    persistTimer = setTimeout(() => {
      persistTimer = null
      const nextSource = scheduledSnapshotSource
      scheduledSnapshotSource = null
      if (!nextSource) return
      void queuePersist(nextSource).catch((error) => {
        if (typeof logger.error === 'function') {
          logger.error(`[${label}] Persist failed: ${error.message}`)
        }
      })
    }, debounceMs)

    if (typeof persistTimer.unref === 'function') {
      persistTimer.unref()
    }
  }

  async function flush(snapshotOrGetter) {
    if (snapshotOrGetter !== undefined) {
      scheduledSnapshotSource = toSnapshotSource(snapshotOrGetter)
    }

    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
      const nextSource = scheduledSnapshotSource
      scheduledSnapshotSource = null
      if (nextSource) {
        queuePersist(nextSource)
      }
    } else if (scheduledSnapshotSource) {
      const nextSource = scheduledSnapshotSource
      scheduledSnapshotSource = null
      queuePersist(nextSource)
    }

    if (persistPromise) {
      await persistPromise
    }
  }

  async function load() {
    await ensureDir()
    const tmp = tmpPath()
    if (tmp) {
      try {
        await fsImpl.unlink(tmp)
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logWarn('tmpCleanup', err)
        }
      }
    }

    const readState = async (filePath) => {
      const raw = await fsImpl.readFile(filePath, 'utf8')
      return normalize(await parse(raw))
    }

    try {
      return {
        state: await readState(primaryPath()),
        recoveredFromBackup: false,
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          state: buildFallbackState(),
          recoveredFromBackup: false,
        }
      }

      logWarn('primaryCorrupted', err)
      const backup = backupPath()
      if (backup) {
        try {
          const state = await readState(backup)
          logWarn('backupRecovered')
          return {
            state,
            recoveredFromBackup: true,
          }
        } catch (backupErr) {
          logWarn('backupUnavailable', backupErr)
        }
      }

      return {
        state: buildFallbackState(),
        recoveredFromBackup: false,
      }
    }
  }

  function reset() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    scheduledSnapshotSource = null
    persistPromise = null
  }

  return {
    load,
    persistSnapshot: queuePersist,
    replaceSnapshot,
    schedulePersist,
    flush,
    reset,
  }
}
