import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import dgram from 'node:dgram'
import { createLanChatServer } from '../lan-chat/server.mjs'

const PROTOCOL = 'dsh-world-lan-chat/1'
const home = () => mkdtemp(join(tmpdir(), 'dsh-world-presence-'))
const base = port => `http://127.0.0.1:${port}`
const get = (port, path) => fetch(base(port) + path).then(res => res.json())
const post = (port, path, body) => fetch(base(port) + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then(async res => ({ status: res.status, body: await res.json() }))
const waitFor = async (read, timeout = 4000) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 60))
  }
}

test('diagnostics expose UDP/HTTP health and the compact network snapshot', async t => {
  const port = 59000 + Math.floor(Math.random() * 300)
  const service = createLanChatServer({ port, discoveryPort: port + 1000, home: await home() })
  try {
    const info = await service.start()
    const diag = await get(info.port, '/api/diagnostics')
    assert.equal(diag.discoveryPort, port + 1000)
    assert.equal(diag.httpPort, info.port)
    assert.equal(diag.udp.bound, true, 'UDP should bind on a free port')
    assert.equal(diag.udp.port, port + 1000)
    assert.ok(Array.isArray(diag.warnings))
    assert.equal(diag.http.received, 0)
    const state = await get(info.port, '/api/state')
    assert.equal(state.network.udpBound, true)
    assert.equal(state.network.discoveryPort, port + 1000)
    assert.equal(state.network.httpPort, info.port)
    assert.ok(state.network.warnings.length >= 0)
  } finally { await service.stop() }
})

test('HTTP presence adds a peer without any UDP packet and rejects invalid or self notices', async t => {
  const port = 59500 + Math.floor(Math.random() * 200)
  const service = createLanChatServer({ port, discoveryPort: port + 800, home: await home() })
  try {
    const info = await service.start()
    const me = await get(info.port, '/api/ping')
    const peer = { proto: PROTOCOL, type: 'presence', id: 'peer-a:53317', name: '远端的 A',
      machine: 'A-pc', port: 53317, world: '@local/dsh-world 0.2.65', worldInstalled: true }
    const accepted = await post(info.port, '/api/presence', peer)
    assert.equal(accepted.status, 200)
    const state = await get(info.port, '/api/state')
    const record = state.peers.find(item => item.id === 'peer-a:53317')
    assert.ok(record, 'HTTP presence must create a peer even when UDP never arrives')
    assert.equal(record.online, true)
    assert.equal(record.via, 'http')
    assert.equal(record.ip, '127.0.0.1')
    assert.equal(state.network.onlinePeers, 1)
    assert.ok(state.network.lastHttpAt > 0)

    const invalid = await post(info.port, '/api/presence', { ...peer, proto: 'wrong', id: 'peer-x:1' })
    assert.equal(invalid.status, 400)
    const self = await post(info.port, '/api/presence', { ...peer, id: me.id })
    assert.equal(self.status, 400)
    const after = await get(info.port, '/api/state')
    assert.equal(after.peers.filter(item => item.id === 'peer-x:1').length, 0)
    assert.equal(after.peers.filter(item => item.id === me.id).length, 0)
    const diag = await get(info.port, '/api/diagnostics')
    assert.ok(diag.http.received >= 1)
    assert.ok(diag.rejected.protocol >= 1)
    assert.ok(diag.rejected.self >= 1)
  } finally { await service.stop() }
})

test('a UDP hello from B makes A push HTTP presence back to B (one-way UDP still becomes visible)', async t => {
  const homeA = await home(), homeB = await home()
  const portA = 60000 + Math.floor(Math.random() * 200)
  const portB = portA + 200
  const serverA = createLanChatServer({ port: portA, discoveryPort: portA + 500, home: homeA })
  const serverB = createLanChatServer({ port: portB, discoveryPort: portB + 500, home: homeB })
  const socket = dgram.createSocket('udp4')
  try {
    const a = await serverA.start()
    const b = await serverB.start()
    const meB = await get(b.port, '/api/ping')
    // B 的 hello 只送到 A 的 UDP 端口；B 自己从未收到过 A 的任何 UDP 包。
    const hello = { proto: PROTOCOL, type: 'hello', id: meB.id, name: meB.nickname, machine: meB.machine,
      port: b.port, world: meB.world, worldInstalled: true, at: Date.now() }
    socket.send(Buffer.from(JSON.stringify(hello)), portA + 500, '127.0.0.1')
    const stateA = await waitFor(async () => {
      const state = await get(a.port, '/api/state')
      return state.peers.find(item => item.id === meB.id) ? state : null
    })
    assert.equal(stateA.peers.find(item => item.id === meB.id).via, 'udp')

    const stateB = await waitFor(async () => {
      const state = await get(b.port, '/api/state')
      return state.peers.find(item => item.via === 'http') ? state : null
    })
    const seenByB = stateB.peers.find(item => item.via === 'http')
    assert.ok(seenByB, 'B must learn about A through the HTTP fallback')
    assert.equal(seenByB.online, true)
    assert.equal(seenByB.ip, '127.0.0.1')
    assert.equal(seenByB.port, a.port)
    const diagA = await get(a.port, '/api/diagnostics')
    assert.ok(diagA.http.pushed >= 1)
    const diagB = await get(b.port, '/api/diagnostics')
    assert.ok(diagB.http.received >= 1)
  } finally {
    try { socket.close() } catch {}
    await serverA.stop()
    await serverB.stop()
  }
})
