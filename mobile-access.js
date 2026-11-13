/** On-demand mobile browser access to this Host, with one-use pairing and a private upstream cookie jar. */
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createMobileProxy, upstreamRequest } from './mobile-proxy.js'

const PREFIX = '/_world_mobile/'
const PAIR_MS = 5 * 60 * 1000, SESSION_MS = 8 * 60 * 60 * 1000
const failure = message => Object.assign(new Error(message), { code: 'WORLD_MOBILE' })
const random = () => randomBytes(32).toString('base64url')
const cookieName = port => `world_mobile_${port}`
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function mobileNetworkAddresses(interfaces = networkInterfaces()) {
  const seen = new Set()
  return Object.entries(interfaces).filter(([name]) => !/loopback|vethernet|vmware|virtualbox|docker|wsl|tailscale|vpn/i.test(name))
    .flatMap(([name, rows]) => (rows || []).filter(row => (row.family === 'IPv4' || row.family === 4) && !row.internal && !row.address.startsWith('169.254.'))
      .map(row => ({ name, address: row.address })))
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
if(token){document.getElementById('message').textContent='正在连接 world…';fetch('/_world_mobile/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('message').textContent='连接未完成或二维码已过期，请重新扫码。'})}
</script></body></html>`

/** Each explicitly selected interface keeps its own listener so changing the QR does not disconnect phones. */
export function createMobileAccess(options) {
  const { config = {}, interfaces = networkInterfaces } = options
  const listeners = new Map()
  let selectedHost = '', stopped = false
  return {
    async call(operation, payload, signal) {
      if (stopped) throw failure('手机连接服务已停止。')
      signal?.throwIfAborted()
      if (!['addresses', 'open'].includes(operation)) throw failure('不支持的手机连接操作。')
      const rows = interfaces()
      const addresses = config.host ? [{ name: '已配置地址', address: mobileBindAddress(config.host) }] : mobileNetworkAddresses(rows)
      if (operation === 'addresses') return { addresses, configured: Boolean(config.host),
        selectedHost: config.host || (addresses.some(row => row.address === selectedHost) ? selectedHost : '') }
      let host = config.host
      if (!host) {
        host = payload?.host || (addresses.some(row => row.address === selectedHost) ? selectedHost : '') || mobileBindAddress('', rows)
        if (!addresses.some(row => row.address === host)) throw failure('所选网络地址已不可用，请重新打开手机连接后选择。')
      }
      if (!listeners.has(host)) listeners.set(host, createMobileListener({ ...options, config: { ...config, host } }))
      const value = await listeners.get(host).call('open', {}, signal)
      selectedHost = host
      return value
    },
    async dispose() {
      stopped = true
      await Promise.all([...listeners.values()].map(listener => listener.dispose()))
      listeners.clear()
    },
  }
}

function createMobileListener({ connection, webServer, chat, config = {}, interfaces, now = Date.now }) {
  const sessions = new Map(), sockets = new Set(), pending = new Set()
  let server, starting, origin, upstream, pairing, proxy, stopped = false, sweep
  const pairMs = config.pairMs ?? PAIR_MS, sessionMs = config.sessionMs ?? SESSION_MS
  function track(session, resource) {
    session.resources.add(resource)
    resource.once('close', () => session.resources.delete(resource))
    return resource
  }
  function revoke(id, session) { sessions.delete(id); for (const resource of session.resources) resource.destroy(); session.resources.clear() }
  function expire() { for (const [id, session] of sessions) if (session.expiresAt <= now()) revoke(id, session) }
  function browserSession(req) {
    expire()
    const name = cookieName(server.address().port)
    const token = String(req.headers.cookie || '').split(';').map(row => row.trim()).find(row => row.startsWith(name + '='))?.slice(name.length + 1)
    return token ? sessions.get(token) : undefined
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
    const current = pairing
    if (!current || current.busy || current.expiresAt <= now() || !equal(value?.token, current.token)) { reply(res, 401, '二维码已过期或已使用，请重新扫码。'); return }
    expire()
    if (sessions.size >= 16) { reply(res, 429, '连接数量已达上限，请稍后重试。'); return }
    current.busy = true
    try {
      const cookie = await authenticate()
      if (stopped || pairing !== current || current.expiresAt <= now() || res.destroyed) throw failure('二维码已更新，请重新扫码。')
      const token = random(), session = { cookie, expiresAt: now() + sessionMs, resources: new Set() }
      sessions.set(token, session); pairing = null
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'set-cookie': `${cookieName(server.address().port)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionMs / 1000)}${origin.startsWith('https:') ? '; Secure' : ''}` })
      res.end('{"ok":true}')
    } finally { current.busy = false }
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
    const session = browserSession(req)
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
      proxy.forward(req, res, target, session, '')
    } else if (url.pathname.startsWith(PREFIX)) reply(res, 404, 'Not found')
    else {
      const target = new URL(upstream)
      target.pathname = url.pathname; target.search = url.search
      proxy.forward(req, res, target, session)
    }
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
    instance.on('request', (req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) reply(res, 502, '连接未完成，请重新扫码或稍后重试。'); else res.destroy() }) })
    instance.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    instance.on('clientError', (_error, socket) => socket.destroy())
    instance.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {})
      const session = trusted(req) && browserSession(req)
      if (!session || req.url !== '/api/remote.mux' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      proxy.upgrade(req, socket, head, new URL('/api/remote.mux', upstream), session)
    })
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
    sweep = setInterval(expire, 1000); sweep.unref?.()
  }
  return {
    async call(operation, _payload, signal) {
      if (operation !== 'open') throw failure('不支持的手机连接操作。')
      signal?.throwIfAborted()
      if (!starting) starting = start().catch(async error => {
        for (const socket of sockets) socket.destroy()
        if (server?.listening) await new Promise(resolve => server.close(resolve))
        server = null; starting = null
        throw failure(error.code === 'EADDRINUSE' ? '手机连接端口已被占用，请设置 WORLD_MOBILE_PORT 后重启。' : error.code === 'EACCES' ? '无法监听该网络地址，请检查端口权限。' : error.code === 'WORLD_MOBILE' ? error.message : '手机连接入口启动失败，请检查网络地址和证书配置。')
      })
      await starting
      signal?.throwIfAborted()
      if (stopped) throw failure('手机连接服务已停止。')
      pairing = { token: random(), expiresAt: now() + pairMs, busy: false }
      return { url: `${origin}/#world-pair=${pairing.token}`, expiresAt: pairing.expiresAt }
    },
    async dispose() {
      stopped = true; pairing = null; clearInterval(sweep)
      for (const [id, session] of sessions) revoke(id, session)
      for (const request of pending) request.destroy()
      for (const socket of sockets) socket.destroy()
      if (starting) await starting.catch(() => {})
      clearInterval(sweep)
      if (server?.listening) await new Promise(resolve => server.close(resolve))
    },
  }
}
