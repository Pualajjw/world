import { mkdir, readFile, writeFile, link, unlink, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { workbenchProfile } from './workbench-profile.js'

const fail = message => { throw Object.assign(new Error(message), { code: 'WORLD_DESKTOP_BRAIN' }) }

/** One persistent session identity for the entire world Host, shared by all desktop clients. */
export function createDesktopBrain(ctx, { file = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'world', 'brain.json'), atomic } = {}) {
  const target = () => typeof file === 'function' ? file() : file
  let chain = Promise.resolve()
  const empty = () => ({ sessionId: null, profile: null, setupRequired: true, revision: 0 })
  let cached = empty(), sequence = 0, published = 0
  const publish = (info, order) => { if (order >= published) { cached = info; published = order }; return structuredClone(info) }
  async function load() {
    const order = ++sequence
    let raw
    try { raw = await readFile(target(), 'utf8') }
    catch (error) {
      if (error.code === 'ENOENT') return { document: {}, info: publish(empty(), order) }
      throw error
    }
    let value
    try { value = JSON.parse(raw) } catch { fail('固定助手绑定文件损坏，已停止交接；不会自动更换会话。') }
    const pending = value?.formatVersion === 2 && value.sessionId === null && value.profile
    if (!pending && (typeof value?.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128))
      fail('固定助手绑定无效，已停止交接；不会自动更换会话。')
    if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) fail('助手配置版本无效。')
    const profile = value.profile === undefined ? null : workbenchProfile(value.profile)
    return { document: value, info: publish({ sessionId: value.sessionId, profile, setupRequired: profile === null, revision: value.revision ?? 0 }, order) }
  }
  const read = async () => (await load()).info
  async function available(brain) {
    if (ctx.sessions.get(brain.sessionId)) return brain
    if (!ctx.sessionController?.inspect) fail('固定助手会话不可用，已停止交接；不会自动更换会话。')
    try { await ctx.sessionController.inspect(brain.sessionId) }
    catch { fail('固定助手会话已不可用，已停止交接；不会自动更换会话。') }
    return brain
  }
  return {
    get: () => chain.then(read),
    peek: () => structuredClone(cached),
    async call(operation, payload, signal) {
      signal?.throwIfAborted()
      if (operation === 'get') return chain.then(read)
      if (!['bind', 'configure', 'update_profile'].includes(operation)) fail('不支持的助手绑定操作。')
      const task = chain.then(async () => {
        const path = target()
        const change = async () => {
          signal?.throwIfAborted()
          const { document, info: existing } = await load()
          let profile, sessionId = existing.sessionId
          if (operation === 'update_profile') {
            if (!atomic) fail('当前宿主未提供安全的配置写入支持。')
            if (Object.hasOwn(payload || {}, 'sessionId')) fail('个性化设置不能更换固定会话。')
            if (payload?.expectedRevision !== existing.revision || payload?.expectedSessionId !== sessionId)
              throw Object.assign(new Error('设置已在其他窗口更新。草稿已保留，请重新打开个性化后再保存。'), { code: 'WORLD_DESKTOP_PROFILE_STALE' })
            if (!payload?.profile || typeof payload.profile !== 'object' || Array.isArray(payload.profile)) fail('缺少个性化设置。')
            profile = workbenchProfile({ ...existing.profile, ...payload.profile })
          } else {
            if (sessionId && existing.profile) return available(existing)
            if (operation === 'bind' && !existing.profile)
              throw Object.assign(new Error('首次交接前请先设定助手背景，可直接采用默认内容。'), { code: 'WORLD_DESKTOP_SETUP_REQUIRED' })
            profile = existing.profile || workbenchProfile(payload?.background)
            if (sessionId) await available(existing)
            sessionId ||= payload?.sessionId
            if (!existing.sessionId && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !ctx.sessions.get(sessionId)))
              fail('首次交接请先打开要作为固定助手的 DSH 会话。')
          }
          signal?.throwIfAborted()
          const content = JSON.stringify({ ...document, formatVersion: 2, sessionId, profile, revision: existing.revision + 1 })
          if (atomic) await atomic.writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
          else {
            const temporary = `${path}.${randomUUID()}.tmp`
            try {
              await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
              // Legacy callers retain exclusive first binding even across Host processes.
              try { if (existing.sessionId) await rename(temporary, path); else await link(temporary, path) }
              catch (error) { if (error.code !== 'EEXIST') throw error }
            } finally { await unlink(temporary).catch(() => {}) }
          }
          return read()
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        return atomic ? atomic.withFileLock(path, change, { signal, waitMs: 5000 }) : change()
      })
      chain = task.then(() => {}, () => {})
      return task
    },
  }
}
