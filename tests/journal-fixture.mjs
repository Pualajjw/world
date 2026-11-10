import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let atomic
try { atomic = await import('@deepseek-ai/dsh-atomic-write') }
catch { atomic = await import(pathToFileURL(join(process.env.WORLD_DSH_SOURCE || 'E:/deepseek-harness', 'packages/util/atomic-write/lib/index.js'))) }
export { atomic }
