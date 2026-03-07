import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

export const COMPANION_VERSION = typeof pkg?.version === 'string' && pkg.version.trim()
  ? pkg.version.trim()
  : '0.1.0'
