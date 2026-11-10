import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantActivity, activityTiming } from '../assistant-activity.js'
import { createDesktopBridge } from '../desktop-bridge.js'
import { waitForDesktop } from '../desktop-client.js'

function fixture(t) {
  const handlers = new Map(), published = []
  let time = 10000
  const agent = { id: 'fixed', status: 'idle' }
  const emit = (name, ...args) => [...(handlers.get(name) || [])].map(listener => listener(...args))
  let onDesktop
  const workbench = { getState: () => ({ mode: 'workbench', enabled: true, running: false, summary: '本轮工作已结束。' }) }
  const statusListeners = new Set()
  workbench.subscribe = listener => { statusListeners.add(listener); return () => statusListeners.delete(listener) }
  workbench.setState = state => { workbench.getState = () => state; for (const listener of statusListeners) listener() }
  const ctx = { agents: { get: () => agent }, on(name, listener) {
    const set = handlers.get(name) || new Set(); set.add(listener); handlers.set(name, set)
    return () => set.delete(listener)
  } }
  const activity = createAssistantActivity(ctx, {
    brain: { peek: () => ({ sessionId: 'fixed' }), get: async () => ({ sessionId: 'fixed' }) },
    bridge: { subscribe(listener) { onDesktop = listener; return () => {} }, setActivity: state => published.push(structuredClone(state)) },
    workbench, now: () => time,
  })
  t.after(() => activity.dispose())
  const event = (type, data = {}) => emit('session/event', { id: 'fixed' }, { type, data })
  return { activity, agent, ctx, emit, event, published, workbench, tick: () => { time += 1000 }, desktop: () => onDesktop({ connected: true, state: { control: { owner: 'assistant' } } }) }
}

test('real lifecycle updates distinguish thinking, tools, approval, completion, and errors without leaking content', async t => {
  const f = fixture(t)
  await f.activity.ready
  f.desktop()
  assert.equal(f.activity.getSnapshot().phase, 'starting')
  f.agent.status = 'running'
  f.emit('agent/status', { agent: f.agent, status: 'running' })
  f.event('turn/start', { turn: 1 })
  assert.equal(f.activity.getSnapshot().phase, 'thinking')
  f.tick()
  f.emit('agent/assistant-stream', { agent: f.agent, frame: { type: 'chunk', chunk: { secret: 'private reasoning' } } })
  assert.equal(f.activity.getSnapshot().phase, 'responding')
  f.event('tool/call', { callId: 'a', name: 'pwsh', arguments: 'private arguments' })
  f.event('tool/call', { callId: 'b', name: 'read' })
  assert.equal(f.activity.getSnapshot().phase, 'executing')
  f.event('approval/asked', { id: 'approve' })
  assert.equal(f.activity.getSnapshot().phase, 'waiting')
  f.event('tool/result', { message: { callId: 'a', content: 'private result' } })
  assert.equal(f.activity.getSnapshot().phase, 'waiting')
  f.event('approval/decided', { id: 'approve' })
  assert.equal(f.activity.getSnapshot().phase, 'executing')
  assert.match(f.activity.getSnapshot().summary, /read/)
  f.event('tool/result', { message: { callId: 'b' } })
  assert.equal(f.activity.getSnapshot().phase, 'thinking')
  f.event('turn/end', { reason: { kind: 'completed' } })
  f.agent.status = 'idle'
  f.emit('agent/status', { agent: f.agent, status: 'idle' })
  assert.equal(f.activity.getSnapshot().running, false)
  assert.equal(f.activity.getSnapshot().phase, 'idle')
  assert.ok(!JSON.stringify(f.published).includes('private'))
  f.event('turn/end', { reason: { kind: 'error' } })
  f.emit('agent/status', { agent: f.agent, status: 'idle' })
  assert.equal(f.activity.getSnapshot().phase, 'error')
  f.emit('agent/status', { agent: { id: 'another' }, status: 'running' })
  assert.equal(f.activity.getSnapshot().phase, 'error', 'other sessions cannot change the fixed assistant indicator')
})

test('question state delegates normally and returns to thinking after the answer', async t => {
  const f = fixture(t)
  await f.activity.ready
  f.agent.status = 'running'
  f.emit('agent/status', { agent: f.agent, status: 'running' })
  const request = { agent: f.agent }
  let done
  const [pending] = f.emit('user-questions/request', request, () => new Promise(resolve => { done = resolve }))
  assert.equal(f.activity.getSnapshot().phase, 'waiting')
  done('answer')
  assert.equal(await pending, 'answer')
  assert.equal(f.activity.getSnapshot().phase, 'thinking')
})

