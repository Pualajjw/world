import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthenticatedChat as createLanChatServer, ownerHeaders } from './chat-fixture.js'

const PROTOCOL = 'dsh-world-lan-chat/1'
const home = () => mkdtemp(join(tmpdir(), 'dsh-world-multiseg-'))
const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: ownerHeaders(port) }).then(res => res.json())
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { ...ownerHeaders(port), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async res => ({ status: res.status, body: await res.json() }))
const waitFor = async (read, timeout = 5000) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 60))
  }
}

test('seed peers on another subnet discover each other through HTTP presence', async t => {
  const portA = 61500 + Math.floor(Math.random() * 200)
  const portB = portA + 300
  const serverA = createLanChatServer({ port: portA, discoveryPort: portA + 700, home: await home() })
  const serverB = createLanChatServer({ port: portB, discoveryPort: portB + 700, home: await home() })
  try {
    const a = await serverA.start()
    const b = await serverB.start()
    // A 把 B 当种子设备：不需要任何 UDP 广播可达
    const saved = await post(a.port, '/api/network', { seeds: [`127.0.0.1:${b.port}`], broadcasts: [] })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.seeds, [`127.0.0.1:${b.port}`])

    const stateA = await waitFor(async () => {
      const state = await get(a.port, '/api/state')
      return state.peers.some(peer => peer.port === b.port) ? state : null
    })
    const seenByA = stateA.peers.find(peer => peer.port === b.port)
    assert.equal(seenByA.via, 'http')
    assert.equal(seenByA.online, true)
    assert.equal(seenByA.sameSubnet, false, 'loopback seeds are outside the physical subnets')

    const stateB = await waitFor(async () => {
      const state = await get(b.port, '/api/state')
      return state.peers.find(peer => peer.via === 'http') ? state : null
    })
    assert.equal(stateB.peers.find(peer => peer.via === 'http').port, a.port,
      'the seed replies immediately instead of waiting for the next announce')

    const network = await get(a.port, '/api/network')
    assert.deepEqual(network.seeds, [`127.0.0.1:${b.port}`])
    assert.equal(network.crossSubnetPeers >= 1, true)
    assert.ok(Array.isArray(network.subnets))
    const diagnostics = await get(a.port, '/api/diagnostics')
    assert.deepEqual(diagnostics.multiSegment.seeds, [`127.0.0.1:${b.port}`])
  } finally {
    await serverA.stop()
    await serverB.stop()
  }
})

test('a seed shares its neighbor table so A learns C without configuring C', async t => {
  const portA = 61900 + Math.floor(Math.random() * 150)
  const portB = portA + 250
  const serverA = createLanChatServer({ port: portA, discoveryPort: portA + 600, home: await home() })
  const serverB = createLanChatServer({ port: portB, discoveryPort: portB + 600, home: await home() })
  try {
    const a = await serverA.start()
    const b = await serverB.start()
    // B 先认识 C（C 不在线，只用于验证邻居交换；11 秒 TTL 内足够断言）
    const added = await post(b.port, '/api/presence', {
      proto: PROTOCOL, type: 'presence', id: 'peer-c:53317', name: 'C 机',
      machine: 'C-PC', port: 59999, world: '@local/dsh-world 0.2.115', worldInstalled: true,
    })
    assert.equal(added.status, 200)

    await post(a.port, '/api/network', { seeds: [`127.0.0.1:${b.port}`], broadcasts: [] })
    const stateA = await waitFor(async () => {
      const state = await get(a.port, '/api/state')
      return state.peers.find(peer => peer.id === 'peer-c:53317') ? state : null
    })
    const seenC = stateA.peers.find(peer => peer.id === 'peer-c:53317')
    assert.equal(seenC.via, 'peer')
    assert.equal(seenC.name, 'C 机')
    assert.equal(seenC.port, 59999)
  } finally {
    await serverA.stop()
    await serverB.stop()
  }
})

test('network settings persist to network.json and invalid entries are rejected', async t => {
  const dir = await home()
  const port = 62150 + Math.floor(Math.random() * 100)
  const first = createLanChatServer({ port, discoveryPort: port + 500, home: dir })
  let second = null
  try {
    await first.start()
    const saved = await post(port, '/api/network', {
      seeds: ['192.168.2.50', '192.168.3.7:54000'], broadcasts: ['192.168.2.0/24'],
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.seeds, ['192.168.2.50', '192.168.3.7:54000'])
    assert.deepEqual(saved.body.broadcasts, ['192.168.2.255'], 'CIDR is stored as its broadcast address')

    const rejected = await post(port, '/api/network', { seeds: ['not-an-ip'], broadcasts: [] })
    assert.equal(rejected.status, 400)
    assert.match(rejected.body.error, /无法识别/)
    const unchanged = await get(port, '/api/network')
    assert.deepEqual(unchanged.seeds, ['192.168.2.50', '192.168.3.7:54000'])
    await first.stop()

    second = createLanChatServer({ port: port + 1, discoveryPort: port + 501, home: dir })
    await second.start()
    const restored = await get(port + 1, '/api/network')
    assert.deepEqual(restored.seeds, ['192.168.2.50', '192.168.3.7:54000'])
    assert.deepEqual(restored.broadcasts, ['192.168.2.255'])
  } finally {
    await first.stop()
    if (second) await second.stop()
  }
})
