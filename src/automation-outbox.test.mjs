import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'

let sharedPromise = null

async function getSharedModules() {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-outbox-'))
      process.once('exit', () => {
        rmSync(tempDir, { recursive: true, force: true })
      })
      process.env.TRAPEZOHE_CONFIG_DIR = tempDir
      const outbox = await import('./automation-outbox.mjs')
      return { outbox }
    })()
  }
  return sharedPromise
}

async function withFreshStore(run) {
  const { outbox } = await getSharedModules()
  await outbox.clearAutomationOutboxForTests()
  await run(outbox)
}

test('automation outbox stores stable delivery items and lists them newest-first', async () => {
  await withFreshStore(async (outbox) => {
    const first = await outbox.enqueueAutomationOutboxItem({
      id: 'outbox-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskName: 'Daily brief',
      mode: 'chat',
      text: 'Daily brief ready',
      target: null,
      createdAt: 10,
    })
    const second = await outbox.enqueueAutomationOutboxItem({
      id: 'outbox-2',
      runId: 'run-2',
      taskId: 'task-2',
      taskName: 'Slack alert',
      mode: 'remote_channel',
      text: 'Slack alert ready',
      target: { channelId: 'slack', bindingKey: 'room-1' },
      createdAt: 20,
    })

    assert.equal(first.id, 'outbox-1')
    assert.equal(second.id, 'outbox-2')

    const listed = await outbox.listAutomationOutboxItems()
    assert.deepEqual(listed.items.map((item) => item.id), ['outbox-2', 'outbox-1'])
    assert.deepEqual(listed.items[0].target, { channelId: 'slack', bindingKey: 'room-1' })
  })
})

test('automation outbox ack is idempotent and removes only acknowledged items', async () => {
  await withFreshStore(async (outbox) => {
    await outbox.enqueueAutomationOutboxItem({
      id: 'outbox-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskName: 'Daily brief',
      mode: 'chat',
      text: 'Daily brief ready',
      target: null,
      createdAt: 10,
    })
    await outbox.enqueueAutomationOutboxItem({
      id: 'outbox-2',
      runId: 'run-2',
      taskId: 'task-2',
      taskName: 'Slack alert',
      mode: 'remote_channel',
      text: 'Slack alert ready',
      target: { channelId: 'slack', bindingKey: 'room-1' },
      createdAt: 20,
    })

    const firstAck = await outbox.ackAutomationOutboxItems(['outbox-2'])
    assert.equal(firstAck.acked, 1)

    const secondAck = await outbox.ackAutomationOutboxItems(['outbox-2', 'missing'])
    assert.equal(secondAck.acked, 0)

    const listed = await outbox.listAutomationOutboxItems()
    assert.deepEqual(listed.items.map((item) => item.id), ['outbox-1'])
  })
})

test('automation outbox serializes concurrent enqueue writes without losing items', async () => {
  await withFreshStore(async (outbox) => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => outbox.enqueueAutomationOutboxItem({
        id: `outbox-${index}`,
        runId: `run-${index}`,
        taskId: `task-${index}`,
        taskName: `Task ${index}`,
        mode: 'chat',
        text: `Delivery ${index}`,
        target: null,
        createdAt: index + 1,
      })),
    )

    await outbox.loadAutomationOutboxStore()
    const listed = await outbox.listAutomationOutboxItems()
    assert.equal(listed.total, 8)
    assert.deepEqual(
      listed.items.map((item) => item.id),
      ['outbox-7', 'outbox-6', 'outbox-5', 'outbox-4', 'outbox-3', 'outbox-2', 'outbox-1', 'outbox-0'],
    )
  })
})
