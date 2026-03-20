import path from 'node:path'

import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'

const FILE_MODE = 0o600
const DEFAULT_STATE_VERSION = 1
const MAX_PERSISTED_TERMINAL_JOBS = 64

function CHECKPOINT_JOBS_FILE() {
  return path.join(getConfigDir(), 'checkpoint-jobs.json')
}

function CHECKPOINT_JOBS_BACKUP_FILE() {
  return path.join(getConfigDir(), 'checkpoint-jobs.json.bak')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function asString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function asTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.floor(numeric)
}

function normalizeJobState(value) {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed'
    ? value
    : 'queued'
}

function normalizeJobStage(value) {
  const stage = asString(value)
  return stage || 'queued'
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item))
    .filter(Boolean)
}

function normalizeLocalAckPlan(value) {
  const record = asRecord(value)
  const generation = asString(record?.generation)
  const committedAt = asTimestamp(record?.committedAt)
  if (!generation || committedAt === null) return null
  return {
    generation,
    committedAt,
    remoteStorageKeys: normalizeStringArray(record?.remoteStorageKeys),
  }
}

function normalizeJobResult(value) {
  const record = asRecord(value)
  if (!record) return null
  const localAckPlan = normalizeLocalAckPlan(record.localAckPlan)
  if (!localAckPlan) return null
  const verificationStatus = asString(record.verificationStatus) || 'unknown'
  return {
    ...clone(record),
    localAckPlan,
    verificationStatus,
    ...(typeof record.verificationError === 'string' && record.verificationError.trim()
      ? { verificationError: record.verificationError.trim() }
      : {}),
  }
}

function normalizePublishBundle(value) {
  const record = asRecord(value)
  const generation = asString(record?.generation)
  if (!record || !generation) return null
  return clone(record)
}

function normalizePersistedJob(value) {
  const record = asRecord(value)
  const jobId = asString(record?.jobId)
  const generation = asString(record?.generation)
  const createdAt = asTimestamp(record?.createdAt)
  const updatedAt = asTimestamp(record?.updatedAt)
  const publishBundle = normalizePublishBundle(record?.publishBundle)
  if (!jobId || !generation || createdAt === null || updatedAt === null || !publishBundle) {
    return null
  }
  return {
    jobId,
    generation,
    state: normalizeJobState(record.state),
    stage: normalizeJobStage(record.stage),
    createdAt,
    updatedAt,
    startedAt: asTimestamp(record.startedAt),
    finishedAt: asTimestamp(record.finishedAt),
    attemptCount: Math.max(0, Math.floor(Number(record.attemptCount) || 0)),
    error: asString(record.error),
    completedSteps: normalizeStringArray(record.completedSteps),
    publishBundle,
    result: normalizeJobResult(record.result),
  }
}

function normalizePersistedState(input) {
  const record = asRecord(input)
  const jobs = Array.isArray(record?.jobs)
    ? record.jobs.map((job) => normalizePersistedJob(job)).filter(Boolean)
    : []
  const activeJobs = jobs.filter((job) => job.state === 'queued' || job.state === 'running')
  const retainedTerminalJobs = jobs
    .filter((job) => job.state === 'completed' || job.state === 'failed')
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
      if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
      return right.jobId.localeCompare(left.jobId)
    })
    .slice(0, MAX_PERSISTED_TERMINAL_JOBS)
  const normalizedJobs = [...activeJobs, ...retainedTerminalJobs]
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
      if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
      return right.jobId.localeCompare(left.jobId)
    })
  return {
    version: DEFAULT_STATE_VERSION,
    jobs: normalizedJobs,
  }
}

function buildInitialState() {
  return normalizePersistedState({})
}

const checkpointJobStorage = createFileBackedStore({
  label: 'checkpoint-jobs',
  primaryPath: CHECKPOINT_JOBS_FILE,
  backupPath: CHECKPOINT_JOBS_BACKUP_FILE,
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: buildInitialState,
  parse: (raw) => normalizePersistedState(JSON.parse(raw)),
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
})

