import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createInMemoryCheckpointJobStateStore,
  createMemoryCheckpointJobRunner,
} from './checkpoint-job-runner.mjs'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createControlledStateStore() {
  let state = { version: 1, jobs: [] }
  let saveCount = 0
  let loadCount = 0
  const loadResolvers = []

  return {
    async load() {
      loadCount += 1
      if (loadCount <= 2) {
        return new Promise((resolve) => {
          loadResolvers.push((snapshot) => resolve(clone(snapshot)))
        })
      }
      return clone(state)
    },
    async save(nextState) {
      saveCount += 1
      state = clone(nextState)
    },
    getLoadCount() {
      return loadCount
    },
    getSaveCount() {
      return saveCount
    },
    getState() {
      return clone(state)
    },
    resolveNextLoad(snapshot = state) {
      const resolve = loadResolvers.shift()
      if (!resolve) {
        throw new Error('load_not_pending')
      }
      resolve(snapshot)
    },
  }
}

function makeCheckpointJobBundle() {
  const generation = '2026-03-12T08-00-00.000Z'
  const committedAt = Date.UTC(2026, 2, 12, 8, 0, 0)
  return {
    generation,
    committedAt,
    coverageDay: '2026-03-12',
    latestPointer: {
      version: 1,
      generation,
      committedAt,
      manifestKey: `memory-checkpoints/generations/${generation}/manifest.json`,
    },
    latestPointerPayload: JSON.stringify({
      version: 1,
      generation,
      committedAt,
    }),
    history: {
      version: 1,
      generation,
      previousGeneration: null,
      coverageDay: '2026-03-12',
      committedAt,
      manifestKey: `memory-checkpoints/generations/${generation}/manifest.json`,
      artifactCount: 0,
      requiredArtifactCount: 0,
      lastHistoryKey: `memory-checkpoints/generations/${generation}/history.json`,
    },
    historyPayload: JSON.stringify({
      version: 1,
      generation,
    }),
    manifest: {
      version: 1,
      generation,
      previousGeneration: null,
      committedAt,
      generatedAt: committedAt,
      artifacts: [],
    },
    manifestPayload: JSON.stringify({
      version: 1,
      generation,
      artifacts: [],
    }),
    artifactPayloads: {},
    localAckPlan: {
      remoteStorageKeys: [],
      generation,
      committedAt,
    },
  }
}

async function waitFor(condition, timeoutMs = 250) {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('wait_timeout')
    }
    await delay(5)
  }
}

test('submit serializes same-generation requests so only one create path persists', async () => {
  const bundle = makeCheckpointJobBundle()
  const stateStore = createControlledStateStore()

  const runner = createMemoryCheckpointJobRunner({
    stateStore,
    now: (() => {
      let current = bundle.committedAt
      return () => current++
    })(),
    runMemoryCheckpointJob: async (job) => {
      return {
        latestPointer: job.publishBundle.latestPointer,
        latestPointerPayload: job.publishBundle.latestPointerPayload,
        history: job.publishBundle.history,
        historyPayload: job.publishBundle.historyPayload,
        manifest: job.publishBundle.manifest,
        manifestPayload: job.publishBundle.manifestPayload,
        localAckPlan: job.publishBundle.localAckPlan,
        verificationStatus: 'verified',
      }
    },
  })

  const firstSubmit = runner.submit({ generation: bundle.generation, publishBundle: bundle })
  const secondSubmit = runner.submit({ generation: bundle.generation, publishBundle: bundle })

  await waitFor(() => stateStore.getLoadCount() >= 1)
  if (stateStore.getLoadCount() >= 2) {
    stateStore.resolveNextLoad({ version: 1, jobs: [] })
    stateStore.resolveNextLoad({ version: 1, jobs: [] })
  } else {
    stateStore.resolveNextLoad({ version: 1, jobs: [] })
    await waitFor(() => stateStore.getLoadCount() >= 2)
    stateStore.resolveNextLoad(stateStore.getState())
  }

  const [first, second] = await Promise.all([firstSubmit, secondSubmit])

  assert.equal(first.job.jobId, second.job.jobId)
  assert.ok(stateStore.getSaveCount() <= 2)
})

