import { SECRETARY, secretaryEnvelope } from './secretary.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { bindable, installedOwner, DEFAULT_BINDINGS } from './app-bindings.js'

const denied = '此工具没有获得已安装 World 应用的本次交接授权。'
const sessionOf = exec => exec.agent?.session?.id || exec.agent?.id
const excerpt = text => text.length > 12000 ? text.slice(0, 12000) + '\n…（显示已截断）' : text
const textOf = result => excerpt((result.content || []).map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n'))
/** 同一个目录在 Windows 上有多种写法：8.3 短名（ADMINI~1）、大小写、`sub\..`。
 * 桌面端只能做斜杠与大小写归一，拿不到真实路径；两侧都由 host 统一成真实路径下发，
 * 补播才会落到同一个编辑器窗口、同一个标签。虚拟路径（库、ima、pbd 内对象）解析失败时原样返回。 */
export const realPath = value => {
  if (typeof value !== 'string' || !value) return value
  try { return realpathSync.native(value) } catch { return value }
}

/** No tool-body reimplementation or direct execute(): the owning app must request the
 * invocation, then DSH's original executor, permissions, sandbox and post-policy run. */
export function createAppToolRouter({ brain, bridge, tools, agents, parentOf = () => undefined, canDelegate = () => false, warn = console.warn }) {
  const desktops = new Map(), tickets = new Map(), sequences = new Map(), deliveries = new Map()
  const ready = brain.get()
  let disposed = false, mask, maskedAgent, maskKey
  const grants = id => [...desktops].filter(([, s]) => s.control?.owner === 'assistant' && s.control.sessionId === id)
  // The PTC transport is still real executable code. Keep its configured app/approval gate,
  // but give screen time to SDK calls rather than replaying the envelope as a shell command.
  const isProgram = exec => exec.name === 'run_code' && exec.parent === undefined
  // This ticket authorizes a single delegation, never a desktop application call.
  // DSH uses fresh, non-registered symbols. A call dropped before dispatch/result
  // must not keep its token alive, and a cancelled parent cannot sponsor a child.
  const secretaryTickets = new WeakMap()
  function delegation(exec) {
    if (disposed || !canDelegate(exec.agent) || exec.signal.aborted) return false
    if (isProgram(exec)) return secretaryEnvelope(exec.arguments)
    if (exec.name !== SECRETARY) return false
    return exec.parent === undefined || secretaryTickets.get(exec.parent)?.aborted === false ||
      matches(tickets.get(exec.parent), route(sessionOf(exec), 'run_code'))
  }
  function route(id, name) {
    const live = grants(id)
    if (!id || live.length !== 1) return null
    const [[desktopId, state]] = live, appId = installedOwner(name, state)
    return appId ? { desktopId, appId, controlId: state.control.controlId } : null
  }
  const matches = (a, b) => a && b && a.controlId === b.controlId && a.appId === b.appId && a.desktopId === b.desktopId
  const nextSequence = desktopId => {
    const n = 1 + (sequences.get(desktopId) || 0); sequences.set(desktopId, n); return n
  }
  const sameGrant = (a,b) => a && b && a.desktopId === b.desktopId && a.controlId === b.controlId
  function catalog() {
    const agent = agents.get(brain.peek().sessionId)
    // Include globals masked by our current grant; the settings page must be able to re-enable them.
    const names = [...tools.definitions(agent ? parentOf(agent) : undefined), ...(agent ? tools.definitions(agent) : [])].map(t => t.name)
    return [...new Set([...names, 'run_code'])].filter(name => name !== SECRETARY && bindable(name)).sort()
  }
  function syncMask(candidate) {
    if (disposed) return
    const id = brain.peek().sessionId, agent = id && (candidate?.id === id ? candidate : agents.get(id))
    if (!agent) return
    // restrict() targets inherited registrations. Own-scope tools also pass the live guard below.
    const names = tools.definitions(parentOf(agent)).map(t => t.name).filter(name => name === SECRETARY || route(id, name)).sort()
    const key = JSON.stringify(names)
    if (maskedAgent === agent && key === maskKey) return
    const previous = mask
    maskedAgent = agent; maskKey = key
    mask = agent.ctx.tools.restrict({ allow: names })
    previous?.()
  }
  const off = bridge.subscribe(({ desktopId, connected, state }) => {
    const prior = desktops.get(desktopId)?.control?.controlId
    if (!connected || prior !== state.control?.controlId) sequences.delete(desktopId)
    if (connected) desktops.set(desktopId, state); else desktops.delete(desktopId)
    syncMask()
  })
  void ready.then(() => syncMask()).catch(warn)
  return {
    catalog, syncMask,
    async prepare(exec, next) {
      await ready
      if (sessionOf(exec) !== brain.peek().sessionId || !sessionOf(exec)) return next()
      if (delegation(exec)) { secretaryTickets.set(exec.token, exec.signal); return next() }
      if (exec.name === SECRETARY) return { kind:'deny', reason:'秘书只接受固定助手的用户任务。' }
      const r = route(sessionOf(exec), exec.name)
      const parent = tickets.get(exec.parent)
      if (!r || (exec.parent !== undefined && !sameGrant(parent, r))) return { kind: 'deny', reason: denied }
      const transport = isProgram(exec)
      if (parent?.transport) parent.hasChildren = true
      tickets.set(exec.token, { ...r, transport, sequence: transport ? undefined : nextSequence(r.desktopId), id: randomUUID() })
      return next()
    },
    guard(exec) {
      if (secretaryTickets.has(exec.token)) return delegation(exec) ? undefined : denied
      if (sessionOf(exec) && sessionOf(exec) === brain.peek().sessionId && !matches(tickets.get(exec.token), route(sessionOf(exec), exec.name))) return denied
    },
    async dispatch(exec, next) {
      const sessionId = sessionOf(exec)
      if (!sessionId || sessionId !== brain.peek().sessionId) return next()
      if (secretaryTickets.has(exec.token)) {
        try {
          if (!delegation(exec)) throw new Error(denied)
          return await next() // nested PTC calls need the parent ticket until the body settles
        } finally { secretaryTickets.delete(exec.token) }
      }
      const t = tickets.get(exec.token)
      if (!matches(t, route(sessionId, exec.name))) throw new Error(denied)
      const args = exec.arguments || {}, path = args.file_path ?? args.path
      const label = (t.transport ? args.code : undefined) ?? args.command ?? args.pattern ?? path ?? args.action
      const shown = realPath(typeof path === 'string' ? path : '')
      const request = { action: 'app_invoke', receiptId: t.id, ...(t.transport ? { transport: true } : { sequence: t.sequence }), appId: t.appId, tool: exec.name, controlId: t.controlId,
        actor: { sessionId }, session: { id: sessionId, cwd: realPath(exec.agent.session?.header?.cwd) },
        input: excerpt(typeof label === 'string' ? label : JSON.stringify(args)),
        ...(shown && ['read','write','edit'].includes(exec.name) ? { path: shown, line: args.offset || 1 } : {}) }
      let execution
      const invoke = () => {
        if (!matches(t, route(sessionId, exec.name))) throw new Error(denied)
        exec.signal.throwIfAborted()
        execution = next()
        // The desktop acknowledges the launch separately; own rejection until that ack settles.
        execution.catch(() => {})
      }
      try { await bridge.request(request, { desktopId: t.desktopId, signal: exec.signal, invoke }) }
      catch (error) { if (!execution) throw error } // a lost UI receipt cannot undo a started job
      if (!execution) throw new Error(denied)
      return execution
    },
    result(exec, result) {
      if (secretaryTickets.delete(exec.token)) return
      const t = tickets.get(exec.token)
      tickets.delete(exec.token)
      if (!t || disposed) return
      // Even a denied/cancelled call settles its sequence slot. Pending presentations must
      // not overtake an earlier approval, and a late result must never refocus a revoked desktop.
      // A pure program (including an error before its first SDK call) has no leaf receipt:
      // present its actual code and result in the bound app. Never resurrect an old grant.
      const standalone = t.transport && !t.hasChildren && matches(t, route(sessionOf(exec), exec.name))
      const packet = { action: 'app_result', receiptId: t.id, sequence: standalone ? nextSequence(t.desktopId) : t.sequence, controlId: t.controlId,
        output: textOf(result), failed: Boolean(result.isError),
        ...(t.transport ? { hasChildren: Boolean(t.hasChildren) } : {}),
        ...(t.appId === 'vscode' && !result.isError && typeof result.meta?.path === 'string' ? { resolvedPath: realPath(result.meta.path) } : {}) }
      const delivery = (deliveries.get(t.desktopId) || Promise.resolve()).then(() => {
        if (!disposed) return bridge.request(packet, { desktopId: t.desktopId })
      }).catch(warn)
      deliveries.set(t.desktopId, delivery)
      void delivery.then(() => { if (deliveries.get(t.desktopId) === delivery) deliveries.delete(t.desktopId) })
    },
    describe(id) {
      const state = grants(id)
      if (state.length !== 1) return '目前没有唯一授权的 World 桌面；可以对话、为用户派秘书任务，不能操作桌面应用。'
      const names = new Set([...Object.keys(DEFAULT_BINDINGS), ...Object.keys(state[0][1].toolBindings || {})])
      const registered = new Set(catalog())
      return '每次工具调用都由对应应用执行；只使用本步实际提供的能力。当前绑定：' + [...names].filter(n => registered.has(n) && route(id,n)).map(n => `${n} → ${route(id,n).appId}`).join('，')
    },
    dispose() { disposed = true; off(); mask?.(); tickets.clear(); desktops.clear() },
  }
}
