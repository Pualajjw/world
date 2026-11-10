import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopBridge } from '../desktop-bridge.js'
import { desktopToolDefinitions } from '../desktop-tools.js'
import { startDesktopClient, waitForDesktop } from '../desktop-client.js'

const state = { apps: [], windows: [], activeWindow: 'dsh' }
const connect = bridge => bridge.call('connect', { state })
const receipt = (bridge, client, command, value = { state }) => bridge.call('reply', {
  ...client, commandId: command.id, result: { ok: true, value },
})

test('desktop commands wait for a matching client receipt and are not redelivered', async t => {
  const bridge = createDesktopBridge({ pollMs: 5 })
  t.after(() => bridge.dispose())
  const client = await connect(bridge)
  const requested = bridge.request({ action: 'state' })
  let completed = false
  requested.then(() => { completed = true })
  const { command } = await bridge.call('poll', client)
  assert.equal(command.action, 'state')
  assert.equal(completed, false)
  assert.deepEqual(await bridge.call('poll', client), { command: null })
  await assert.rejects(bridge.call('reply', { ...client, token: 'wrong', commandId: command.id }), { code: 'WORLD_DESKTOP_OFFLINE' })
  assert.equal(completed, false)
  await receipt(bridge, client, command, { windowId: 'dsh', state })
  assert.equal((await requested).windowId, 'dsh')
  assert.equal((await bridge.call('reply', { ...client, commandId: command.id })).accepted, false)
})

test('desktop selection is explicit for multiple clients; replies and actions stay isolated', async t => {
  const bridge = createDesktopBridge({ pollMs: 5 })
  t.after(() => bridge.dispose())
  const a = await connect(bridge), b = await connect(bridge)
  assert.throws(() => bridge.request({ action: 'state' }), { code: 'WORLD_DESKTOP_AMBIGUOUS' })
  const response = bridge.request({ action: 'focus_window', windowId: 'dsh' }, { desktopId: a.desktopId })
  const { command } = await bridge.call('poll', a)
  assert.equal((await receipt(bridge, b, command)).accepted, false)
  assert.deepEqual(await bridge.call('poll', b), { command: null })
  await receipt(bridge, a, command)
  assert.equal((await response).desktopId, a.desktopId)
})

test('timeouts, abort, disconnect and shutdown settle pending calls without repeating actions', async t => {
  const bridge = createDesktopBridge({ timeoutMs: 15, pollMs: 5 })
  t.after(() => bridge.dispose())
  const client = await connect(bridge)
  await assert.rejects(bridge.request({ action: 'focus_window' }), { code: 'WORLD_DESKTOP_TIMEOUT' })
  assert.deepEqual(await bridge.call('poll', client), { command: null })
  const abort = new AbortController()
  const cancelled = bridge.request({ action: 'state' }, { signal: abort.signal })
  abort.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  const pending = bridge.request({ action: 'state' })
  await bridge.call('disconnect', client)
  await assert.rejects(pending, { code: 'WORLD_DESKTOP_OFFLINE' })
  const other = await connect(bridge)
  const stopped = bridge.request({ action: 'state' })
  const polling = bridge.call('poll', other)
  bridge.dispose()
  await assert.rejects(stopped, { code: 'WORLD_DESKTOP_STOPPED' })
  await polling
  assert.deepEqual(bridge.list(), [])
})

test('a client failure reaches the tool rather than being reported as success', async t => {
  const bridge = createDesktopBridge()
  t.after(() => bridge.dispose())
  const client = await connect(bridge)
  const response = bridge.request({ action: 'open_file' })
  const { command } = await bridge.call('poll', client)
  await bridge.call('reply', { ...client, commandId: command.id,
    result: { ok: false, error: { code: 'WORLD_DESKTOP_DIRTY', message: '草稿保留' } } })
  await assert.rejects(response, { code: 'WORLD_DESKTOP_DIRTY', message: '草稿保留' })
})

test('control updates notify the Host while preserving client ownership and disconnect state', async t => {
  const bridge = createDesktopBridge()
  t.after(() => bridge.dispose())
  const events = []
  const off = bridge.subscribe(event => events.push(event))
  const client = await connect(bridge)
  await bridge.call('update', { ...client, state: { ...state,
    control: { owner: 'assistant', controlId: 'grant-1', sessionId: 'fixed' } } })
  assert.equal(events.at(-1).state.control.controlId, 'grant-1')
  await assert.rejects(bridge.call('update', { ...client, token: 'wrong', state }), { code: 'WORLD_DESKTOP_OFFLINE' })
  await bridge.call('disconnect', client)
  assert.equal(events.at(-1).connected, false)
  off()
})

test('a delayed state reply cannot overwrite a newer handoff or report its old owner', async t => {
  const bridge = createDesktopBridge()
  t.after(() => bridge.dispose())
  const human = { ...state, control: { owner: 'human', revision: 0, controlId: null } }
  const assistant = { ...state, control: { owner: 'assistant', revision: 2, controlId: 'grant' } }
  const client = await bridge.call('connect', { state: human })
  const result = bridge.request({ action: 'state' })
  const { command } = await bridge.call('poll', client)
  // The renderer read its old state, but the user completed handoff before that reply arrived.
  await bridge.call('update', { ...client, state: assistant })
  await receipt(bridge, client, command, { state: human })
  assert.equal((await result).state.control.owner, 'assistant')
  const observed = []
  const off = bridge.subscribe(event => observed.push(event.state.control))
  await bridge.call('update', { ...client, state: human })
  assert.equal(observed.at(-1).owner, 'assistant', 'a delayed update cannot undo the handoff either')
  const revoked = { ...state, control: { owner: 'human', revision: 3, controlId: null } }
  await bridge.call('update', { ...client, state: revoked })
  await bridge.call('update', { ...client, state: assistant })
  assert.equal(observed.at(-1).owner, 'human', 'a late handoff response cannot undo a real human takeover')
  off()
})

