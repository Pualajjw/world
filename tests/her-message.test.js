import assert from 'node:assert/strict'
import test from 'node:test'
import { createHerMessage, HER_MESSAGE_LIMIT } from '../her-message.js'

function fixture({ bound = true, failPrompt = null, profile = { name: '她' } } = {}) {
  const prompts = []
  const brain = { get: async () => ({ sessionId: bound ? 'fixed' : null, profile: bound ? profile : null }) }
  const controller = {
    async prompt(request, signal) {
      if (failPrompt) throw failPrompt
      signal?.throwIfAborted()
      prompts.push(request)
      return { accepted: true }
    },
  }
  return { message: createHerMessage({ brain, controller }), prompts }
}

test('a taskbar line is steered into the fixed session as a plain user message', async () => {
  const f = fixture()
  const value = await f.message.call('insert', { text: '  把窗口挪回左边  ' })
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].sessionId, 'fixed')
  assert.equal(f.prompts[0].mode, 'steer', 'steer jumps the queue instead of waiting behind her own turn')
  assert.deepEqual(f.prompts[0].content, [{ type: 'text', text: '把窗口挪回左边' }])
  assert.match(f.prompts[0].requestId, /^world-taskbar-/)
  assert.equal(value.sessionId, 'fixed')
})

test('blank, oversized and unbound lines never reach her session', async () => {
  const f = fixture()
  await assert.rejects(f.message.call('insert', { text: '   ' }), { code: 'WORLD_HER_MESSAGE_EMPTY' })
  await assert.rejects(f.message.call('insert', { text: 'x'.repeat(HER_MESSAGE_LIMIT + 1) }), { code: 'WORLD_HER_MESSAGE_TOO_LONG' })
  await assert.rejects(f.message.call('read', {}), { code: 'WORLD_HER_MESSAGE' })
  assert.equal(f.prompts.length, 0)

  const unbound = fixture({ bound: false })
  await assert.rejects(unbound.message.call('insert', { text: '在吗' }), { code: 'WORLD_HER_MESSAGE_UNBOUND' })
  assert.equal(unbound.prompts.length, 0)
})

test('a host rejection and a cancelled request both surface instead of pretending it was delivered', async () => {
  const busy = fixture({ failPrompt: Object.assign(new Error('agent is busy'), { code: 'session/agent-busy' }) })
  await assert.rejects(busy.message.call('insert', { text: '在吗' }), { message: 'agent is busy' })

  const f = fixture()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.message.call('insert', { text: '在吗' }, abort.signal))
  assert.equal(f.prompts.length, 0)
})

test('every insert gets its own request id so retries are never swallowed as duplicates', async () => {
  const f = fixture()
  await f.message.call('insert', { text: '一' })
  await f.message.call('insert', { text: '二' })
  assert.equal(f.prompts.length, 2)
  assert.notEqual(f.prompts[0].requestId, f.prompts[1].requestId)
})

test('the host controller is looked up per call, and a missing one refuses cleanly', async () => {
  const prompts = []
  let controller = null
  const message = createHerMessage({
    brain: { get: async () => ({ sessionId: 'fixed', profile: {} }) },
    controller: () => controller,
  })
  await assert.rejects(message.call('insert', { text: '在吗' }), { code: 'WORLD_HER_MESSAGE' })
  controller = { prompt: async request => { prompts.push(request); return { accepted: true } } }
  await message.call('insert', { text: '在吗' })
  assert.equal(prompts.length, 1, 'a controller that appears later is used')
})

test('a taskbar reference grants a bounded public read only to its fixed session and listed windows', async () => {
  const calls = []
  const message = createHerMessage({ brain: { get: async () => ({ profile: {}, sessionId: 'her' }) }, controller: { prompt: async () => {} },
    bridge: { request: async (...args) => { calls.push(args); return { view: { label: '终端', text: 'ok', password: 'ignored' }, state: { controlId: 'hidden' } } } } })
  const { requestId: reference } = await message.call('insert', { text: '看报错', context: { desktopId: 'origin', key: 'f'.repeat(32), windows: [{ id: 'terminal', name: '终端' }] } })
  await assert.rejects(message.read({ reference, windowId: 'terminal' }, 'other'))
  await assert.rejects(message.read({ reference, windowId: 'unknown' }, 'her'))
  const result = await message.read({ reference, windowId: 'terminal' }, 'her')
  assert.equal(result.text, 'ok'); assert.equal(result.password, undefined); assert.equal(result.state, undefined)
  assert.equal(calls.length, 1); assert.equal(calls[0][0].action, 'taskbar_read'); assert.equal(calls[0][1].desktopId, 'origin')
})
