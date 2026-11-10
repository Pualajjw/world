import { randomUUID } from 'node:crypto'
import { createAssistantActivity } from './assistant-activity.js'

const PREFIX = 'world-workbench-'
const idOf = value => value?.id || value?.session?.id || value?.header?.id
const requestOf = message => message?.source?.rpcId || ''
const userInput = message => ['user', 'user-question-reply'].includes(message?.source?.kind)

/**
 * The fixed session as a passive executor: the life line decides when she is woken, this decides whether the word
 * can enter now, keeps her replies published, and lets the user preempt anything she started on her own.
 * There is no schedule of its own — no interval, no idle timer, no reminder queue.
 */
export function createWorkbench(ctx, { brain, bridge, journal, promptOf, onHandoff, nextUp } = {}) {
  let active = null, disposed = false, userPaused = false
  let userTask = null, userRevision = 0
  let journalError = ''
  const pendingUsers = new Map(), interactions = new Set()
  let status = { mode: 'waiting', summary: '等待你设定背景并交接工作台。' }
  const statusListeners = new Set()
  const setStatus = value => { status = value; for (const listener of statusListeners) listener() }
  /** Between turns the card says what her own clock says next, not "waiting for input". */
  const atRest = fallback => nextUp?.() || fallback
  const desktops = new Map(), offs = []
  const ready = brain.get().catch(error => { setStatus({ mode: 'error', summary: error.message }) })
  const current = () => [...desktops.values()].at(-1)
  const agentOf = () => ctx.agents.get(brain.peek().sessionId)
  const record = (key, title, body) => {
    if (!journal) return
    void journal.recordProgress({ key: `${brain.peek().sessionId}:${key}`, title, body }).then(() => {
      if (journalError && !disposed) { journalError = ''; setStatus({ ...status }) }
    }).catch(error => {
      if (!disposed) { journalError = String(error.message || error); setStatus({ ...status }) }
    })
  }
  function holdUser(summary = '优先处理你布置的任务。') {
    if (userTask) Object.assign(userTask, { phase: 'waiting', completion: null })
    setStatus({ mode: 'user', summary })
  }
  function cancelPendingStart() {
    if (!active || active.turn !== null) return
    const old = active
    active = null
    old.abort.abort()
    const agent = agentOf()
    for (const message of [...(agent?.inbox?.nextTurn || []), ...(agent?.inbox?.nextStep || [])])
      if (requestOf(message) === old.requestId) agent.inbox.remove(message.id)
  }
  function preempt(agent) {
    setStatus({ mode: 'user', summary: '优先处理你布置的任务。' })
    if (!active) return
    const old = active
    active = null
    old.abort.abort()
    for (const message of [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])])
      if (requestOf(message) === old.requestId) agent.inbox.remove(message.id)
    if (old.turn !== null) agent.cancel({ kind: 'user' }, { keepInbox: true })
  }

  /**
   * Hand her a word the life line wrote. False means "not now": her session is busy, the desktop is not handed
   * over, the user is still being served, or nothing should be started while a question is open.
   */
  async function run(request = {}) {
    await ready
    const fixed = brain.peek(), desktop = current()
    if (disposed || userPaused || active || !desktop || !fixed.profile) return false
    if (userTask?.phase === 'waiting') return false
    const agent = agentOf()
    if (agent?.status === 'running' || agent?.inbox?.hasPending || interactions.size) return false
    const own = { requestId: PREFIX + randomUUID(), turn: null, checkpoint: null, abort: new AbortController(),
      desktopId: desktop.desktopId, controlId: desktop.control.controlId }
    active = own
    setStatus({ mode: 'workbench', summary: request.summary || '在自己的时间里。' })
    try {
      await ctx.sessionController.prompt({ sessionId: fixed.sessionId, requestId: own.requestId, mode: 'queue',
        content: [{ type: 'text', text: String(request.text ?? '') }] }, own.abort.signal)
      return true
    } catch (error) {
      if (active === own) { active = null; setStatus({ mode: 'error', summary: String(error.message || error) }) }
      return false
    }
  }

  offs.push(bridge.subscribe(event => {
    const control = event.state.control, fixed = brain.peek()
    if (event.connected && control?.owner === 'assistant' && control.sessionId === fixed.sessionId) {
      const prior = desktops.get(event.desktopId)
      desktops.set(event.desktopId, { desktopId: event.desktopId, control })
      if (prior?.control.controlId !== control.controlId) {
        if (active?.turn === null && (active.controlId !== control.controlId || active.desktopId !== event.desktopId)) cancelPendingStart()
        // A fresh handoff is a fresh intent to let her work.
        userPaused = false
        if (!active && !userTask && (agentOf()?.status === 'running' || agentOf()?.inbox?.hasPending))
          userTask = { revision: ++userRevision, turn: null, phase: 'waiting', completion: null }
        onHandoff?.(control)
      }
    } else {
      desktops.delete(event.desktopId)
      if (!current()) cancelPendingStart()
    }
  }))
  offs.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (idOf(agent) !== brain.peek().sessionId) return
    const request = requestOf(message)
    if (request.startsWith(PREFIX)) {
      if (request !== active?.requestId) agent.inbox?.remove(message.id)
      return
    }
    if (userInput(message)) {
      userTask = { revision: ++userRevision, turn: null, phase: 'waiting', completion: null }
      if (message.id) pendingUsers.set(message.id, userRevision)
      preempt(agent)
    }
  }))
  offs.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (idOf(agent) !== brain.peek().sessionId) return
    if (requestOf(message) === active?.requestId) active.turn = turn
    else if (userInput(message) && !requestOf(message).startsWith(PREFIX)) {
      const revision = pendingUsers.get(message.id)
      pendingUsers.delete(message.id)
      if (!userTask) userTask = { revision: ++userRevision, turn: null, phase: 'waiting', completion: null }
      if (revision === undefined || revision === userTask.revision) userTask.turn = turn
      setStatus({ mode: 'user', summary: '优先处理你布置的任务。' })
    }
  }))
  offs.push(ctx.on('session/event', (session, event) => {
    if (idOf(session) !== brain.peek().sessionId) return
    if (event.type === 'approval/asked') { interactions.add(event.data.id); return }
    if (event.type === 'approval/decided') { interactions.delete(event.data.id); return }
    if (event.type === 'step/start' && userTask && userTask.turn === null && !agentOf()?.inbox?.hasPending) userTask.turn = event.data.turn
    if (event.type !== 'turn/end') return
    const completed = event.data.reason?.kind === 'completed'
    if (active?.turn === event.data.turn) {
      const checkpoint = active.checkpoint
      if (completed && checkpoint?.status === 'continue') record(`workbench:${active.requestId}`, '自己的时间', checkpoint.summary)
      active = null
      setStatus({ mode: 'waiting', summary: checkpoint?.summary || atRest('这一轮结束了，等下一次到点或你的指示。') })
    } else if (userTask?.turn === event.data.turn) {
      if (completed && userTask.completion === userTask.revision && !interactions.size) {
        const summary = userTask.completionSummary || '这一轮做完了。'
        record(`user:${event.data.turn}`, '用户任务完成', summary)
        // Done means done: she returns to her own time only when her own alarm says so.
        userTask = null
        setStatus({ mode: 'waiting', summary })
      } else holdUser('这一轮回复结束了，保持你的任务模式。')
    }
  }))
  offs.push(ctx.on('user-questions/request', async (request, next) => {
    if (idOf(request.agent) !== brain.peek().sessionId) return next()
    const key = Symbol()
    interactions.add(key)
    if (userTask) holdUser('正在等待你的回复。')
    try { return await next() }
    finally { interactions.delete(key) }
  }))
  const snapshot = () => ({ ...status, summary: journalError ? `${status.summary} 日记未保存：${journalError}` : status.summary,
    journalError, sessionId: brain.peek().sessionId, enabled: Boolean(current()), running: Boolean(active), paused: userPaused,
    userTask: userTask ? { phase: userTask.phase, turn: userTask.turn } : null })
  /** The brake: keep the handoff and the running turn, stop new wake words from being taken. */
  function setPaused(value) {
    const next = Boolean(value)
    if (next === userPaused) return snapshot()
    userPaused = next
    setStatus({ ...status })
    return snapshot()
  }
  return {
    ready,
    subscribe(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener) },
    instructions(scope) { return promptOf ? promptOf(scope) : '' },
    getState() { return snapshot() },
    setPaused,
    run,
    call(operation, payload, signal) {
      signal?.throwIfAborted()
      if (operation === 'get') return snapshot()
      if (operation === 'pause') return setPaused(true)
      if (operation === 'resume') return setPaused(false)
      throw new Error('不支持的工作台操作。')
    },
    checkpoint(args, sessionId) {
      if (sessionId !== brain.peek().sessionId) throw new Error('只有固定助手可以提交进度。')
      if (!['continue', 'waiting', 'completed'].includes(args?.status) || typeof args.summary !== 'string'
        || !args.summary.trim() || args.summary.length > 1000) throw new Error('请提供 continue / waiting / completed 和 1 到 1000 字的说明。')
      if (args.status === 'completed') {
        if (active || !userTask || userTask.turn === null || agentOf()?.inbox?.hasPending || interactions.size)
          throw new Error('只有当前用户任务已处理且没有排队输入、待确认或待回复时，才能报告 completed。')
        userTask.completion = userTask.revision
        userTask.completionSummary = args.summary.trim()
        userTask.phase = 'finishing'
        setStatus({ mode: 'user', summary: args.summary.trim() })
        return this.getState()
      }
      if (!active) {
        if (args.status !== 'waiting') throw new Error('现在不是在过自己的时间，不能报告 continue。')
        if (userTask) Object.assign(userTask, { phase: 'waiting', completion: null })
        setStatus({ mode: 'waiting', summary: args.summary.trim() })
        return this.getState()
      }
      active.checkpoint = { status: args.status, summary: args.summary.trim() }
      return this.getState()
    },
    dispose() {
      disposed = true
      active?.abort.abort()
      if (active && active.turn !== null) agentOf()?.cancel({ kind: 'user' }, { keepInbox: true })
      for (const off of offs) off?.()
      desktops.clear()
      pendingUsers.clear(); interactions.clear()
      statusListeners.clear()
    },
  }
}

