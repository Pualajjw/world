import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkbench } from '../workbench.js'
import { DEFAULT_BACKGROUND, workbenchProfile } from '../workbench-profile.js'

function fixture(t, options = {}) {
  const handlers = new Map(), prompts = [], cancelled = [], removed = [], handoffs = []
  const agent = { id: 'fixed', status: 'idle', inbox: { hasPending: false, nextTurn: [], nextStep: [], remove: id => removed.push(id) },
    cancel(cause, cancelOptions) { cancelled.push({ cause, options: cancelOptions }) } }
  const emit = (name, ...args) => [...(handlers.get(name) || [])].map(listener => listener(...args))
  const ctx = { agents: { get: id => id === 'fixed' ? agent : null },
    on(name, listener) {
      const set = handlers.get(name) || new Set(); set.add(listener); handlers.set(name, set)
      return () => set.delete(listener)
    },
    sessionController: { async prompt(request) {
      prompts.push(request)
      const message = { id: `m${prompts.length}`, source: { kind: 'user', rpcId: request.requestId } }
      emit('agent/inbox/inserted', { agent, message })
      agent.status = 'running'
      emit('agent/inbox/claimed', { agent, message, turn: prompts.length })
      return { accepted: true }
    } },
  }
  const brainState = { sessionId: 'fixed', profile: workbenchProfile() }
  const notify = { current: () => {} }
  const workbench = createWorkbench(ctx, { brain: { get: async () => brainState, peek: () => brainState },
    bridge: { subscribe(fn) { notify.current = fn; return () => {} } },
    onHandoff: control => handoffs.push(control.controlId),
    promptOf: scope => scope?.id === 'fixed' ? DEFAULT_BACKGROUND : '', ...options })
  const grant = id => notify.current({ desktopId: 'desktop', connected: true,
    state: { control: { owner: 'assistant', controlId: id, sessionId: 'fixed' } } })
  const complete = (turn, kind = 'completed') => {
    emit('session/event', { id: 'fixed' }, { type: 'turn/end', data: { turn, reason: { kind } } })
    agent.status = 'idle'
    emit('agent/status', { agent, status: 'idle' })
  }
  t.after(() => workbench.dispose())
  return { ctx, workbench, agent, emit, prompts, cancelled, removed, handoffs, grant, complete }
}

function beginUser(f, turn, id = `human-${turn}`) {
  const message = { id, source: { kind: 'user', rpcId: id } }
  f.agent.inbox.hasPending = true
  f.emit('agent/inbox/inserted', { agent: f.agent, message })
  f.emit('agent/inbox/claimed', { agent: f.agent, message, turn })
  f.agent.inbox.hasPending = false
  f.agent.status = 'running'
  f.emit('agent/status', { agent: f.agent, status: 'running' })
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('her background applies only to the one fixed brain, and nothing wakes before handoff', async t => {
  const f = fixture(t)
  await f.workbench.ready
  assert.ok(f.workbench.instructions({ id: 'fixed' }).includes(DEFAULT_BACKGROUND))
  assert.equal(f.workbench.instructions({ id: 'other' }), '')
  assert.equal(await f.workbench.run({ text: '【我的时间】早上了' }), false, 'no handoff, no wake')
  assert.equal(f.prompts.length, 0)
})

test('a wake word enters only once the desktop is handed over', async t => {
  const f = fixture(t)
  f.grant('grant-1')
  assert.equal(await f.workbench.run({ text: '【我的时间】早上了', summary: '在自己的时间里' }), true)
  assert.equal(f.prompts[0].sessionId, 'fixed')
  assert.match(f.prompts[0].content[0].text, /我的时间/)
  assert.equal(f.workbench.getState().mode, 'workbench')
  assert.equal(f.workbench.getState().running, true)
})

test('a busy session, a queued input or an open question keeps the word out', async t => {
  const f = fixture(t)
  f.grant('grant-1')
  f.agent.status = 'running'
  assert.equal(await f.workbench.run({ text: 'x' }), false, 'a running turn owns the session')
  f.agent.status = 'idle'
  f.agent.inbox.hasPending = true
  assert.equal(await f.workbench.run({ text: 'x' }), false, 'queued input is answered first')
  f.agent.inbox.hasPending = false
  f.emit('session/event', { id: 'fixed' }, { type: 'approval/asked', data: { id: 'approval-1' } })
  assert.equal(await f.workbench.run({ text: 'x' }), false, 'an approval must be decided first')
  f.emit('session/event', { id: 'fixed' }, { type: 'approval/decided', data: { id: 'approval-1' } })
  assert.equal(await f.workbench.run({ text: 'x' }), true)
})

test('a user task still waiting keeps her out of her own time', async t => {
  const f = fixture(t)
  beginUser(f, 101)
  f.grant('grant-1')
  assert.equal(f.workbench.getState().mode, 'user')
  assert.equal(await f.workbench.run({ text: 'x' }), false, 'the user is still being served')
  f.workbench.checkpoint({ status: 'completed', summary: '用户任务已完成。' }, 'fixed')
  f.complete(101)
  assert.equal(f.workbench.getState().userTask, null)
  assert.equal(f.workbench.getState().mode, 'waiting', 'done means done: the next wake comes from her own alarm')
  assert.equal(await f.workbench.run({ text: 'x' }), true)
  assert.equal(f.prompts.length, 1, 'the waiting word never entered, so this is the first wake')
})

test('new user input preempts her own turn and keeps the user inbox', async t => {
  const f = fixture(t)
  f.grant('grant-1')
  await f.workbench.run({ text: '【我的时间】自己待着' })
  f.agent.inbox.hasPending = true
  f.emit('agent/inbox/inserted', { agent: f.agent, message: { id: 'human', source: { kind: 'user', rpcId: 'human-1' } } })
  assert.deepEqual(f.cancelled, [{ cause: { kind: 'user' }, options: { keepInbox: true } }])
  assert.equal(f.workbench.getState().mode, 'user')
})

test('a user message racing prompt admission removes the late wake word', async t => {
  const f = fixture(t)
  let accept
  f.ctx.sessionController.prompt = request => {
    f.prompts.push(request)
    return new Promise(resolve => { accept = () => {
      f.emit('agent/inbox/inserted', { agent: f.agent, message: { id: 'late-wake',
        source: { kind: 'user', rpcId: request.requestId } } })
      resolve({ accepted: true })
    } })
  }
  f.grant('grant-1')
  const pending = f.workbench.run({ text: '【我的时间】早上了' })
  await flush()
  f.emit('agent/inbox/inserted', { agent: f.agent, message: { id: 'human', source: { kind: 'user', rpcId: 'human-late' } } })
  accept()
  await pending
  assert.ok(f.removed.includes('late-wake'))
  assert.equal(f.workbench.getState().mode, 'user')
  assert.deepEqual(f.cancelled, [], 'the user turn itself is never cancelled')
})

test('completion is refused while an approval or a question is still open', async t => {
  const f = fixture(t)
  beginUser(f, 101)
  f.grant('grant-1')
  const sessionEvent = (type, data) => f.emit('session/event', { id: 'fixed' }, { type, data })
  sessionEvent('approval/asked', { id: 'approval-1' })
  assert.throws(() => f.workbench.checkpoint({ status: 'completed', summary: '不应通过。' }, 'fixed'))
  sessionEvent('approval/decided', { id: 'approval-1' })
  const [pending] = f.emit('user-questions/request', { agent: f.agent }, () => Promise.resolve('已确认'))
  assert.throws(() => f.workbench.checkpoint({ status: 'completed', summary: '仍在等回复。' }, 'fixed'))
  await pending
  f.workbench.checkpoint({ status: 'completed', summary: '现在可以了。' }, 'fixed')
  f.complete(101)
  assert.equal(f.workbench.getState().userTask, null)
})

test('progress is journaled without waking her again, and waiting is never invented as progress', async t => {
  const entries = []
  const f = fixture(t, { journal: { async recordProgress(value) { entries.push(value) } } })
  f.grant('grant-1')
  await f.workbench.run({ text: '【我的时间】自己待着' })
  f.workbench.checkpoint({ status: 'continue', summary: '修复问题并通过测试。' }, 'fixed')
  f.complete(1)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].body, '修复问题并通过测试。')
  assert.equal(f.prompts.length, 1, 'journaling never wakes the model')

  await f.workbench.run({ text: '【我的时间】自己待着' })
  f.workbench.checkpoint({ status: 'waiting', summary: '等确认。' }, 'fixed')
  f.complete(2)
  assert.equal(entries.length, 1, 'waiting is not progress')
  assert.equal(f.workbench.getState().summary, '等确认。')
})

