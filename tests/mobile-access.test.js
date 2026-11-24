import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWorldStartup } from '../world-startup.js'
import { atomic } from './journal-fixture.mjs'
import { createMobileAccess, createMobileCredential, mobileBindAddress, mobileNetworkAddresses } from '../mobile-access.js'

async function fixture(t, options = {}, controls = {}) {
  const calls = [], chatCalls = [], peers = new Set()
  const dir = options.dir || await mkdtemp(join(tmpdir(), 'world-mobile-'))
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
  const chat = http.createServer((req, res) => {
    chatCalls.push({ url: req.url, headers: req.headers })
    res.setHeader('content-type', 'text/plain'); res.end(`chat:${req.url}:${req.headers.cookie || ''}`)
  })
  await new Promise(resolve => chat.listen(0, '127.0.0.1', resolve))
  let clock = 100000
  const mobile = createMobileAccess({ connection: { authenticatedUrl: base => base + '?token=private-launch-token' },
    webServer: () => ({ getOrigin: () => upstreamOrigin }), chat: async () => ({ port: chat.address().port, cookie: controls.chatCookie }),
    dir, config: { host: '127.0.0.1', port: 0, ...options }, interfaces: controls.interfaces, now: () => clock })
  t.after(async () => {
    await mobile.dispose()
    for (const socket of peers) socket.destroy()
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => chat.close(resolve))])
    if (!options.dir) await rm(dir, { recursive: true, force: true })
  })
  const opened = await mobile.call('open', { host: controls.host })
  const origin = new URL(opened.url).origin
  const pair = async (url = opened.url) => {
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('world-pair')
    return fetch(origin + '/_world_mobile/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  }
  const login = async () => { const response = await pair(); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0] }
  const authenticated = () => calls.filter(row => row.url.includes('private-launch-token')).length
  return { mobile, dir, origin, opened, pair, login, calls, chatCalls, authenticated, upstreamOrigin, setNow: value => { clock = value } }
}