export function registerWorkbench(ctx, options) {
  const workbench = createWorkbench(ctx, options)
  const activity = createAssistantActivity(ctx, { ...options, workbench })
  ctx.effect(() => () => activity.dispose(), 'world: assistant activity')
  ctx.effect(() => () => workbench.dispose(), 'world: workbench lifetime')
  ctx.inject(['systemPrompt'], scope => scope.effect(() => scope.systemPrompt.context({
    name: 'world:fixed-assistant', order: 1640, required: true, interpolate: false,
    text: ({ scope }) => workbench.instructions(scope),
  }), 'world: persistent assistant background'))
  ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({
    name: 'world_workbench',
    description: '看这一轮的状态，或者在用户的任务真正做完时报一声。status：读当前状态；checkpoint status=completed：用户交代的事已经做完、没有待确认也没有待回复，用它收尾（之后她就回到自己的时间，等到点自己醒来）；status=waiting：这一轮到此为止，先等你。只在用户任务里用 completed。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'checkpoint'] },
      status: { type: 'string', enum: ['continue', 'waiting', 'completed'] }, summary: { type: 'string' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      exec.signal?.throwIfAborted()
      if (args.action === 'status') return workbench.getState()
      if (args.action === 'checkpoint') return workbench.checkpoint(args, exec.agent?.session?.id)
      throw new Error('不支持的工作台操作。')
    },
  }), 'world: workbench progress tool'))
  return Object.assign(workbench, { activity })
}
