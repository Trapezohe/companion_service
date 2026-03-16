import test from 'node:test'
import assert from 'node:assert/strict'
import { getRecipeStep, listRecipeSteps, buildRecipeGuidance } from './automation-recipe-pack.mjs'

test('getRecipeStep returns null for unknown step kinds', () => {
  assert.equal(getRecipeStep('nonexistent'), null)
  assert.equal(getRecipeStep(''), null)
  assert.equal(getRecipeStep(null), null)
})

test('getRecipeStep returns recipe definition for each registered step kind', () => {
  for (const kind of listRecipeSteps()) {
    const step = getRecipeStep(kind)
    assert.ok(step, `missing recipe for step kind: ${kind}`)
    assert.ok(Array.isArray(step.sections) && step.sections.length > 0, `${kind} should have sections`)
    assert.ok(Array.isArray(step.guidance) && step.guidance.length > 0, `${kind} should have guidance`)
    assert.ok(step.toolBias && typeof step.toolBias === 'object', `${kind} should have toolBias`)
    assert.ok(Array.isArray(step.handoffSchema) && step.handoffSchema.length > 0, `${kind} should have handoffSchema`)
  }
})

test('listRecipeSteps returns all six workflow step kinds', () => {
  const steps = listRecipeSteps()
  assert.ok(steps.includes('plan'))
  assert.ok(steps.includes('research'))
  assert.ok(steps.includes('compare'))
  assert.ok(steps.includes('decide'))
  assert.ok(steps.includes('synthesize'))
  assert.ok(steps.includes('write'))
  assert.equal(steps.length, 6)
})

test('buildRecipeGuidance returns null for unknown step kinds', () => {
  assert.equal(buildRecipeGuidance({ stepKind: 'bogus' }), null)
  assert.equal(buildRecipeGuidance({}), null)
})

test('buildRecipeGuidance returns deep copies (mutations do not affect source)', () => {
  const a = buildRecipeGuidance({ stepKind: 'plan' })
  const b = buildRecipeGuidance({ stepKind: 'plan' })
  a.sections.push('extra')
  a.guidance.push('extra')
  a.handoffSchema.push('extra')
  a.toolBias.boosted = ['hacked']
  assert.ok(!b.sections.includes('extra'))
  assert.ok(!b.guidance.includes('extra'))
  assert.ok(!b.handoffSchema.includes('extra'))
  assert.notDeepEqual(b.toolBias.boosted, ['hacked'])
})

test('compare step recipe biases toward memory_search and fetch_url and dampens browser_navigate', () => {
  const recipe = getRecipeStep('compare')
  assert.ok(recipe.toolBias.boosted.includes('memory_search'))
  assert.ok(recipe.toolBias.boosted.includes('fetch_url'))
  assert.ok(recipe.toolBias.dampened.includes('browser_navigate'))
})

test('decide step recipe includes tradeoff matrix and confidence in sections', () => {
  const recipe = getRecipeStep('decide')
  assert.ok(recipe.sections.includes('Tradeoff Matrix'))
  assert.ok(recipe.sections.includes('Confidence'))
  assert.ok(recipe.handoffSchema.includes('tradeoffMatrix'))
  assert.ok(recipe.handoffSchema.includes('confidence'))
})

test('plan step recipe boosts web_search and memory_search and dampens browser_navigate', () => {
  const recipe = getRecipeStep('plan')
  assert.ok(recipe.toolBias.boosted.includes('web_search'))
  assert.ok(recipe.toolBias.boosted.includes('memory_search'))
  assert.ok(recipe.toolBias.dampened.includes('browser_navigate'))
})

test('research step recipe boosts web_search, fetch_url, and browser_navigate', () => {
  const recipe = getRecipeStep('research')
  assert.ok(recipe.toolBias.boosted.includes('web_search'))
  assert.ok(recipe.toolBias.boosted.includes('fetch_url'))
  assert.ok(recipe.toolBias.boosted.includes('browser_navigate'))
})
