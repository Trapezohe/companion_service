import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { StdioTransport } from './mcp-transport.mjs'

function createFakeProc() {
  const stdout = new EventEmitter()
  stdout.setEncoding = () => {}

  const stderr = new EventEmitter()
  stderr.setEncoding = () => {}

  const stdin = {
    writes: [],
    write(chunk) {
      this.writes.push(chunk)
      return true
    },
    end() {},
  }

  return {
    stdout,
    stderr,
    stdin,
    on() {},
    once() {},
    kill() {},
  }
}

test('transport uses explicit requestTimeoutMs override', () => {
  const transport = new StdioTransport(createFakeProc(), { requestTimeoutMs: 120_000 })
  assert.equal(transport.requestTimeoutMs, 120_000)
})

test('transport falls back to env-driven request timeout when override is omitted', () => {
  const previous = process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS
  process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS = '45000'

  try {
    const transport = new StdioTransport(createFakeProc())
    assert.equal(transport.requestTimeoutMs, 45_000)
  } finally {
    if (previous === undefined) delete process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS
    else process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS = previous
  }
})

test('transport request rejects using the configured timeout budget', async () => {
  const transport = new StdioTransport(createFakeProc(), { requestTimeoutMs: 25 })

  await assert.rejects(
    () => transport.request('tools/list', {}),
    /timed out after 25ms: tools\/list/i,
  )
})