test('a lost receipt never replays an action, and the desktop can reconnect', async t => {
  const bridge = createDesktopBridge({ pollMs: 100 })
  let executions = 0, loseReceipt = true
  const client = startDesktopClient({
    getState: () => state,
    execute: async () => { executions++; return {} },
    rpc: { async call(_channel, method, payload, signal) {
      const operation = method.slice('world-desktop/'.length)
      if (operation === 'reply' && loseReceipt) { loseReceipt = false; throw new Error('connection lost') }
      try { return { ok: true, value: await bridge.call(operation, payload, signal) } }
      catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
    } },
  })
  t.after(async () => { client.dispose(); bridge.dispose(); await client.done })
  await waitForDesktop(() => bridge.list().length === 1)
  await assert.rejects(bridge.request({ action: 'focus_window', windowId: 'dsh' }), { code: 'WORLD_DESKTOP_OFFLINE' })
  await waitForDesktop(() => bridge.list().length === 1, undefined, 4000)
  assert.equal((await bridge.request({ action: 'state' })).state.activeWindow, 'dsh')
  assert.equal(executions, 1)
})

test('an old connection update failure cannot revoke a newly reconnected desktop', async t => {
  const bridge = createDesktopBridge({ pollMs: 100 })
  const connections = []
  let notify, rejectOldUpdate, disconnected = 0
  const client = startDesktopClient({
    getState: () => state,
    execute: async () => ({}),
    onDisconnect: () => { disconnected++ },
    subscribe(listener) { notify = listener; return () => {} },
    rpc: { async call(_channel, method, payload, signal) {
      const operation = method.slice('world-desktop/'.length)
      if (operation === 'update') return new Promise((_resolve, reject) => { rejectOldUpdate = reject })
      try {
        const value = await bridge.call(operation, payload, signal)
        if (operation === 'connect') connections.push(value)
        return { ok: true, value }
      } catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
    } },
  })
  t.after(async () => { client.dispose(); bridge.dispose(); await client.done })
  await waitForDesktop(() => connections.length === 1)
  notify()
  await waitForDesktop(() => rejectOldUpdate)
  await bridge.call('disconnect', connections[0])
  await waitForDesktop(() => connections.length === 2, undefined, 4000)
  const beforeFailure = disconnected
  rejectOldUpdate(new Error('delayed update failure from old connection'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(disconnected, beforeFailure)
  assert.equal(bridge.list()[0].desktopId, connections[1].desktopId)
  assert.equal((await bridge.request({ action: 'state' })).desktopId, connections[1].desktopId)
})

test('desktop tools validate paths with the caller session and do not forward document text', async () => {
  const requests = [], reads = []
  const bridge = { list: () => [], request: async (...args) => { requests.push(args); return { state } } }
  const editor = { async call(...args) { reads.push(args); return { path: '/work/src/main.js', source: 'private source' } } }
  const tools = desktopToolDefinitions({ bridge, brain: { get: async () => ({ sessionId: 'caller' }) }, editor,
    sessions: { get: id => id === 'caller' ? { header: { cwd: '/work' } } : null } })
  const action = tools.find(tool => tool.name === 'world_desktop_action')
  const controlId = 'handoff-1'
  const exec = { agent: { session: { id: 'caller' } }, signal: new AbortController().signal }
  await action.execute({ action: 'open_file', controlId, path: 'src/main.js', line: 3, column: 2 }, exec)
  assert.deepEqual(reads[0], ['open', { sessionId: 'caller', root: '/work', path: 'src/main.js' }, exec.signal])
  assert.deepEqual(requests[0][0], { action: 'open_file', controlId, actor: { sessionId: 'caller' }, message: '', session: { id: 'caller', cwd: '/work' },
    path: '/work/src/main.js', windowId: undefined, line: 3, column: 2, refresh: false })
  assert.ok(!JSON.stringify(requests).includes('private source'))
  await assert.rejects(action.execute({ action: 'open_file', controlId, path: 'a' }, {}), { code: 'WORLD_DESKTOP_SESSION' })
  for (const line of [0, -1, 1.5, '3']) await assert.rejects(action.execute({ action: 'open_file', controlId, path: 'a', line }, exec), { code: 'WORLD_DESKTOP_INVALID' })
  await assert.rejects(action.execute({ action: 'close_window', windowId: 'dsh' }, exec), { code: 'WORLD_DESKTOP_INVALID' })
  editor.call = async () => { throw Object.assign(new Error('outside'), { code: 'FS_SANDBOX_DENIED' }) }
  await assert.rejects(action.execute({ action: 'open_file', controlId, path: '../outside' }, exec), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(requests.length, 1)
  assert.deepEqual(await tools[0].execute(), { connected: false, desktops: [], requiresDesktopId: false })
})
