import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createMobileAccess, mobileBindAddress, mobileNetworkAddresses } from '../mobile-access.js'

async function fixture(t, options = {}, controls = {}) {
  const calls = [], peers = new Set()
  const upstream = http.createServer(async (req, res) => {
    calls.push({ url: req.url, headers: req.headers })
    const url = new URL(req.url, 'http://upstream')
    if (url.searchParams.get('token') === 'private-launch-token') {
      res.writeHead(303, { 'set-cookie': 'upstream=private-cookie; HttpOnly; Path=/', location: './' }); res.end(); return
    }
    if (req.headers.cookie !== 'upstream=private-cookie') { res.writeHead(401); res.end(); return }
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<html><head></head><body>real world</body></html>'); return }
    if (url.pathname === '/redirect') { res.writeHead(303, { location: '/', 'set-cookie': 'must-not-leak=yes' }); res.end(); return }
    if (url.pathname === '/events') { res.setHeader('content-type', 'text/event-stream'); res.write('data: live\n\n'); return }
    const body = []; for await (const chunk of req) body.push(chunk)
    res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.concat(body))
  })
  upstream.on('connection', socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)) })
  upstream.on('upgrade', (req, socket, head) => {
    calls.push({ url: req.url, headers: req.headers })
    if (req.headers.cookie !== 'upstream=private-cookie') { socket.destroy(); return }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {}); if (head.length) socket.write(head); socket.pipe(socket)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`
  const chat = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`chat:${req.url}:${req.headers.cookie || ''}`) })
  await new Promise(resolve => chat.listen(0, '127.0.0.1', resolve))
  let clock = 100000
  const mobile = createMobileAccess({ connection: { authenticatedUrl: base => base + '?token=private-launch-token' },
    webServer: () => ({ getOrigin: () => upstreamOrigin }), chat: async () => ({ port: chat.address().port }),
    config: { host: '127.0.0.1', port: 0, ...options }, interfaces: controls.interfaces, now: () => clock })
  t.after(async () => { await mobile.dispose(); for (const socket of peers) socket.destroy(); await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => chat.close(resolve))]) })
  const opened = await mobile.call('open', { host: controls.host })
  const origin = new URL(opened.url).origin
  const pair = async (url = opened.url) => {
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('world-pair')
    return fetch(origin + '/_world_mobile/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  }
  const login = async () => { const response = await pair(); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0] }
  return { mobile, origin, opened, pair, login, calls, upstreamOrigin, setNow: value => { clock = value } }
}
test('phone entry pairs once, streams the real page, and keeps native credentials on the computer', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.origin + '/api/test')).status, 401)
  const landing = await (await fetch(f.origin)).text()
  assert.match(landing, /world-pair/); assert.doesNotMatch(landing, /private-launch-token|real world/)
  const cookie = await f.login()
  assert.doesNotMatch(cookie, /private-cookie/)
  assert.equal((await f.pair()).status, 401)
  const page = await (await fetch(f.origin, { headers: { cookie } })).text()
  assert.match(page, /real world/); assert.match(page, /__WORLD_MOBILE_ACCESS__/)
  assert.doesNotMatch(page, /private-launch-token|private-cookie/)
  const bytes = Buffer.from([0, 255, 3, 9])
  const response = await fetch(f.origin + '/api/test?x=1', { method: 'POST', headers: { cookie, origin: f.origin, authorization: 'untrusted', 'x-forwarded-host': 'evil' }, body: bytes })
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const call = f.calls.at(-1)
  assert.equal(call.headers.host, new URL(f.upstreamOrigin).host)
  assert.equal(call.headers.origin, f.upstreamOrigin)
  assert.equal(call.headers.authorization, undefined); assert.equal(call.headers['x-forwarded-host'], undefined)
  const redirect = await fetch(f.origin + '/redirect', { redirect: 'manual', headers: { cookie } })
  assert.equal(redirect.headers.get('location'), f.origin + '/')
  assert.equal(redirect.headers.get('set-cookie'), null)
  const chat = await (await fetch(f.origin + '/_world_mobile/lan-chat/api/state', { headers: { cookie } })).text()
  assert.equal(chat, 'chat:/api/state:')
})
test('pairing rejects concurrent redemption, expired or replaced codes, and revoked sessions', async t => {
  const f = await fixture(t, { pairMs: 1000, sessionMs: 1000 })
  const attempts = await Promise.all([f.pair(), f.pair()])
  assert.deepEqual(attempts.map(row => row.status).sort(), [200, 401])
  const cookie = attempts.find(row => row.status === 200).headers.get('set-cookie').split(';')[0]
  f.setNow(101001)
  assert.equal((await fetch(f.origin + '/api/test', { headers: { cookie } })).status, 401)
  const old = await f.mobile.call('open', {})
  const current = await f.mobile.call('open', {})
  assert.equal((await f.pair(old.url)).status, 401)
  f.setNow(102002)
  assert.equal((await f.pair(current.url)).status, 401)
})
test('rejects cross-site origins, wrong Host, opaque origins and attempts to access the launch token', async t => {
  const f = await fixture(t), cookie = await f.login()
  for (const extra of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(f.origin + '/api/test', { headers: { cookie, ...extra } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
    })
    assert.equal(status, 403, JSON.stringify(extra))
  }
  for (const pathname of ['/api/world-mobile/open', '/api/world-mobile/addresses', '/connect', '/?token=x']) assert.equal((await fetch(f.origin + pathname, { headers: { cookie } })).status, 403)
  assert.equal((await fetch(f.origin + '/_world_mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' })).status, 400)
})
test('streams SSE without buffering and closes it at session expiry', async t => {
  const f = await fixture(t, { sessionMs: 1000 }), cookie = await f.login()
  const response = await fetch(f.origin + '/events', { headers: { cookie } })
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: live\n\n')
  f.setNow(101001)
  await fetch(f.origin + '/api/test', { headers: { cookie } })
  await assert.rejects(reader.read())
})
test('WebSocket upgrade authenticates, preserves initial bytes and closes when service stops', async t => {
  const f = await fixture(t), cookie = await f.login(), port = Number(new URL(f.origin).port)
  async function connect(cookieHeader = '') {
    const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {})
    await once(socket, 'connect')
    socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${f.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${cookieHeader}\r\n\r\ninitial`)
    return socket
  }
  const unauthorized = await connect()
  assert.match((await once(unauthorized, 'data'))[0].toString(), /403/); unauthorized.destroy()
  const socket = await connect(cookie)
  let text = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upgrade timeout')), 3000)
    socket.on('data', bytes => { text += bytes; if (text.includes('initial')) { clearTimeout(timer); resolve() } })
  })
  assert.match(text, /101 Switching Protocols/)
  assert.equal(f.calls.at(-1).headers.cookie, 'upstream=private-cookie')
  const closed = once(socket, 'close'); await f.mobile.dispose(); await closed
})
test('selects one physical interface, supports an explicit IP, and rejects an ambiguous address', () => {
  const rows = { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }], 'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }] }
  assert.equal(mobileBindAddress('', rows), '192.168.1.2')
  assert.deepEqual(mobileNetworkAddresses(rows), [{ name: 'Ethernet', address: '192.168.1.2' }])
  assert.equal(mobileBindAddress('::1', {}), '::1')
  assert.throws(() => mobileBindAddress('0.0.0.0'), /具体/)
  assert.throws(() => mobileBindAddress('', { ...rows, WiFi: [{ family: 'IPv4', internal: false, address: '192.168.2.2' }] }), /多个/)
})
test('unconfigured multi-interface hosts expose a named choice and preserve sessions when another address is selected', async t => {
  let rows = { Ethernet: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }],
    WiFi: [{ family: 'IPv4', internal: false, address: '127.0.0.2' }] }
  const f = await fixture(t, { host: '' }, { interfaces: () => rows, host: '127.0.0.1' })
  const cookie = await f.login()
  const choices = await f.mobile.call('addresses', {})
  assert.equal(choices.configured, false)
  assert.equal(choices.selectedHost, '127.0.0.1')
  assert.deepEqual(choices.addresses, [{ name: 'Ethernet', address: '127.0.0.1' }, { name: 'WiFi', address: '127.0.0.2' }])
  const second = await f.mobile.call('open', { host: '127.0.0.2' })
  assert.equal(new URL(second.url).hostname, '127.0.0.2')
  assert.equal((await f.mobile.call('addresses', {})).selectedHost, '127.0.0.2')
  assert.equal((await fetch(f.origin, { headers: { cookie } })).status, 200, 'the first phone session stays alive')
  await assert.rejects(f.mobile.call('open', { host: '192.0.2.99' }), /已不可用/)
  rows = { Ethernet: rows.Ethernet }
  await assert.rejects(f.mobile.call('open', { host: '127.0.0.2' }), /已不可用/)
  assert.equal((await f.mobile.call('addresses', {})).selectedHost, '')
  const automatic = await f.mobile.call('open', {})
  assert.equal(new URL(automatic.url).hostname, '127.0.0.1')
})
test('an explicit configured address wins over the dropdown payload', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.mobile.call('addresses', {}), { configured: true, selectedHost: '127.0.0.1', addresses: [{ name: '已配置地址', address: '127.0.0.1' }] })
  assert.equal(new URL((await f.mobile.call('open', { host: '192.0.2.99' })).url).origin, f.origin)
})
test('multiple addresses are listed before any listener starts and wait for an explicit first choice', async () => {
  const mobile = createMobileAccess({ config: {}, interfaces: () => ({
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.3' }],
    WiFi: [{ family: 'IPv4', internal: false, address: '192.168.2.3' }],
  }) })
  try {
    const value = await mobile.call('addresses', {})
    assert.equal(value.configured, false); assert.equal(value.selectedHost, '')
    assert.equal(value.addresses.length, 2)
    await assert.rejects(mobile.call('open', {}), /下拉框/)
  } finally { await mobile.dispose() }
})
test('an unavailable Web service fails locally and can recover without disabling world', async () => {
  let web
  const mobile = createMobileAccess({ connection: {}, webServer: () => web, config: { host: '127.0.0.1', port: 0 } })
  await assert.rejects(mobile.call('open', {}), /网页入口/)
  await mobile.dispose()
  await assert.rejects(mobile.call('open', {}), /已停止/)
})
test('rejects malformed Unicode pairing tokens without throwing an internal error', async t => {
  const f = await fixture(t)
  const response = await fetch(f.origin + '/_world_mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '中'.repeat(43) }) })
  assert.equal(response.status, 401)
  assert.equal((await f.pair()).status, 200)
})
