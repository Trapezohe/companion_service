import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCondition,
  CONDITION_TYPES,
} from './automation-condition-engine.mjs'

test('evaluateCondition returns met:false for unknown condition type', async () => {
  const result = await evaluateCondition({ type: 'unknown_type', params: {} })
  assert.equal(result.met, false)
  assert.equal(result.error, 'Unknown condition type: unknown_type')
})

test('evaluateCondition token_price_change returns met:true when threshold exceeded', async () => {
  const mockFetcher = async () => ({ price: 100, previousPrice: 110 })
  const result = await evaluateCondition(
    { type: 'token_price_change', params: { tokenId: 'ethereum', changePercent: -5 } },
    { priceFetcher: mockFetcher },
  )
  assert.equal(result.met, true)
  assert.ok(result.value !== undefined)
})

test('evaluateCondition token_price_change returns met:false when threshold not exceeded', async () => {
  const mockFetcher = async () => ({ price: 108, previousPrice: 110 })
  const result = await evaluateCondition(
    { type: 'token_price_change', params: { tokenId: 'ethereum', changePercent: -5 } },
    { priceFetcher: mockFetcher },
  )
  assert.equal(result.met, false)
})

test('evaluateCondition is fail-closed on fetcher error', async () => {
  const mockFetcher = async () => { throw new Error('API timeout') }
  const result = await evaluateCondition(
    { type: 'token_price_change', params: { tokenId: 'ethereum', changePercent: -5 } },
    { priceFetcher: mockFetcher },
  )
  assert.equal(result.met, false)
  assert.ok(result.error)
  assert.match(result.error, /API timeout/)
})

test('evaluateCondition is fail-closed on invalid params', async () => {
  const result = await evaluateCondition(
    { type: 'token_price_change', params: {} },
  )
  assert.equal(result.met, false)
  assert.ok(result.error)
})