test('resumePendingJobs passes persisted completed steps back into the checkpoint executor', async () => {
  const bundle = makeCheckpointJobBundle()
  const stateStore = createInMemoryCheckpointJobStateStore({
    version: 1,
    jobs: [{
      jobId: `checkpoint-${bundle.generation}`,
      generation: bundle.generation,
      state: 'running',
      stage: 'publish_artifacts',
      createdAt: bundle.committedAt,
      updatedAt: bundle.committedAt + 1,
      startedAt: bundle.committedAt + 1,
      finishedAt: null,
      attemptCount: 1,
      error: null,
      completedSteps: ['publish_artifacts'],
      publishBundle: bundle,
      result: null,
    }],
  })

  let seenCompletedSteps = null
  const runner = createMemoryCheckpointJobRunner({
    stateStore,
    now: (() => {
      let current = bundle.committedAt + 10
      return () => current++
    })(),
    runMemoryCheckpointJob: async (job) => {
      seenCompletedSteps = clone(job.resumeState?.completedSteps || [])
      await job.markStepCompleted('write_history')
      return {
        latestPointer: job.publishBundle.latestPointer,
        latestPointerPayload: job.publishBundle.latestPointerPayload,
        history: job.publishBundle.history,
        historyPayload: job.publishBundle.historyPayload,
        manifest: job.publishBundle.manifest,
        manifestPayload: job.publishBundle.manifestPayload,
        localAckPlan: job.publishBundle.localAckPlan,
        verificationStatus: 'verified',
      }
    },
  })

  const [resumed] = await runner.resumePendingJobs()

  assert.deepEqual(seenCompletedSteps, ['publish_artifacts'])
  assert.equal(resumed?.state, 'completed')
  assert.deepEqual(resumed?.completedSteps, ['publish_artifacts', 'write_history'])
})

test('submit persists step progress for status polling before the job completes', async () => {
  const bundle = makeCheckpointJobBundle()
  let releaseJob = null
  let progressReached = null
  const progressPromise = new Promise((resolve) => {
    progressReached = resolve
  })
  const finishPromise = new Promise((resolve) => {
    releaseJob = resolve
  })

  const runner = createMemoryCheckpointJobRunner({
    stateStore: createInMemoryCheckpointJobStateStore(),
    now: (() => {
      let current = bundle.committedAt
      return () => current++
    })(),
    runMemoryCheckpointJob: async (job) => {
      await job.markStepCompleted('publish_artifacts')
      progressReached()
      await finishPromise
      return {
        latestPointer: job.publishBundle.latestPointer,
        latestPointerPayload: job.publishBundle.latestPointerPayload,
        history: job.publishBundle.history,
        historyPayload: job.publishBundle.historyPayload,
        manifest: job.publishBundle.manifest,
        manifestPayload: job.publishBundle.manifestPayload,
        localAckPlan: job.publishBundle.localAckPlan,
        verificationStatus: 'verified',
      }
    },
  })

  const submit = await runner.submit({ generation: bundle.generation, publishBundle: bundle })
  await progressPromise

  const inFlight = await runner.getStatus(submit.job.jobId)
  assert.equal(inFlight?.state, 'running')
  assert.equal(inFlight?.stage, 'publish_artifacts')
  assert.deepEqual(inFlight?.completedSteps, ['publish_artifacts'])

  releaseJob()
  await waitFor(async () => {
    const status = await runner.getStatus(submit.job.jobId)
    return status?.state === 'completed'
  })
})