test('long polling pushes activity without issuing or repeating desktop actions', async t => {
  const bridge = createDesktopBridge({ pollMs: 5 })
  t.after(() => bridge.dispose())
  const client = await bridge.call('connect', { state: { windows: [], apps: [] } })
  const pending = bridge.call('poll', client)
  bridge.setActivity({ sessionId: 'fixed', phase: 'thinking', updatedAt: 1000 })
  const pushed = await pending
  assert.equal(pushed.command, null)
  assert.equal(pushed.activity.phase, 'thinking')
  assert.equal((await bridge.call('poll', client)).command, null)
})

test('elapsed text reflects real timestamps without inventing new activity', () => {
  const activity = { running: true, startedAt: 1000, updatedAt: 8000 }
  assert.equal(activityTiming(activity, 11000), '已运行 10 秒 · 最近活动 3 秒前')
  assert.equal(activityTiming({ ...activity, running: false }, 11000), '最近活动 3 秒前')
})

test('a waiting user task does not falsely show a maintenance startup', async t => {
  const f = fixture(t)
  await f.activity.ready
  f.workbench.setState({ mode: 'user', enabled: true, running: false, summary: '等待你的回复。' })
  assert.equal(f.activity.getSnapshot().phase, 'waiting')
})

test('resident recall reports its actual preparation instead of claiming model activity before admission', async t => {
  const f = fixture(t)
  await f.activity.ready
  f.workbench.setState({ mode: 'workbench', enabled: true, running: true, summary: '正在回顾最近日记和未完事项。' })
  assert.equal(f.activity.getSnapshot().phase, 'starting')
  assert.match(f.activity.getSnapshot().summary, /回顾最近日记/)
  f.agent.status = 'running'
  f.workbench.setState({ mode: 'workbench', enabled: true, running: true, summary: '正在接续已有记录，照料工作台。' })
  assert.equal(f.activity.getSnapshot().phase, 'thinking')
  assert.match(f.activity.getSnapshot().summary, /接续已有记录/)
})

test('a startup failure is pushed immediately even if no model turn was created', async t => {
  const f = fixture(t)
  await f.activity.ready
  f.desktop()
  assert.equal(f.activity.getSnapshot().phase, 'starting')
  f.workbench.setState({ mode: 'error', summary: '无法启动助手，请检查会话的模型配置。' })
  assert.equal(f.activity.getSnapshot().phase, 'error')
  assert.match(f.activity.getSnapshot().summary, /无法启动助手/)
  assert.equal(f.activity.getSnapshot().running, false)
})

test('recent public messages hydrate from DSH history and live messages remain authoritative', async t => {
  const f = fixture(t)
  await f.activity.ready
  const reads = []
  f.ctx.sessionController = { async page(request) {
    reads.push(request)
    return { records: [
      { type: 'event', event: { seq: 2, time: 200, type: 'assistant/message', data: { turn: 1, step: 1,
        message: { content: [{ type: 'text', text: '已完成检查' }, { type: 'reasoning', text: 'private reasoning' }] } } } },
      { type: 'event', event: { seq: 1, time: 100, type: 'user/message', data: { id: 'public-user', source: { kind: 'user' },
        content: [{ type: 'text', text: '请检查' }] } } },
    ] }
  } }
  f.desktop()
  await waitForDesktop(() => f.activity.getSnapshot().messages.length === 2)
  assert.deepEqual(f.activity.getSnapshot().messages.map(row => row.text), ['请检查', '已完成检查'])
  assert.equal(reads[0].maxMessages, 8)
  assert.equal(reads[0].address.sessionId, 'fixed')
  f.event('user/message', { id: 'next-user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] })
  assert.equal(f.activity.getSnapshot().messages.at(-1).text, '继续')
  f.emit('session/event', { id: 'unrelated' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'another secret' }] } })
  assert.ok(!JSON.stringify(f.activity.getSnapshot()).includes('secret'))
})

test('the paused brake reaches every desktop while a running turn still reports its real phase', async t => {
  const f = fixture(t)
  await f.activity.ready
  f.desktop()
  f.workbench.setState({ mode: 'workbench', enabled: true, running: false, paused: true, summary: '已暂停自动推进。' })
  const state = f.activity.getSnapshot()
  assert.equal(state.paused, true)
  assert.equal(state.phase, 'paused')
  assert.equal(state.running, false)
  assert.equal(f.published.at(-1).paused, true, 'clients learn the brake state from the existing poll')
  f.agent.status = 'running'
  f.emit('agent/status', { agent: f.agent, status: 'running' })
  assert.equal(f.activity.getSnapshot().phase, 'thinking', 'pausing never hides what the current turn is doing')
  assert.equal(f.activity.getSnapshot().paused, true)
})
