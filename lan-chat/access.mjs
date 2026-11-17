/** Owner credentials never travel on the peer discovery/message protocol. */
import { randomBytes, timingSafeEqual } from 'node:crypto'

const KEY = /^[A-Za-z0-9_-]{43}$/u
export function createChatAccess() {
  const token = randomBytes(32).toString('base64url')
  const equal = value => typeof value === 'string' && KEY.test(value)
    && timingSafeEqual(Buffer.from(value), Buffer.from(token))
  const cookieName = port => `world_chat_${port}`
  return {
    info(port) {
      return { url: `http://127.0.0.1:${port}/#world-chat=${token}`, cookie: `${cookieName(port)}=${token}` }
    },
    sameOrigin(req) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return false
      if (!req.headers.origin) return true // Non-browser clients still need the credential.
      try { return new URL(req.headers.origin).origin === `http://${req.headers.host}` } catch { return false }
    },
    authenticated(req, port) {
      const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization || '')?.[1]
      const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim())
        .find(value => value.startsWith(cookieName(port) + '='))?.slice(cookieName(port).length + 1)
      return equal(bearer) || equal(cookie)
    },
    pair(value, port, res) {
      if (!equal(value)) return false
      res.setHeader('Set-Cookie', `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/api/`)
      return true
    },
  }
}