test('runner keeps active jobs but trims older terminal jobs from persisted state', async () => {
  const bundle = makeCheckpointJobBundle()
  const nowTs = bundle.committedAt
  const terminalJobs = Array.from({ length: 70 }, (_, index) => ({
    jobId: `checkpoint-terminal-${index}`,
    generation: `2026-03-12T08-00-${String(index).padStart(2, '0')}.000Z`,
    state: index % 2 === 0 ? 'completed' : 'failed',
    stage: index % 2 === 0 ? 'completed' : 'failed',
    createdAt: nowTs + index,
    updatedAt: nowTs + index,
    startedAt: nowTs + index,
    finishedAt: nowTs + index + 1,
    attemptCount: 1,
    error: index % 2 === 0 ? null : 'checkpoint_job_failed',
    completedSteps: [],
    publishBundle: {
      ...bundle,
      generation: `2026-03-12T08-00-${String(index).padStart(2, '0')}.000Z`,
    },
    result: index % 2 === 0
      ? {
          latestPointer: bundle.latestPointer,
          latestPointerPayload: bundle.latestPointerPayload,
          history: bundle.history,
          historyPayload: bundle.historyPayload,
          manifest: bundle.manifest,
          manifestPayload: bundle.manifestPayload,
          localAckPlan: bundle.localAckPlan,
          verificationStatus: 'verified',
        }
      : null,
  }))

  const stateStore = createInMemoryCheckpointJobStateStore({
    version: 1,
    jobs: [
      ...terminalJobs,
      {
        jobId: 'checkpoint-running',
        generation: '2026-03-12T09-00-00.000Z',
        state: 'running',
        stage: 'publish_artifacts',
        createdAt: nowTs + 10_000,
        updatedAt: nowTs + 10_001,
        startedAt: nowTs + 10_001,
        finishedAt: null,
        attemptCount: 2,
        error: null,
        completedSteps: ['publish_artifacts'],
        publishBundle: {
          ...bundle,
          generation: '2026-03-12T09-00-00.000Z',
        },
        result: null,
      },
    ],
  })

  const snapshot = await stateStore.load()
  const runner = createMemoryCheckpointJobRunner({
    stateStore,
    runMemoryCheckpointJob: async () => {
      throw new Error('should_not_execute')
    },
  })

  const retainedTerminal = snapshot.jobs.filter((job) => job.state === 'completed' || job.state === 'failed')
  assert.equal(retainedTerminal.length, 64)
  assert.equal(await runner.getStatus('checkpoint-terminal-0'), null)
  assert.ok(await runner.getStatus('checkpoint-terminal-69'))
  assert.equal((await runner.getStatus('checkpoint-running'))?.state, 'running')
})

test('completing a new job also prunes the oldest retained terminal entry', async () => {
  const bundle = makeCheckpointJobBundle()
  const nowTs = bundle.committedAt
  const initialTerminalJobs = Array.from({ length: 64 }, (_, index) => ({
    jobId: `checkpoint-complete-${index}`,
    generation: `2026-03-12T10-00-${String(index).padStart(2, '0')}.000Z`,
    state: 'completed',
    stage: 'completed',
    createdAt: nowTs + index,
    updatedAt: nowTs + index,
    startedAt: nowTs + index,
    finishedAt: nowTs + index + 1,
    attemptCount: 1,
    error: null,
    completedSteps: ['publish_artifacts'],
    publishBundle: {
      ...bundle,
      generation: `2026-03-12T10-00-${String(index).padStart(2, '0')}.000Z`,
    },
    result: {
      latestPointer: bundle.latestPointer,
      latestPointerPayload: bundle.latestPointerPayload,
      history: bundle.history,
      historyPayload: bundle.historyPayload,
      manifest: bundle.manifest,
      manifestPayload: bundle.manifestPayload,
      localAckPlan: bundle.localAckPlan,
      verificationStatus: 'verified',
    },
  }))

  const stateStore = createInMemoryCheckpointJobStateStore({
    version: 1,
    jobs: initialTerminalJobs,
  })

  const runner = createMemoryCheckpointJobRunner({
    stateStore,
    now: (() => {
      let current = nowTs + 100_000
      return () => current++
    })(),
    runMemoryCheckpointJob: async (job) => ({
      latestPointer: job.publishBundle.latestPointer,
      latestPointerPayload: job.publishBundle.latestPointerPayload,
      history: job.publishBundle.history,
      historyPayload: job.publishBundle.historyPayload,
      manifest: job.publishBundle.manifest,
      manifestPayload: job.publishBundle.manifestPayload,
      localAckPlan: job.publishBundle.localAckPlan,
      verificationStatus: 'verified',
    }),
  })

  await runner.submit({
    generation: '2026-03-12T11-00-00.000Z',
    publishBundle: {
      ...bundle,
      generation: '2026-03-12T11-00-00.000Z',
    },
  })
  await waitFor(async () => (await runner.getStatus('checkpoint-2026-03-12T11-00-00.000Z'))?.state === 'completed')

  const snapshot = await stateStore.load()
  const retainedTerminal = snapshot.jobs.filter((job) => job.state === 'completed' || job.state === 'failed')

  assert.equal(retainedTerminal.length, 64)
  assert.equal(await runner.getStatus('checkpoint-complete-0'), null)
  assert.equal((await runner.getStatus('checkpoint-2026-03-12T11-00-00.000Z'))?.state, 'completed')
})
