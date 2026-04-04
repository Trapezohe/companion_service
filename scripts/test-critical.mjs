import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')

const criticalTests = [
  'src/run-envelope.test.mjs',
  'src/run-store.test.mjs',
  'src/approval-store.test.mjs',
  'src/diagnostics.test.mjs',
  'src/server-runtime.test.mjs',
]

const result = spawnSync(
  process.execPath,
  ['--test', ...criticalTests],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
)

process.exit(result.status ?? 1)
