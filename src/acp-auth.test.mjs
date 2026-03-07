import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'

async function withTempClaudeOnPath(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-acp-auth-test-'))
  const prevPath = process.env.PATH
  const prevFlag = process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
  const prevHome = process.env.HOME

  try {
    if (process.platform !== 'win32') {
      const cliPath = path.join(tempDir, 'claude')
      await writeFile(cliPath, '#!/bin/sh\necho "--non-interactive-permissions"\n', 'utf8')
      await chmod(cliPath, 0o755)
      process.env.PATH = `${tempDir}${path.delimiter}${prevPath || ''}`
    }
    delete process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
    process.env.HOME = tempDir

    const cacheBust = `${Date.now()}-${Math.random()}`
    const mod = await import(`./acp-auth.mjs?bust=${cacheBust}`)
    await run(mod)
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevFlag === undefined) delete process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
    else process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS = prevFlag
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    await rm(tempDir, { recursive: true, force: true })
  }
}

test('resolveAgentDefaultCommand detects claude non-interactive permission support from PATH probe', { skip: process.platform === 'win32' }, async () => {
  await withTempClaudeOnPath(async (mod) => {
    const command = mod.resolveAgentDefaultCommand('claude-code', 'hello', 'sess-1')
    assert.ok(Array.isArray(command))
    assert.ok(command.includes('--non-interactive-permissions'))
    assert.ok(command.includes('fail'))
  })
})
