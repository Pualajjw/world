import { createSessionTranscript } from './session-transcript.js'

const idOf = value => value?.id || value?.session?.id || value?.header?.id
const LABELS = {
  starting: '正在启动', thinking: '正在思考', executing: '正在执行工具', responding: '正在生成回复',
  waiting: '等你答一句', idle: '我在', error: '出错了', stopped: '已停下', paused: '先停一下',
}

/** Observe lifecycle signals and public conversation text; never reasoning or tool payloads. */
export function createAssistantActivity(ctx, { brain, bridge, workbench, now = Date.now } = {}) {
  let state = { sessionId: null, phase: 'idle', label: '等待交接', summary: '尚未启动助手。', running: false,
    startedAt: null, updatedAt: now() }
  const tools = new Map(), approvals = new Set(), questions = new Set(), offs = []
  let lastStreamAt = 0, disposed = false, streamTimer = null, hydratedSession = null
  const transcript = createSessionTranscript()
  const lifetime = new AbortController()
  const matches = value => Boolean(brain.peek().sessionId) && idOf(value) === brain.peek().sessionId
  const paused = () => Boolean(workbench.getState().paused)
  const publish = () => { if (!disposed) bridge.setActivity?.({ ...state, ...transcript.snapshot(), paused: paused() }) }
  const hydrate = () => {
    const sessionId = brain.peek().sessionId
    if (!sessionId || sessionId === hydratedSession || !ctx.sessionController?.page) return
    hydratedSession = sessionId
    void ctx.sessionController.page({ address: { kind: 'session', sessionId }, maxMessages: 8 }, lifetime.signal).then(page => {
      if (disposed || brain.peek().sessionId !== sessionId) return
      // Never replace live notifications that arrived while history was being read.
      if (!transcript.snapshot().messages.length) {
        for (const record of [...(page.records || [])].filter(record => record.event).sort((a, b) => a.event.seq - b.event.seq))
          transcript.event(record.event)
        publish()
      }
    }).catch(() => { hydratedSession = null })
  }
  const update = (phase, summary, patch = {}) => {
    state = { ...state, sessionId: brain.peek().sessionId, phase, label: LABELS[phase], summary,
      updatedAt: now(), ...patch }
    publish()
  }
  const working = summary => {
    if (questions.size || approvals.size) update('waiting', questions.size ? '我在等你答一句，在这儿说就行。' : '有个操作得你点个头，在这儿就能批。', { running: true })
    else if (tools.size) update('executing', `正在执行：${[...tools.values()].join('、')}`, { running: true })
    else update('thinking', summary || '模型正在处理当前任务。', { running: true })
  }
  const begin = () => {
    tools.clear(); approvals.clear(); questions.clear()
    const work = workbench.getState()
    update('thinking', work.mode === 'user' ? '正在处理你布置的任务。' : work.running ? work.summary : '模型正在处理当前任务。',
      { running: true, startedAt: now() })
  }
  const observeCurrent = () => {
    hydrate()
    const fixed = brain.peek(), agent = fixed.sessionId && ctx.agents.get(fixed.sessionId)
    const work = workbench.getState()
    if (state.sessionId !== fixed.sessionId) state = { ...state, sessionId: fixed.sessionId, startedAt: null }
    if (work.mode === 'error') update('error', work.summary || '我起不来了，会话里有报错。', { running: false })
    else if (agent?.status === 'running') {
      if (!state.running) begin()
      else publish()
    } else if (work.paused) update('paused', '这一轮会走完，之后我不再自己开新的。', { running: false })
    else if (work.mode === 'user' && !['error', 'stopped'].includes(state.phase)) update('waiting', work.summary, { running: false })
    else if (workbench.getState().running || (workbench.getState().enabled && !state.startedAt))
      update('starting', work.running ? work.summary : '权限已交接，正在等待固定助手启动。', { running: false })
    else if (!['waiting', 'error', 'stopped'].includes(state.phase))
      update('idle', workbench.getState().summary || '等待工作台主线启动。', { running: false })
    else publish()
  }
  if (workbench.subscribe) offs.push(workbench.subscribe(observeCurrent))
  offs.push(bridge.subscribe(event => {
    if (event.connected && event.state.control?.owner === 'assistant') observeCurrent()
  }))
  offs.push(ctx.on('agent/status', ({ agent, status }) => {
    if (!matches(agent)) return
    if (status === 'running') begin()
    else if (['error', 'waiting', 'stopped'].includes(state.phase)) { state = { ...state, running: false }; publish() }
    else update('idle', workbench.getState().summary || '本轮工作已完成。', { running: false })
  }))
  offs.push(ctx.on('session/event', (session, event) => {
    if (!matches(session)) return
    const data = event.data || {}
    if (transcript.event(event)) {
      clearTimeout(streamTimer); streamTimer = null
      publish()
    }
    if (event.type === 'turn/start') begin()
    else if (event.type === 'step/start') working()
    else if (event.type === 'tool/call') { tools.set(data.callId, String(data.name || '工具').slice(0, 80)); working() }
    else if (event.type === 'tool/result') { tools.delete(data.message?.toolCallId || data.message?.callId); working('工具已返回，正在分析结果。') }
    else if (event.type === 'approval/asked') { approvals.add(data.id); working() }
    else if (event.type === 'approval/decided') { approvals.delete(data.id); working() }
    else if (event.type === 'turn/end') {
      clearTimeout(streamTimer); streamTimer = null
      tools.clear(); approvals.clear(); questions.clear()
      const kind = data.reason?.kind
      const summary = workbench.getState().summary
      if (kind === 'completed') update('idle', summary || '本轮工作已完成。', { running: false })
      else if (kind === 'blocked') update('waiting', '卡在需要你决定的地方了，在这儿说一句就行。', { running: false })
      else if (kind === 'error' || kind === 'max-tokens') update('error', '这一轮没跑完，报错在会话里。', { running: false })
      else update('stopped', '停下了，等你说下一步。', { running: false })
    }
  }))
  offs.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!matches(agent)) return
    const contentChanged = transcript.stream(frame)
    if (frame.type === 'start') { lastStreamAt = 0; working('模型已开始生成响应。') }
    else if (frame.type === 'chunk' && (contentChanged || now() - lastStreamAt >= 500)) {
      const flush = () => {
        streamTimer = null
        lastStreamAt = now()
        update('responding', '模型正在生成响应。', { running: true })
      }
      if (now() - lastStreamAt >= 100) { clearTimeout(streamTimer); flush() }
      else if (!streamTimer) streamTimer = setTimeout(flush, 100)
    } else if (contentChanged) {
      lastStreamAt = now()
      publish()
    }
  }))
  offs.push(ctx.on('agent/error', ({ agent }) => {
    if (matches(agent)) update('error', '我这边出错了，会话里有详情。', { running: false })
  }))
  offs.push(ctx.on('user-questions/request', async (request, next) => {
    if (!matches(request.agent)) return next()
    const key = Symbol()
    questions.add(key); working()
    try { return await next() }
    finally { questions.delete(key); if (state.running && !disposed) working('收到回复，正在继续处理。') }
  }))
  const ready = brain.get().then(observeCurrent).catch(() => {
    update('error', '无法读取固定助手状态，请检查助手设定。', { running: false })
  })
  return { ready, getSnapshot: () => ({ ...structuredClone(state), ...transcript.snapshot(), paused: paused() }), dispose() {
    disposed = true; lifetime.abort(); clearTimeout(streamTimer)
    for (const off of offs) off?.()
  } }
}

/** Text only: the card retains its existing layout and style. */
export function activityTiming(activity, timestamp = Date.now()) {
  const seconds = value => Math.max(0, Math.floor((timestamp - value) / 1000))
  const age = activity?.updatedAt ? `最近活动 ${seconds(activity.updatedAt)} 秒前` : ''
  return activity?.running && activity.startedAt ? `已运行 ${seconds(activity.startedAt)} 秒 · ${age}` : age
}
