import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLanChatServer } from '../lan-chat/server.mjs'

async function fixture(t, models) {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const home = await mkdtemp(join(tmpdir(), 'world-chat-security-'))
  const service = createLanChatServer({ port, discoveryPort: port, home, models })
  t.after(async () => { await service.stop(); await rm(home, { recursive: true, force: true }) })
  return { service, port, base: `http://127.0.0.1:${port}` }
}
const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

test('chat private state, SSE and model management require the owner credential', async t => {
  const { service, base } = await fixture(t), info = await service.start()
  for (const path of ['/api/state', '/api/events', '/api/bots/sessions', '/api/network', '/api/diagnostics'])
    assert.equal((await fetch(base + path)).status, 401, path)
  for (const path of ['/api/send', '/api/bind', '/api/context/reset', '/api/conversations', '/api/profile', '/api/group/settings'])
    assert.equal((await post(base, path, {})).status, 401, path)
  const headers = { cookie: info.cookie }
  assert.equal((await fetch(base + '/api/state', { headers })).status, 200)
  assert.equal((await fetch(base + '/api/state', { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 403)
  assert.equal((await post(base, '/api/profile', { nickname: 'bad' }, { ...headers, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post(base, '/api/auth', { token: 'wrong' })).status, 401)
  const token = new URLSearchParams(new URL(info.url).hash.slice(1)).get('world-chat')
  const paired = await post(base, '/api/auth', { token })
  assert.equal(paired.status, 200)
  assert.match(paired.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.equal(paired.headers.get('access-control-allow-origin'), null)
  const ping = await fetch(base + '/api/ping')
  assert.equal(ping.status, 200)
  assert.ok(!(await ping.text()).includes(token), 'peer discovery cannot disclose the owner credential')
  assert.equal((await fetch(base + '/api/ping', { headers: { origin: 'https://untrusted.invalid' } })).status, 403)
})

test('incoming peer packets cannot invite local models or enable their remote permission', async t => {
  const calls = [], bot = { id: 'bot:test/model', name: '模型', provider: 'test', model: 'model' }
  const { service, base } = await fixture(t, { list: async () => [bot], createSession: async () => 'session',
    ask: async () => { calls.push('ask'); return 'reply' } })
  const info = await service.start(), headers = { cookie: info.cookie }
  const created = await (await post(base, '/api/conversations', { kind: 'group', name: '本机群',
    botIds: [bot.id], allowOthersMention: false }, headers)).json()
  const conv = created.state.conversations.find(row => row.id === created.id)
  for (const conversation of [
    { ...conv, allowOthersMention: true, settingsVersion: 999 },
    { ...conv, id: undefined, allowOthersMention: true, settingsVersion: 999 },
    { ...conv, id: 'forged-group', allowOthersMention: true, settingsVersion: 999 },
  ]) {
    const response = await post(base, '/api/receive', { type: 'message', from: { id: 'peer-remote', nickname: '远端' },
      conversation, message: { id: Math.random().toString(), conversationId: conversation.id || conv.id, text: '@模型 不得执行' } })
    assert.equal(response.status, 200, 'peer messaging remains available')
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [])
  assert.equal(service.snapshot().conversations.find(row => row.id === conv.id).allowOthersMention, false)
  assert.equal(service.snapshot().conversations.find(row => row.id === 'forged-group').botMembers.length, 0)
})

test('concurrent chat starts share a listener and stop closes it', async t => {
  const { service, base, port } = await fixture(t)
  const first = service.start(), second = service.start()
  assert.equal(first, second)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.port, port); assert.deepEqual(a, b)
  await service.stop()
  await assert.rejects(fetch(base + '/api/ping', { signal: AbortSignal.timeout(1000) }))
  const restarted = await service.start()
  assert.equal(restarted.port, port)
})

test('stop during startup waits for rollback and allows a clean retry', async t => {
  let release, entered, hold = true
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  const { service, base } = await fixture(t, { list: async () => { if (hold) { entered(); await gate } return [] } })
  t.after(() => release())
  const starting = service.start()
  const result = starting.then(() => null, error => error)
  await ready
  const stopping = service.stop()
  hold = false; release()
  assert.match((await result).message, /停止/)
  await stopping
  await assert.rejects(fetch(base + '/api/ping', { signal: AbortSignal.timeout(1000) }))
  await service.start()
  assert.equal((await fetch(base + '/api/ping')).status, 200)
})
