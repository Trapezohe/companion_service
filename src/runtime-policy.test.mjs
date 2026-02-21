import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'

import {
  resolveCwd,
  enforceCommandPolicy,
  PermissionPolicyError,
} from './runtime.mjs'
import { PERMISSION_MODE_WORKSPACE, PERMISSION_MODE_FULL } from './permission-policy.mjs'

async function withWorkspace(run) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-runtime-policy-'))
  const workspaceRoot = path.join(tmp, 'workspace')
  const nested = path.join(workspaceRoot, 'project')
  const outside = path.join(tmp, 'outside')
  await mkdir(nested, { recursive: true })
  await mkdir(outside, { recursive: true })

  try {
    await run({ workspaceRoot, nested, outside })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

test('resolveCwd defaults to first workspace root in workspace mode', async () => {
  await withWorkspace(async ({ workspaceRoot }) => {
    const cwd = await resolveCwd(undefined, {
      mode: PERMISSION_MODE_WORKSPACE,
      workspaceRoots: [workspaceRoot],
    })
    assert.equal(cwd, workspaceRoot)
  })
})

test('resolveCwd rejects cwd outside workspace roots', async () => {
  await withWorkspace(async ({ workspaceRoot, outside }) => {
    await assert.rejects(
      () => resolveCwd(outside, { mode: PERMISSION_MODE_WORKSPACE, workspaceRoots: [workspaceRoot] }),
      PermissionPolicyError
    )
  })
})

test('enforceCommandPolicy blocks privileged commands in workspace mode', async () => {
  await withWorkspace(async ({ workspaceRoot }) => {
    assert.throws(
      () => enforceCommandPolicy({
        command: 'sudo ls',
        cwd: workspaceRoot,
        permissionPolicy: { mode: PERMISSION_MODE_WORKSPACE, workspaceRoots: [workspaceRoot] },
      }),
      PermissionPolicyError
    )
  })
})

test('enforceCommandPolicy blocks absolute paths outside workspace', async () => {
  await withWorkspace(async ({ workspaceRoot }) => {
    const external = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/hosts'
    assert.throws(
      () => enforceCommandPolicy({
        command: `cat ${external}`,
        cwd: workspaceRoot,
        permissionPolicy: { mode: PERMISSION_MODE_WORKSPACE, workspaceRoots: [workspaceRoot] },
      }),
      PermissionPolicyError
    )
  })
})

test('enforceCommandPolicy allows normal workspace commands', async () => {
  await withWorkspace(async ({ workspaceRoot, nested }) => {
    assert.doesNotThrow(() => enforceCommandPolicy({
      command: 'node ./scripts/build.js --out=./dist/out.txt',
      cwd: nested,
      permissionPolicy: { mode: PERMISSION_MODE_WORKSPACE, workspaceRoots: [workspaceRoot] },
    }))

    assert.doesNotThrow(() => enforceCommandPolicy({
      command: 'cat /etc/hosts',
      cwd: workspaceRoot,
      permissionPolicy: { mode: PERMISSION_MODE_FULL, workspaceRoots: [] },
    }))
  })
})