export function createInMemoryCheckpointJobStateStore(initialState = null) {
  let state = normalizePersistedState(initialState || {})
  return {
    async load() {
      return clone(state)
    },
    async save(nextState) {
      state = normalizePersistedState(nextState)
    },
  }
}

export function createFileBackedCheckpointJobStateStore() {
  let cachedState = null
  return {
    async load() {
      if (cachedState !== null) return clone(cachedState)
      const result = await checkpointJobStorage.load()
      cachedState = result.state ?? buildInitialState()
      return clone(cachedState)
    },
    async save(nextState) {
      cachedState = normalizePersistedState(nextState)
      await checkpointJobStorage.persistSnapshot(cachedState)
    },
  }
}

export async function clearCheckpointJobStoreForTests() {
  checkpointJobStorage.reset()
  await checkpointJobStorage.replaceSnapshot(buildInitialState())
}

function buildJobId(generation) {
  return `checkpoint-${generation}`
}

function buildJobSummary(job) {
  return {
    jobId: job.jobId,
    generation: job.generation,
    state: job.state,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    attemptCount: job.attemptCount,
    completedSteps: clone(job.completedSteps || []),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.result ? { result: clone(job.result) } : {}),
  }
}

function findJobIndexById(state, jobId) {
  return state.jobs.findIndex((job) => job.jobId === jobId)
}

function findJobByGeneration(state, generation) {
  return state.jobs.find((job) => job.generation === generation) || null
}

