/**
 * 任务栏留言：把用户的一句话直接插进她的会话。
 *
 * 不经过对话视图，也不替她挑会话——固定助手是谁就送给谁。
 * `mode: 'steer'` 是「插队」：她正在过自己的时间时，这条消息进下一段，
 * 工作台（workbench.js）看到用户消息会立刻打断她手头那一轮，让她先听你的。
 * 她空着的时候 steer 就等于开一轮，不需要客户端自己判断。
 */
import { randomUUID } from 'node:crypto'

/** 一句话的上限：任务栏是插一句话的地方，不是贴长文的输入框。 */
export const HER_MESSAGE_LIMIT = 4000

const fail = (message, code = 'WORLD_HER_MESSAGE') => { throw Object.assign(new Error(message), { code }) }

/**
 * @param {object} options
 * @param {{ get: () => Promise<{sessionId: string|null, profile: object|null}> }} options.brain
 * @param {{ prompt: Function } | (() => { prompt: Function })} options.controller
 *   宿主的 sessionController（可直接给对象，也可给「现取」的函数：宿主重载服务后不会攥着旧对象）
 * @param {number} [options.limit]
 */
function publicView(raw) {
  if (!raw || typeof raw !== 'object') return null
  const view = {}
  for (const [key, limit] of [['path', 1024], ['label', 160], ['kind', 64], ['text', 4000], ['cursorLineText', 4000]])
    if (typeof raw[key] === 'string') view[key] = raw[key].slice(0, limit)
  for (const key of ['line', 'column', 'from', 'to', 'cursorLineFromColumn',
    'selectionStartLine', 'selectionStartColumn', 'selectionEndLine', 'selectionEndColumn']) if (Number.isSafeInteger(raw[key]) && raw[key] > 0) view[key] = raw[key]
  return { ...view, dirty: raw.dirty === true, truncated: raw.truncated === true }
}

export function createHerMessage({ brain, controller, bridge, limit = HER_MESSAGE_LIMIT } = {}) {
  if (!brain?.get) fail('缺少固定助手绑定。')
  const host = () => (typeof controller === 'function' ? controller() : controller)
  const grants = new Map()
  return {
    async read({ reference, windowId }, sessionId, signal) {
      const grant = grants.get(reference)
      if (!sessionId || grant?.sessionId !== sessionId || (await brain.get()).sessionId !== sessionId || grant.until < Date.now() || !grant.windows.has(windowId))
        fail('这条留言没有此窗口的只读引用，或引用已经过期。')
      const result = await bridge.request({ action: 'taskbar_read', key: grant.key, windowId }, { desktopId: grant.desktopId, signal })
      return publicView(result.view)
    },
    async call(operation, payload, signal) {
      if (operation !== 'insert') fail('不支持的消息操作。')
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (!text) fail('先说一句再插队。', 'WORLD_HER_MESSAGE_EMPTY')
      if (text.length > limit) fail(`一句话最多 ${limit} 个字。`, 'WORLD_HER_MESSAGE_TOO_LONG')
      // 先读磁盘再判断：绑定可能刚被别的窗口改过，缓存里的 sessionId 不作数。
      const fixed = await brain.get()
      if (!fixed?.profile || !fixed.sessionId)
        fail('还没有把会话交给她：先点任务栏的控制按钮完成交接。', 'WORLD_HER_MESSAGE_UNBOUND')
      const messenger = host()
      if (!messenger?.prompt) fail('宿主没有提供 dsh 会话能力，这句话没能送出去。')
      signal?.throwIfAborted()
      const requestId = `world-taskbar-${randomUUID()}`
      const content = [{ type: 'text', text }]
      const snapshot = payload.context
      if (snapshot && Array.isArray(snapshot.windows)) {
        const windows = snapshot.windows.slice(0, 128).filter(row => typeof row?.id === 'string' && typeof row.name === 'string')
          .map(row => ({ id: row.id.slice(0, 160), name: row.name.slice(0, 160), minimized: row.minimized === true }))
        let reference
        if (bridge && typeof snapshot.desktopId === 'string' && snapshot.desktopId && typeof snapshot.key === 'string' && /^[a-f0-9]{32}$/.test(snapshot.key)) {
          reference = requestId
          if (grants.size >= 16) grants.delete(grants.keys().next().value)
          grants.set(reference, { sessionId: fixed.sessionId, until: Date.now() + 600000, desktopId: snapshot.desktopId, key: snapshot.key, windows: new Set(windows.map(row => row.id)) })
        }
        content.push({ type: 'text', text: '【任务栏只读引用】\n' + JSON.stringify({ windows, active: windows.find(row => row.id === snapshot.active)?.id, view: publicView(snapshot.view), reference }) })
      }
      try { await messenger.prompt({
        requestId, sessionId: fixed.sessionId, mode: 'steer',
        content,
      }, signal ?? new AbortController().signal) } catch (error) { grants.delete(requestId); throw error }
      return { sessionId: fixed.sessionId, requestId }
    },
  }
}