test('between turns the card reports her own clock, not a waiting prompt', async t => {
  const f = fixture(t, { nextUp: () => '在自己的时间里：回顾今天，到 今天 23:00（还有 2 小时）。' })
  f.grant('grant-1')
  await f.workbench.run({ text: '【我的时间】10:30 到了' })
  f.complete(1)
  assert.match(f.workbench.getState().summary, /在自己的时间里：回顾今天/)

  // Her own words about a round still win over the clock.
  await f.workbench.run({ text: '【我的时间】12:00 到了' })
  f.workbench.checkpoint({ status: 'waiting', summary: '等确认。' }, 'fixed')
  f.complete(2)
  assert.equal(f.workbench.getState().summary, '等确认。')
})

test('a diary write failure is visible without losing the handoff', async t => {
  const f = fixture(t, { journal: { async recordProgress() { throw new Error('disk full') } } })
  beginUser(f, 101)
  f.grant('grant-1')
  f.workbench.checkpoint({ status: 'completed', summary: '任务已完成。' }, 'fixed')
  f.complete(101)
  await flush()
  assert.match(f.workbench.getState().journalError, /disk full/)
  assert.equal(f.workbench.getState().enabled, true)
  assert.match(f.workbench.getState().summary, /日记未保存/)
})

test('the brake stops new wake words while keeping the handoff and the running turn', async t => {
  const f = fixture(t)
  f.grant('grant-1')
  await f.workbench.run({ text: '【我的时间】自己待着' })
  assert.equal(f.workbench.getState().paused, false, 'a handoff starts unpaused')
  assert.equal(f.workbench.call('pause').paused, true)
  f.complete(1)
  assert.deepEqual(f.cancelled, [], 'pausing never cancels the running turn')
  assert.equal(await f.workbench.run({ text: 'x' }), false, 'a paused autopilot takes no wake word')
  assert.equal(f.workbench.getState().paused, true, 'paused survives the turn boundary')
  assert.equal(f.workbench.call('resume').paused, false)
  assert.equal(await f.workbench.run({ text: 'x' }), true)
})

test('a fresh handoff is a fresh intent: the brake clears and the caller is told to re-arm', async t => {
  const f = fixture(t)
  f.grant('grant-1')
  f.workbench.setPaused(true)
  f.grant('grant-2')
  assert.equal(f.workbench.getState().paused, false)
  assert.deepEqual(f.handoffs, ['grant-1', 'grant-2'])
})
