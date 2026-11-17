import assert from 'node:assert/strict'
import test from 'node:test'
import { createInternetConnectionProbe, internetConnectionFromPeers } from '../internet-connection.js'

const peers = [{ id: '1', cost: 'Local', ipv4: '10.192.168.3' }, { id: '2', cost: 'p2p', ipv4: '10.192.168.1' }]
const interfaces = { et_1: [{ family: 'IPv4', internal: false, address: '10.192.168.3' }] }
test('connected requires both an assigned TUN address and a remote peer', () => {
  assert.deepEqual(internetConnectionFromPeers(peers, interfaces), { connected: true, ipv4: '10.192.168.3', peerCount: 1 })
  assert.equal(internetConnectionFromPeers(peers.slice(0, 1), interfaces).connected, false)
  assert.equal(internetConnectionFromPeers(peers, {}).connected, false)
  assert.equal(internetConnectionFromPeers({}, interfaces).connected, false)
  assert.equal(internetConnectionFromPeers([{ ...peers[0], ipv4: 'invalid' }, peers[1]], interfaces).connected, false)
  for (const name of ['EasyTier', 'utun8', 'tun0']) {
    assert.equal(internetConnectionFromPeers([peers[0], { ...peers[1], cost: 'relay(2)' }],
      { [name]: [{ ...interfaces.et_1[0], family: 4 }] }).connected, true)
  }
})

test('CLI probing is read-only, bounded, cached and coalesces overlapping clients', async () => {
  let count = 0, time = 1000, release
  const probe = createInternetConnectionProbe({ platform: 'win32', now: () => time, interfaces: () => interfaces,
    run: async (exe, args, options) => {
      count++; assert.match(exe, /easytier-cli\.exe$/u)
      assert.deepEqual(args, ['-o', 'json', 'peer', 'list'])
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 2500)
      await new Promise(resolve => { release = resolve }); return { stdout: JSON.stringify(peers) }
    },
  })
  try {
    const a = probe.read({ directory: '' }), b = probe.read({ directory: '' })
    await Promise.resolve(); release()
    assert.equal((await a).connected, true); assert.deepEqual(await b, await a); assert.equal(count, 1)
    await probe.read({ directory: '' }); assert.equal(count, 1)
    time = 4000
    const next = probe.read({ directory: '' }); await Promise.resolve(); release(); await next
    assert.equal(count, 2)
    probe.invalidate()
    const pending = probe.read({ directory: '' }); await Promise.resolve(); probe.invalidate(); release()
    assert.equal((await pending).connected, false, 'an old read cannot restore a connection after invalidation')
  } finally { probe.dispose() }
})

test('an unavailable CLI or disconnected instance clears the connected state without exposing output', async () => {
  let failed = false
  const probe = createInternetConnectionProbe({ cacheMs: 0, interfaces: () => interfaces, run: async () => {
    if (failed) throw new Error('private CLI diagnostics')
    return { stdout: JSON.stringify(peers) }
  } })
  try {
    assert.equal((await probe.read({ directory: '' })).connected, true)
    failed = true
    const disconnected = await probe.read({ directory: '' })
    assert.equal(disconnected.connected, false)
    assert.ok(!JSON.stringify(disconnected).includes('private'))
  } finally { probe.dispose() }
})
