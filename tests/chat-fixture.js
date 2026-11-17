import { createLanChatServer } from '../lan-chat/server.mjs'
import dgram from 'node:dgram'

export async function freeUdpPort() {
  const socket = dgram.createSocket('udp4')
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve) })
    return socket.address().port
  } finally { socket.close() }
}

const credentials = new Map()
/** Tests obtain owner credentials in-process, just as the authenticated DSH RPC does. */
export function createAuthenticatedChat(options) {
  const service = createLanChatServer(options), start = service.start
  service.start = async () => {
    const info = await start()
    credentials.set(String(info.port), info.cookie)
    return info
  }
  return service
}
export function ownerHeaders(port) {
  return { cookie: credentials.get(String(port)) || '' }
}
