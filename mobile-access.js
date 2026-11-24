/**
 * Phone entry: a pairing key kept on disk so the QR survives a restart, plus a cached
 * upstream cookie per phone. The phone only ever holds the world key, never DSH credentials.
 */
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createMobileProxy, upstreamRequest } from './mobile-proxy.js'

const PREFIX = '/_world_mobile/'
/** Upstream cookie cache. Longer than a page session, shorter than a visible DSH login expiry. */
const SESSION_MS = 2 * 60 * 60 * 1000, COOKIE_AGE = 365 * 24 * 60 * 60
const KEY = /^[A-Za-z0-9_-]{43}$/
const failure = message => Object.assign(new Error(message), { code: 'WORLD_MOBILE' })
const random = () => randomBytes(32).toString('base64url')
const cookieName = port => `world_mobile_${port}`
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && KEY.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function mobileNetworkAddresses(interfaces = networkInterfaces()) {
  const seen = new Set()
  // Interface names are platform/user-defined. A VPN can be the phone's usable route,
  // so classify addresses rather than rejecting names such as VPN, en0 or tun0.
  return Object.entries(interfaces || {}).flatMap(([name, rows]) => (Array.isArray(rows) ? rows : [])
    .filter(row => row && (row.family === 'IPv4' || row.family === 4) && !row.internal && typeof row.address === 'string' && isIP(row.address) === 4)
    .filter(row => {
      const [a, b] = row.address.split('.').map(Number)
      return a !== 0 && a < 224 && !(a === 169 && b === 254)
    }).map(row => ({ name, address: row.address })))
    .filter(row => { if (seen.has(row.address)) return false; seen.add(row.address); return true })
}
export function mobileBindAddress(override, interfaces = networkInterfaces()) {
  if (override) {
    if (!isIP(override) || ['0.0.0.0', '::'].includes(override)) throw failure('WORLD_MOBILE_HOST 需要填写电脑网卡的具体 IP 地址。')
    return override
  }
  const addresses = mobileNetworkAddresses(interfaces)
  if (addresses.length !== 1) throw failure(addresses.length ? '检测到多个网络地址，请在下拉框中选择手机可访问的电脑 IP。' : '未找到可用网络，请先连接 Wi-Fi 或有线网络。')
  return addresses[0].address
}
const PAIR_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 world</title></head><body><p id="message">请在电脑上打开「手机连接」，扫描二维码。</p><script>
const token=new URLSearchParams(location.hash.slice(1)).get('world-pair');history.replaceState(null,'','/');
if(token){document.getElementById('message').textContent='正在连接 world…';fetch('/_world_mobile/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('message').textContent='连接未完成。请确认电脑上的 DSH 仍在运行，然后重新扫码。'})}
</script></body></html>`

/**
 * The QR has to stay valid after a restart, so its key is a small file rather than memory.
 * Only a missing file means "first run"; any other read error is surfaced instead of
 * silently minting a new key that would invalidate the one already saved on the phone.
 */
export function createMobileCredential({ dir, io = {}, now = Date.now }) {
  const fs = { readFile, writeFile, mkdir, ...io }
  const file = join(dir, 'mobile.json')
  let state, loading
  async function save() {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  async function load() {
    let text
    try { text = await fs.readFile(file, 'utf8') }
    catch (error) { if (error?.code !== 'ENOENT') throw failure(`无法读取手机连接密钥，请检查 ${file} 的访问权限。`) }
    let stored = {}
    if (text) { try { stored = JSON.parse(text) } catch { stored = {} } }
    const token = typeof stored?.token === 'string' && KEY.test(stored.token) ? stored.token : random()
    state = {
      version: 1, token, createdAt: Number.isFinite(stored?.createdAt) ? stored.createdAt : now(),
      host: typeof stored?.host === 'string' && stored.host ? stored.host : '',
    }
    if (token !== stored?.token || state.host !== (stored?.host || '')) await save()
    return state
  }
  const credential = {
    file,
    get() {
      if (state) return Promise.resolve(state)
      if (!loading) loading = load().finally(() => { loading = null })
      return loading
    },
    async remember(host) {
      const value = await credential.get()
      if (value.host === host) return
      value.host = host
      await save()
    },
    async rotate() {
      const value = await credential.get()
      value.token = random(); value.createdAt = now()
      await save()
      return value
    },
  }
  return credential
}

/** Each explicitly selected interface keeps its own listener so changing the QR does not disconnect phones. */
export function createMobileAccess(options) {
  const { config = {}, interfaces = networkInterfaces, now = Date.now } = options
  const credential = options.credential ?? createMobileCredential({ dir: options.dir, io: options.io, now })
  const listeners = new Map()
  let selectedHost = '', restored = false, stopped = false
  async function restore() {
    if (restored) return
    const value = await credential.get()
    restored = true
    if (!selectedHost) selectedHost = value.host
  }
  async function open(payload, signal, remember = true) {
    if (stopped) throw failure('手机连接服务已停止。')
    signal?.throwIfAborted()
    await restore()
    if (stopped) throw failure('手机连接服务已停止。')
    const rows = interfaces()
    const addresses = config.host ? [{ name: '已配置地址', address: mobileBindAddress(config.host) }] : mobileNetworkAddresses(rows)
    let host = config.host
    if (!host) {
      host = payload?.host || (addresses.some(row => row.address === selectedHost) ? selectedHost : '') || mobileBindAddress('', rows)
      if (!addresses.some(row => row.address === host)) throw failure('所选网络地址已不可用，请重新打开手机连接后选择。')
    }
    if (!listeners.has(host)) listeners.set(host, createMobileListener({ ...options, credential, config: { ...config, host } }))
    const value = await listeners.get(host).call('open', {}, signal)
    if (remember) { await credential.remember(host); selectedHost = host }
    return value
  }
  async function startupHost() {
    await restore()
    if (config.host) return mobileBindAddress(config.host)
    if (!selectedHost || !mobileNetworkAddresses(interfaces()).some(row => row.address === selectedHost))
      throw failure('请先在「手机连接」选择可用网卡并生成二维码。')
    return selectedHost
  }
  return {
    startupHost,
    async startSaved(signal) {
      await restore()
      const host = config.host ? mobileBindAddress(config.host) : selectedHost
      if (!host) throw failure('请先在「手机连接」选定网卡。')
      // EasyTier may be starting alongside World. Wait for this exact interface and
      // the upstream web listener, not a replacement interface or an arbitrary address.
      const until = Date.now() + (options.startupWaitMs ?? 30000)
      for (;;) {
        signal?.throwIfAborted(); if (stopped) return
        const hasHost = config.host || mobileNetworkAddresses(interfaces()).some(row => row.address === host)
        let origin
        try { origin = options.webServer?.()?.getOrigin() } catch { /* web service not bound yet */ }
        if (hasHost && origin) {
          try { await open({host}, signal, false); return } catch (error) {
            // An explicit WORLD_MOBILE_HOST may be a VPN address not bound yet.
            if (error.cause?.code !== 'EADDRNOTAVAIL' || Date.now() >= until) throw error
          }
        }
        if (Date.now() >= until) throw failure(hasHost ? '网页入口尚未就绪，未自动启动手机连接。' : '上次选择的网卡不可用，未自动启动手机连接。')
        await new Promise(resolve => setTimeout(resolve,250))
      }
    },
    async call(operation, payload, signal) {
      if (stopped) throw failure('手机连接服务已停止。')
      signal?.throwIfAborted()
      if (!['addresses', 'open', 'reset'].includes(operation)) throw failure('不支持的手机连接操作。')
      if (operation === 'addresses') {
        await restore()
        const addresses = config.host ? [{ name: '已配置地址', address: mobileBindAddress(config.host) }] : mobileNetworkAddresses(interfaces())
        return { addresses, configured: Boolean(config.host),
          selectedHost: config.host || (addresses.some(row => row.address === selectedHost) ? selectedHost : '') }
      }
      const value = await open(payload, signal)
      if (operation === 'open') return value
      // Resetting is the only way to invalidate a link that never expires; the phone keeps
      // its key until the computer rotates it.
      await credential.rotate()
      await Promise.all([...listeners.values()].map(listener => listener.call('revoke')))
      const link = new URL(value.url)
      link.hash = `world-pair=${(await credential.get()).token}`
      return { url: link.toString(), persistent: true }
    },
    async dispose() {
      stopped = true
      await Promise.all([...listeners.values()].map(listener => listener.dispose()))
      listeners.clear()
    },
  }
}

function createMobileListener({ connection, webServer, chat, config = {}, interfaces, credential, now = Date.now }) {
  const sessions = new Map(), sockets = new Set(), pending = new Set()
  let server, starting, origin, upstream, proxy, stopped = false, sweep, establishing
  const sessionMs = config.sessionMs ?? SESSION_MS
  function track(session, resource) {
    session.resources.add(resource)
    resource.once('close', () => session.resources.delete(resource))
    return resource
  }
  function cookieValue(req) {
    if (!server) return ''
    const name = cookieName(server.address().port)
    return String(req.headers.cookie || '').split(';').map(row => row.trim()).find(row => row.startsWith(name + '='))?.slice(name.length + 1) || ''
  }
  function dropCache() { for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key) }
  function revokeAll() {
    for (const session of sessions.values()) { for (const resource of session.resources) resource.destroy(); session.resources.clear() }
    sessions.clear()
  }
  function trusted(req) {
    const expected = new URL(origin)
    if (req.headers.host?.toLowerCase() !== expected.host.toLowerCase() || req.headers['sec-fetch-site'] === 'cross-site') return false
    if (req.headers.origin !== undefined && req.headers.origin !== expected.origin) return false
    return true
  }
  function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body)
  }
  async function currentToken() { return (await credential.get()).token }
  async function authenticate() {
    const url = new URL(connection.authenticatedUrl(upstream.origin + '/'))
    if (url.origin !== upstream.origin || url.pathname !== '/') throw failure('DSH 网页认证地址不可用。')
    return new Promise((resolve, reject) => {
      const request = upstreamRequest(url, { method: 'GET', headers: { host: upstream.host } }, response => {
        const cookies = response.headers['set-cookie']
        const cookie = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : []).map(value => value.split(';')[0]).join('; ')
        response.resume()
        if (![302, 303].includes(response.statusCode) || !cookie) reject(failure('当前 DSH 未提供可用的网页认证，请检查宿主版本。'))
        else resolve(cookie)
      })
      pending.add(request)
      request.setTimeout(10000, () => request.destroy(failure('连接电脑超时，请重试。')))
      request.on('error', () => reject(failure('无法连接 DSH 网页入口。')))
      request.once('close', () => pending.delete(request)); request.end()
    })
  }
  /** A phone that kept its key gets its upstream cookie back without pairing again. */
  function ensureSession(token) {
    const cached = sessions.get(token)
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached)
    if (!establishing) {
      establishing = authenticate().then(cookie => {
        const session = { cookie, expiresAt: now() + sessionMs, resources: new Set() }
        sessions.set(token, session)
        return session
      }).finally(() => { establishing = null })
    }
    return establishing
  }
  async function pair(req, res) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { reply(res, 415, 'Invalid content type'); return }
    let bytes = 0, chunks = []
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 2048) { reply(res, 413, 'Request too large'); return }
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { reply(res, 400, 'Invalid JSON'); return }
    const token = await currentToken()
    if (stopped || !equal(value?.token, token)) { reply(res, 401, '链接无效或已重置，请在电脑上重新打开「手机连接」。'); return }
    try { await ensureSession(token) } catch { reply(res, 502, '连接电脑失败，请确认 DSH 仍在运行后重试。'); return }
    if (stopped || res.destroyed) return
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
      'set-cookie': `${cookieName(server.address().port)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_AGE}${origin.startsWith('https:') ? '; Secure' : ''}` })
    res.end('{"ok":true}')
  }
  async function handler(req, res) {
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!trusted(req)) { reply(res, 403, 'Forbidden'); return }
    // Parse against a placeholder; absolute-form requests must never select another upstream.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { reply(res, 400, 'Invalid path'); return }
    const url = new URL(req.url, origin)
    if (url.origin !== origin) { reply(res, 400, 'Invalid path'); return }
    if (url.pathname === PREFIX + 'pair' && req.method === 'POST') { await pair(req, res); return }
    const token = cookieValue(req)
    let session
    if (equal(token, await currentToken())) {
      try { session = await ensureSession(token) }
      catch { if (!res.destroyed) reply(res, 502, '连接电脑失败，请稍后重试或重新扫码。'); return }
    }
    if (!session) {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); res.end(PAIR_PAGE)
      } else reply(res, 401, '请重新扫描电脑上的二维码。')
      return
    }
    if (url.pathname.startsWith('/api/world-mobile/') || url.pathname === '/connect' || url.searchParams.has('token')) { reply(res, 403, 'Forbidden'); return }
    if (url.pathname.startsWith(PREFIX + 'lan-chat/')) {
      const info = await chat()
      const target = new URL(`http://127.0.0.1:${info.port}/`)
      target.pathname = url.pathname.slice((PREFIX + 'lan-chat').length)
      target.search = url.search
      // Only paired phones reach this branch; the owner cookie stays on the host.
      proxy.forward(req, res, target, session, info.cookie || '')
    } else if (url.pathname.startsWith(PREFIX)) reply(res, 404, 'Not found')
    else {
      const target = new URL(upstream)
      target.pathname = url.pathname; target.search = url.search
      proxy.forward(req, res, target, session)
    }
  }
  async function upgrade(req, socket, head) {
    socket.on('error', () => {})
    const refuse = () => { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') }
    if (!trusted(req) || req.url !== '/api/remote.mux' || req.headers.upgrade?.toLowerCase() !== 'websocket') return refuse()
    const token = cookieValue(req)
    if (!equal(token, await currentToken())) return refuse()
    let session
    try { session = await ensureSession(token) } catch { return refuse() }
    if (socket.destroyed) return
    proxy.upgrade(req, socket, head, new URL('/api/remote.mux', upstream), session)
  }
  async function start() {
    if (stopped) throw failure('手机连接服务已停止。')
    const web = webServer()
    if (!web?.getOrigin || !connection?.authenticatedUrl) throw failure('当前 DSH 未启用网页入口，无法连接手机。')
    upstream = new URL(web.getOrigin())
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw failure('DSH 网页地址不可用。')
    const host = mobileBindAddress(config.host, interfaces?.())
    const port = Number(config.port ?? 53319)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('WORLD_MOBILE_PORT 需要填写 0 到 65535 的端口。')
    let tls
    if (config.certFile || config.keyFile) {
      if (!config.certFile || !config.keyFile) throw failure('HTTPS 需要同时配置证书和私钥文件。')
      tls = { cert: await readFile(config.certFile), key: await readFile(config.keyFile) }
    }
    server = tls ? https.createServer(tls) : http.createServer()
    const instance = server
    instance.on('request', (req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) reply(res, 502, '连接未完成，请稍后重试。'); else res.destroy() }) })
    instance.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    instance.on('clientError', (_error, socket) => socket.destroy())
    instance.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head).catch(() => socket.destroy()) })
    await new Promise((resolve, reject) => {
      instance.once('error', reject)
      instance.listen(port, host, () => { instance.removeListener('error', reject); resolve() })
    })
    origin = new URL(`${tls ? 'https' : 'http'}://${isIP(host) === 6 ? `[${host}]` : host}:${instance.address().port}`).origin
    if (config.publicOrigin) {
      const publicUrl = new URL(config.publicOrigin)
      if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw failure('WORLD_MOBILE_ORIGIN 必须是完整的根地址，例如 https://world.example.com。')
      origin = publicUrl.origin
    }
    if (stopped) throw failure('手机连接服务已停止。')
    proxy = createMobileProxy({ origin, track })
    instance.on('error', () => { for (const socket of sockets) socket.destroy() })
    sweep = setInterval(dropCache, 1000); sweep.unref?.()
  }
  return {
    async call(operation, _payload, signal) {
      if (!['open', 'revoke'].includes(operation)) throw failure('不支持的手机连接操作。')
      if (operation === 'revoke') { revokeAll(); return { ok: true } }
      signal?.throwIfAborted()
      if (!starting) starting = start().catch(async error => {
        for (const socket of sockets) socket.destroy()
        if (server?.listening) await new Promise(resolve => server.close(resolve))
        server = null; starting = null
        throw Object.assign(failure(error.code === 'EADDRINUSE' ? '手机连接端口已被占用，请设置 WORLD_MOBILE_PORT 后重启。' : error.code === 'EACCES' ? '无法监听该网络地址，请检查端口权限。' : error.code === 'WORLD_MOBILE' ? error.message : '手机连接入口启动失败，请检查网络地址和证书配置。'), {cause:error})
      })
      await starting
      signal?.throwIfAborted()
      if (stopped) throw failure('手机连接服务已停止。')
      return { url: `${origin}/#world-pair=${await currentToken()}`, persistent: true }
    },
    async dispose() {
      stopped = true; clearInterval(sweep)
      revokeAll()
      for (const request of pending) request.destroy()
      for (const socket of sockets) socket.destroy()
      if (starting) await starting.catch(() => {})
      clearInterval(sweep)
      if (server?.listening) await new Promise(resolve => server.close(resolve))
    },
  }
}
