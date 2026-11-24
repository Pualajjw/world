/** A startup entry schedules a known host service, never a client-supplied command.
 * The manager returns public settings only, not runtime configurations or credentials. */
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const states = ['enabled', 'disabled', 'removed']
export function createWorldStartup({ dir, atomic }) {
  const file = join(dir, 'startup.json'), apps = new Map(), attempted = new Set(), errors = new Set()
  async function settings() {
    let raw, values
    try { raw = await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return {}; throw e }
    try { values = JSON.parse(raw) } catch { /* reported below */ }
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.values(values).every(s => states.includes(s)))
      throw Error('启动项配置无法读取，原文件未被修改。')
    return values
  }
  function app(id) {
    if (!apps.has(id)) throw Error('未知的 World 启动项。')
    return apps.get(id)
  }
  async function state(id, shared) {
    const item = app(id)
    // An application with an existing preference (EasyTier) remains its only writer.
    return item.read ? item.read() : (await (shared || settings()))[id] ?? item.initial
  }
  return {
    register(id, item) {
      if (apps.has(id)) throw Error('重复的启动项：' + id)
      apps.set(id, item)
    },
    async run(id, signal) {
      if (attempted.has(id)) return
      attempted.add(id)
      try { if (await state(id) === 'enabled' && !signal?.aborted) await app(id).start(signal) }
      catch (e) { if (!signal?.aborted) { errors.add(id); throw e } }
    },
    async call(op, { id, state: next } = {}, signal) {
      signal?.throwIfAborted()
      if (op === 'list') {
        let shared
        return Promise.all([...apps].map(async ([id, item]) => {
          try {
            if (!item.read) shared ??= settings()
            return { id, name: item.name, state: await state(id, shared), failed: errors.has(id) }
          } catch { return { id, name: item.name, state: 'unavailable' } }
        }))
      }
      const item = app(id)
      if (op === 'get') return { state: await state(id) }
      if (op !== 'set' || !states.includes(next)) throw Error('无效的启动项操作。')
      if (next === 'enabled') await item.validate?.()
      signal?.throwIfAborted()
      if (item.write) await item.write(next, signal)
      else {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await atomic.withFileLock(file, async () => {
          signal?.throwIfAborted()
          const values = await settings()
          values[id] = next // A removed default-on item needs a persistent tombstone.
          await atomic.writeFileAtomic(file, JSON.stringify(values) + '\n', { mode: 0o600, dirMode: 0o700 })
        }, { signal, waitMs: 5000 })
      }
      return { state: next }
    },
  }
}
