/** Fixed-upstream streaming HTTP / WebSocket bridge. Authentication belongs to mobile-access. */
import http from 'node:http'
import https from 'node:https'

const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
function headersOf(headers) {
  const skip = new Set([...HOP, ...String(headers.connection || '').toLowerCase().split(',').map(name => name.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !skip.has(name.toLowerCase())))
}
export function upstreamRequest(url, options, receive) {
  return (url.protocol === 'https:' ? https : http).request(url, options, receive)
}
function requestHeaders(req, target, cookie) {
  const headers = headersOf(req.headers)
  for (const name of Object.keys(headers)) if (/^(?:forwarded|x-forwarded-|authorization$|cookie$|host$|origin$)/i.test(name)) delete headers[name]
  headers.host = target.host
  if (req.headers.origin) headers.origin = target.origin
  if (cookie) headers.cookie = cookie
  headers['accept-encoding'] = 'identity'
  return headers
}
const MOBILE_BOOT = '<script>globalThis.__WORLD_MOBILE_ACCESS__=true;if(new URLSearchParams(location.hash.slice(1)).has("world-pair"))history.replaceState(null,"","/");</script>'
export function createMobileProxy({ origin, track }) {
  function responseHeaders(upstream, target) {
    const headers = headersOf(upstream.headers)
    delete headers['set-cookie']
    if (headers.location) {
      const url = new URL(headers.location, target)
      if (url.origin === target.origin) { url.searchParams.delete('token'); headers.location = `${origin}${url.pathname}${url.search}${url.hash}` }
    }
    return headers
  }
  function forward(req, res, target, session, cookie = session.cookie) {
    let headerTimer
    const fail = () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('电脑连接暂时不可用，请稍后重试。') }
    const upstream = upstreamRequest(target, { method: req.method, headers: requestHeaders(req, target, cookie) }, incoming => {
      clearTimeout(headerTimer)
      const headers = responseHeaders(incoming, target)
      const index = ['/', '/index.html'].includes(target.pathname) && /text\/html/i.test(headers['content-type'] || '') && incoming.statusCode === 200 && req.method !== 'HEAD'
      if (index) {
        const chunks = []; let size = 0
        incoming.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) upstream.destroy(); else chunks.push(chunk) })
        incoming.on('end', () => {
          if (size > 8 * 1024 * 1024 || res.destroyed) return
          const html = Buffer.concat(chunks).toString('utf8').replace(/<head(?:\s[^>]*)?>/i, match => match + MOBILE_BOOT)
          delete headers['content-length']; delete headers['content-encoding']; delete headers.etag
          headers['cache-control'] = 'no-store'
          res.writeHead(incoming.statusCode, headers); res.end(html)
        })
      } else { res.writeHead(incoming.statusCode, headers); incoming.pipe(res) }
      incoming.on('error', () => res.destroy())
    })
    track(session, upstream)
    headerTimer = setTimeout(() => upstream.destroy(), 15000); headerTimer.unref?.()
    upstream.on('error', fail)
    upstream.once('close', () => clearTimeout(headerTimer))
    req.once('aborted', () => upstream.destroy())
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  function upgrade(req, socket, head, target, session) {
    const headers = { ...requestHeaders(req, target, session.cookie), connection: 'Upgrade', upgrade: 'websocket' }
    const upstream = upstreamRequest(target, { headers })
    const timer = setTimeout(() => upstream.destroy(), 15000); timer.unref?.()
    track(session, upstream); track(session, socket)
    socket.once('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    upstream.on('upgrade', (response, peer, initial) => {
      clearTimeout(timer); track(session, peer)
      const headers = responseHeaders(response, target)
      headers.connection = 'Upgrade'; headers.upgrade = 'websocket'
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}\r\n`)).join('')}\r\n`)
      if (initial.length) socket.write(initial)
      if (head.length) peer.write(head)
      peer.on('error', () => socket.destroy()); peer.once('close', () => socket.destroy())
      socket.once('close', () => peer.destroy())
      peer.pipe(socket); socket.pipe(peer)
    })
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
    upstream.on('error', () => socket.destroy())
    upstream.once('close', () => clearTimeout(timer))
    upstream.end()
  }
  return { forward, upgrade }
}
