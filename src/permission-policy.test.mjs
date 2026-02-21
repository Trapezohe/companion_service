import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

import {
  normalizePermissionPolicy,
  isPathWithinRoots,
  PERMISSION_MODE_FULL,
  PERMISSION_MODE_WORKSPACE,
} from './permission-policy.mjs'

test('normalizePermissionPolicy defaults to full mode', () => {
  const policy = normalizePermissionPolicy()
  assert.equal(policy.mode, PERMISSION_MODE_FULL)
  assert.deepEqual(policy.workspaceRoots, [])
})

test('normalizePermissionPolicy normalizes workspace roots', () => {
  const policy = normalizePermissionPolicy({
    mode: PERMISSION_MODE_WORKSPACE,
    workspaceRoots: ['~/workspace', '~/workspace', '  ./tmp/ws  '],
  })
  assert.equal(policy.mode, PERMISSION_MODE_WORKSPACE)
  assert.equal(policy.workspaceRoots.length, 2)
  assert.ok(policy.workspaceRoots[0].startsWith(os.homedir()))
  assert.ok(path.isAbsolute(policy.workspaceRoots[1]))
})

test('isPathWithinRoots detects nested paths', () => {
  const root = path.resolve('/tmp/example-root')
  assert.equal(isPathWithinRoots(path.resolve('/tmp/example-root'), [root]), true)
  assert.equal(isPathWithinRoots(path.resolve('/tmp/example-root/src/index.ts'), [root]), true)
  assert.equal(isPathWithinRoots(path.resolve('/tmp/example-root-2/file.txt'), [root]), false)
})