test('only a paired phone can use the host-owned chat credential', async t => {
  const f = await fixture(t, {}, { chatCookie: 'world_chat=host-private' })
  const path = '/_world_mobile/lan-chat/api/state'
  assert.equal((await fetch(f.origin + path)).status, 401)
  assert.equal(f.chatCalls.length, 0)
  const cookie = await f.login()
  assert.equal((await fetch(f.origin + path, { headers: { cookie: cookie + '; world_chat=forged' } })).status, 200)
  assert.equal(f.chatCalls.at(-1).headers.cookie, 'world_chat=host-private')
})
test('phone entry pairs, streams the real page, and keeps native credentials on the computer', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.origin + '/api/test')).status, 401)
  const landing = await (await fetch(f.origin)).text()
  assert.match(landing, /world-pair/); assert.doesNotMatch(landing, /private-launch-token|real world/)
  const cookie = await f.login()
  assert.doesNotMatch(cookie, /private-cookie/)
  assert.equal((await f.pair()).status, 200, 'the same code may pair another phone')
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
test('the QR keeps its code and an existing phone cookie survives a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = await fixture(t, { dir })
  const cookie = await first.login(), port = Number(new URL(first.origin).port)
  await first.mobile.dispose()
  const second = await fixture(t, { dir, port })
  assert.equal(second.opened.url, first.opened.url, 'the QR is byte-identical after a restart')
  const page = await fetch(second.origin, { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /real world/)
})
test('resetting rotates the code and locks out the phones that used the old one', async t => {
  const f = await fixture(t)
  const cookie = await f.login()
  assert.equal((await fetch(f.origin, { headers: { cookie } })).status, 200)
  const reset = await f.mobile.call('reset', {})
  assert.notEqual(reset.url, f.opened.url)
  assert.equal(reset.persistent, true)
  assert.equal((await fetch(f.origin + '/api/test', { headers: { cookie } })).status, 401)
  assert.match(await (await fetch(f.origin, { headers: { cookie } })).text(), /world-pair/, 'the phone is sent back to the pairing page')
  assert.equal((await f.pair()).status, 401, 'the old code no longer pairs')
  const token = new URLSearchParams(new URL(reset.url).hash.slice(1)).get('world-pair')
  const response = await fetch(f.origin + '/_world_mobile/pair', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  assert.equal(response.status, 200)
  assert.equal((await fetch(f.origin, { headers: { cookie: response.headers.get('set-cookie').split(';')[0] } })).status, 200)
})
test('the cached upstream cookie is renewed without asking for a new code', async t => {
  const f = await fixture(t, { sessionMs: 1000 }), cookie = await f.login()
  const before = f.authenticated()
  f.setNow(101001)
  assert.equal((await fetch(f.origin + '/api/test', { headers: { cookie } })).status, 200)
  assert.equal(f.authenticated(), before + 1, 'the phone is authenticated again on the computer side')
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
  for (const pathname of ['/api/world-mobile/open', '/api/world-mobile/addresses', '/api/world-mobile/reset', '/connect', '/?token=x']) assert.equal((await fetch(f.origin + pathname, { headers: { cookie } })).status, 403)
  assert.equal((await fetch(f.origin + '/_world_mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' })).status, 400)
})
test('streams SSE without buffering', async t => {
  const f = await fixture(t), cookie = await f.login()
  const response = await fetch(f.origin + '/events', { headers: { cookie } })
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: live\n\n')
  await reader.cancel()
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
test('lists physical and virtual interfaces, supports an explicit IP, and rejects an ambiguous address', () => {
  const rows = { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }], 'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }] }
  assert.throws(() => mobileBindAddress('', rows), /多个/)
  assert.deepEqual(mobileNetworkAddresses(rows), [{ name: 'Ethernet', address: '192.168.1.2' }, { name: 'vEthernet (WSL)', address: '172.20.0.1' }])
  assert.equal(mobileBindAddress('::1', {}), '::1')
  assert.throws(() => mobileBindAddress('0.0.0.0'), /具体/)
  assert.throws(() => mobileBindAddress('', { ...rows, WiFi: [{ family: 'IPv4', internal: false, address: '192.168.2.2' }] }), /多个/)
})

test('IP choices use address metadata across Windows, macOS and Linux and retain VPN routes', () => {
  const row = (address, extra = {}) => ({ family: 'IPv4', internal: false, address, ...extra })
  const fixtures = [
    { '以太网': [row('192.168.1.3')], 'EasyTier VPN': [row('10.192.168.3', { family: 4 })],
      'Loopback Pseudo-Interface 1': [row('127.0.0.1', { internal: true })] },
    { en0: [row('192.168.1.3')], utun8: [row('10.192.168.3')], lo0: [row('127.0.0.1', { internal: true })] },
    { enp3s0: [row('192.168.1.3')], tun0: [row('10.192.168.3')], lo: [row('127.0.0.1', { internal: true })] },
  ]
  for (const interfaces of fixtures) {
    interfaces.duplicate = [row('192.168.1.3')]
    interfaces.invalid = [row('169.254.2.3'), row('0.0.0.0'), row('224.0.0.1'), row('255.255.255.255'),
      row('invalid'), row('fe80::1', { family: 'IPv6' }), null]
    interfaces.unavailable = undefined
    assert.deepEqual(mobileNetworkAddresses(interfaces).map(item => item.address), ['192.168.1.3', '10.192.168.3'])
    assert.throws(() => mobileBindAddress('', interfaces), /多个/)
  }
  assert.deepEqual(mobileNetworkAddresses(null), [])
  assert.equal(mobileBindAddress('', { en0: [row('192.168.1.3')] }), '192.168.1.3')
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
  assert.equal(new URL(second.url).hash, new URL(f.opened.url).hash, 'another interface keeps the same pairing key')
  assert.equal((await f.mobile.call('addresses', {})).selectedHost, '127.0.0.2')
  assert.equal((await fetch(f.origin, { headers: { cookie } })).status, 200, 'the first phone session stays alive')
  await assert.rejects(f.mobile.call('open', { host: '192.0.2.99' }), /已不可用/)
  rows = { Ethernet: rows.Ethernet }
  await assert.rejects(f.mobile.call('open', { host: '127.0.0.2' }), /已不可用/)
  assert.equal((await f.mobile.call('addresses', {})).selectedHost, '')
  const automatic = await f.mobile.call('open', {})
  assert.equal(new URL(automatic.url).hostname, '127.0.0.1')
})
test('the chosen interface is remembered on disk for the next start', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const rows = { Ethernet: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }],
    WiFi: [{ family: 'IPv4', internal: false, address: '127.0.0.2' }] }
  const first = await fixture(t, { dir, host: '' }, { interfaces: () => rows, host: '127.0.0.2' })
  await first.mobile.call('open', { host: '127.0.0.2' })
  await new Promise(resolve => setTimeout(resolve, 50))
  await first.mobile.dispose()
  const second = await fixture(t, { dir, host: '', port: Number(new URL(first.origin).port) }, { interfaces: () => rows })
  t.after(async () => { await second.mobile.dispose() })
  assert.equal((await second.mobile.call('addresses', {})).selectedHost, '127.0.0.2')
})
test('a saved mobile startup opens the same QR without a client, and never falls back to another interface',async t=>{
  const local='127.0.0.1', rows={lan:[{family:'IPv4',internal:false,address:local}]}
  const first=await fixture(t,{host:''},{interfaces:()=>rows,host:local})
  const port=Number(new URL(first.origin).port)
  const cookie=await first.login()
  const registry=mobile=>{
    const reg=createWorldStartup({dir:first.dir,atomic})
    reg.register('mobile',{name:'手机连接',initial:'removed',start:mobile.startSaved,validate:mobile.startupHost});return reg
  }
  await registry(first.mobile).call('set',{id:'mobile',state:'enabled'})
  await first.mobile.dispose()
  let web=null, available={}
  const options={dir:first.dir,config:{port},webServer:()=>web,connection:{authenticatedUrl:s=>s+'?token=private-launch-token'},interfaces:()=>available}
  const second=createMobileAccess(options), preferences=registry(second)
  try {
    const started=preferences.run('mobile');const ready=setTimeout(()=>{web={getOrigin:()=>first.upstreamOrigin};available=rows},50)
    try {await started} finally {clearTimeout(ready)}
    // No desktop page or manual open request. The existing paired phone is still logged in.
    const phone=()=>fetch(first.origin,{headers:{cookie}}).then(r=>r.text())
    assert.match(await phone(),/real world/)
    await preferences.call('set',{id:'mobile',state:'removed'})
    assert.match(await phone(),/real world/);assert.equal((await second.call('open',{})).url,first.opened.url)
  } finally {await second.dispose()}
  const changed=createMobileAccess({...options,startupWaitMs:0,interfaces:()=>({another:[{family:'IPv4',internal:false,address:'127.0.0.2'}]})})
  await registry(changed).run('mobile');assert.equal((await registry(changed).call('get',{id:'mobile'})).state,'removed')
  try {await assert.rejects(changed.startSaved(),/网卡/)} finally {await changed.dispose()}
})
test('an explicit configured address wins over the dropdown payload', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.mobile.call('addresses', {}), { configured: true, selectedHost: '127.0.0.1', addresses: [{ name: '已配置地址', address: '127.0.0.1' }] })
  assert.equal(new URL((await f.mobile.call('open', { host: '192.0.2.99' })).url).origin, f.origin)
})
test('multiple addresses are listed before any listener starts and wait for an explicit first choice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-empty-'))
  const mobile = createMobileAccess({ dir, config: {}, interfaces: () => ({
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.3' }],
    WiFi: [{ family: 'IPv4', internal: false, address: '192.168.2.3' }],
  }) })
  try {
    const value = await mobile.call('addresses', {})
    assert.equal(value.configured, false); assert.equal(value.selectedHost, '')
    assert.equal(value.addresses.length, 2)
    await assert.rejects(mobile.call('open', {}), /下拉框/)
  } finally { await mobile.dispose(); await rm(dir, { recursive: true, force: true }) }
})
test('an unavailable Web service fails locally and can recover without disabling world', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-web-'))
  let web
  const mobile = createMobileAccess({ dir, connection: {}, webServer: () => web, config: { host: '127.0.0.1', port: 0 } })
  await assert.rejects(mobile.call('open', {}), /网页入口/)
  await mobile.dispose()
  await assert.rejects(mobile.call('open', {}), /已停止/)
  await rm(dir, { recursive: true, force: true })
})
test('rejects malformed Unicode pairing tokens without throwing an internal error', async t => {
  const f = await fixture(t)
  const response = await fetch(f.origin + '/_world_mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '中'.repeat(43) }) })
  assert.equal(response.status, 401)
  assert.equal((await f.pair()).status, 200)
})
test('the pairing key is written once and reused by the next process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-credential-'))
  try {
    const first = createMobileCredential({ dir })
    const value = await first.get()
    assert.match(value.token, /^[A-Za-z0-9_-]{43}$/)
    const stored = JSON.parse(await readFile(first.file, 'utf8'))
    assert.equal(stored.token, value.token)
    assert.equal(stored.version, 1)
    assert.equal((await createMobileCredential({ dir }).get()).token, value.token)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('rotating the key replaces the stored one and keeps the chosen interface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-rotate-'))
  try {
    const credential = createMobileCredential({ dir })
    const before = (await credential.get()).token
    await credential.remember('192.168.1.7')
    const after = await credential.rotate()
    assert.notEqual(after.token, before)
    assert.equal(after.host, '192.168.1.7')
    const reopened = await createMobileCredential({ dir }).get()
    assert.equal(reopened.token, after.token)
    assert.equal(reopened.host, '192.168.1.7')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('a key file that cannot be read is reported instead of being silently replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-mobile-denied-'))
  try {
    const credential = createMobileCredential({ dir, io: { readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } } })
    await assert.rejects(credential.get(), /无法读取手机连接密钥/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