export function createMemoryCheckpointJobRunner({
  runMemoryCheckpointJob,
  now = () => Date.now(),
  stateStore = createFileBackedCheckpointJobStateStore(),
}) {
  const available = typeof runMemoryCheckpointJob === 'function'
  const runningJobs = new Map()
  const submitLocks = new Map()

  async function loadState() {
    return normalizePersistedState(await stateStore.load())
  }

  async function saveState(state) {
    await stateStore.save(normalizePersistedState(state))
  }

  async function getJob(jobId) {
    const state = await loadState()
    const job = state.jobs.find((entry) => entry.jobId === jobId)
    return job ? buildJobSummary(job) : null
  }

  async function persistJob(nextJob) {
    const state = await loadState()
    const index = findJobIndexById(state, nextJob.jobId)
    if (index >= 0) {
      state.jobs[index] = normalizePersistedJob(nextJob)
    } else {
      state.jobs.push(normalizePersistedJob(nextJob))
    }
    await saveState(state)
    return buildJobSummary(state.jobs[index >= 0 ? index : state.jobs.length - 1])
  }

  async function withSubmitLock(generation, task) {
    const previous = submitLocks.get(generation) || Promise.resolve()
    let release = () => {}
    const current = new Promise((resolve) => {
      release = resolve
    })
    submitLocks.set(generation, current)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (submitLocks.get(generation) === current) {
        submitLocks.delete(generation)
      }
    }
  }

  async function executeJob(jobId) {
    if (!available) return null
    if (runningJobs.has(jobId)) return runningJobs.get(jobId)

    const task = (async () => {
      const state = await loadState()
      const index = findJobIndexById(state, jobId)
      if (index < 0) return null
      const current = state.jobs[index]
      if (current.state === 'completed') return buildJobSummary(current)

      const startedAt = current.startedAt || now()
      const completedSteps = normalizeStringArray(current.completedSteps)
      state.jobs[index] = {
        ...current,
        state: 'running',
        stage: completedSteps.length > 0 && current.stage !== 'queued' ? current.stage : 'running',
        startedAt,
        updatedAt: now(),
        attemptCount: (current.attemptCount || 0) + 1,
        error: null,
        completedSteps,
      }
      await saveState(state)

      const markStepCompleted = async (step) => {
        const normalizedStep = asString(step)
        if (!normalizedStep) {
          throw new Error('checkpoint_job_step_invalid')
        }
        const progressState = await loadState()
        const progressIndex = findJobIndexById(progressState, jobId)
        if (progressIndex < 0) return null
        const progressJob = progressState.jobs[progressIndex]
        const nextCompletedSteps = normalizeStringArray(progressJob.completedSteps)
        if (!nextCompletedSteps.includes(normalizedStep)) {
          nextCompletedSteps.push(normalizedStep)
        }
        progressState.jobs[progressIndex] = {
          ...progressJob,
          state: 'running',
          stage: normalizedStep,
          updatedAt: now(),
          completedSteps: nextCompletedSteps,
        }
        await saveState(progressState)
        return buildJobSummary(progressState.jobs[progressIndex])
      }

      try {
        const result = normalizeJobResult(await runMemoryCheckpointJob({
          jobId: current.jobId,
          generation: current.generation,
          publishBundle: clone(current.publishBundle),
          attemptCount: (current.attemptCount || 0) + 1,
          resumeState: {
            completedSteps: clone(completedSteps),
          },
          markStepCompleted,
        }))
        if (!result) {
          throw new Error('checkpoint_job_result_invalid')
        }
        const nextState = await loadState()
        const nextIndex = findJobIndexById(nextState, jobId)
        if (nextIndex < 0) return null
        const finalCompletedSteps = normalizeStringArray(nextState.jobs[nextIndex].completedSteps)
        nextState.jobs[nextIndex] = {
          ...nextState.jobs[nextIndex],
          state: 'completed',
          stage: 'completed',
          updatedAt: now(),
          finishedAt: now(),
          error: null,
          completedSteps: finalCompletedSteps,
          result,
        }
        await saveState(nextState)
        return buildJobSummary(nextState.jobs[nextIndex])
      } catch (error) {
        const nextState = await loadState()
        const nextIndex = findJobIndexById(nextState, jobId)
        if (nextIndex < 0) return null
        nextState.jobs[nextIndex] = {
          ...nextState.jobs[nextIndex],
          state: 'failed',
          stage: 'failed',
          updatedAt: now(),
          finishedAt: now(),
          error: error instanceof Error ? error.message : String(error || 'checkpoint_job_failed'),
          completedSteps: normalizeStringArray(nextState.jobs[nextIndex].completedSteps),
        }
        await saveState(nextState)
        return buildJobSummary(nextState.jobs[nextIndex])
      }
    })().finally(() => {
      runningJobs.delete(jobId)
    })

    runningJobs.set(jobId, task)
    return task
  }

  return {
    isAvailable() {
      return available
    },
    async submit(input) {
      if (!available) {
        throw new Error('memory_checkpoint_jobs_unavailable')
      }
      const record = asRecord(input)
      const generation = asString(record?.generation)
      const publishBundle = normalizePublishBundle(record?.publishBundle)
      if (!generation || !publishBundle) {
        throw new Error('checkpoint_job_invalid_request')
      }
      if (publishBundle.generation !== generation) {
        throw new Error('checkpoint_job_generation_mismatch')
      }
      return withSubmitLock(generation, async () => {
        const state = await loadState()
        const existing = findJobByGeneration(state, generation)
        if (existing) {
          if (existing.state === 'queued' || existing.state === 'running') {
            void executeJob(existing.jobId).catch(() => undefined)
          }
          return {
            ok: true,
            accepted: existing.state === 'queued',
            job: buildJobSummary(existing),
          }
        }

        const createdAt = now()
        const job = {
          jobId: buildJobId(generation),
          generation,
          state: 'queued',
          stage: 'queued',
          createdAt,
          updatedAt: createdAt,
          startedAt: null,
          finishedAt: null,
          attemptCount: 0,
          error: null,
          completedSteps: [],
          publishBundle,
          result: null,
        }
        state.jobs.push(job)
        await saveState(state)
        void executeJob(job.jobId).catch(() => undefined)
        return {
          ok: true,
          accepted: true,
          job: buildJobSummary(job),
        }
      })
    },
    async getStatus(jobId) {
      const normalizedJobId = asString(jobId)
      if (!normalizedJobId) return null
      return getJob(normalizedJobId)
    },
    async resumePendingJobs() {
      if (!available) return []
      const state = await loadState()
      const resumable = state.jobs
        .filter((job) => job.state === 'queued' || job.state === 'running')
        .map((job) => job.jobId)
      return Promise.all(resumable.map((jobId) => executeJob(jobId)))
    },
  }
}
