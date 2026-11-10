import { randomUUID } from 'node:crypto'

const failure = (message, code) => Object.assign(new Error(message), { code })

/** Host-to-desktop mailbox. A command is delivered once and completes only on a client receipt. */
export function createDesktopBridge({ timeoutMs = 15000, pollMs = 20000, leaseMs = 60000 } = {}) {
  const clients = new Map()
  const listeners = new Set()
  let activity = null, activityVersion = 0
  const publish = (client, connected = true) => {
    for (const listener of listeners) listener({ desktopId: client.id, state: structuredClone(client.state), connected })
  }
  let disposed = false
  const assertLive = () => { if (disposed) throw failure('桌面服务已停止。', 'WORLD_DESKTOP_STOPPED') }
  const snapshot = value => {
    if (!value || !Array.isArray(value.windows) || !Array.isArray(value.apps)
      || JSON.stringify(value).length > 512 * 1024) throw failure('桌面状态格式无效。', 'WORLD_DESKTOP_INVALID')
    return structuredClone(value)
  }
  const acceptState = (client, value) => {
    const next = snapshot(value)
    const currentRevision = client.state.control?.revision
    const receivedRevision = next.control?.revision
    if (Number.isSafeInteger(currentRevision)
      && (!Number.isSafeInteger(receivedRevision) || receivedRevision < currentRevision)) {
      next.control = structuredClone(client.state.control)
    }
    client.state = next
  }
  function remove(client, reason) {
    clients.delete(client.id)
    publish(client, false)
    client.poll?.finish(null)
    const pending = [...client.commands.values()]
    client.commands.clear()
    for (const command of pending) command.finish(reason)
  }
  function expire() {
    for (const client of clients.values()) if (Date.now() - client.seen > leaseMs)
      remove(client, failure('桌面已断开；请重新查看桌面状态后再操作。', 'WORLD_DESKTOP_OFFLINE'))
  }
  const timer = setInterval(expire, Math.min(10000, leaseMs))
  timer.unref?.()
  function clientOf(payload) {
    const client = clients.get(payload?.desktopId)
    if (!client || client.token !== payload.token)
      throw failure('桌面连接已失效。', 'WORLD_DESKTOP_OFFLINE')
    client.seen = Date.now()
    return client
  }
  function deliver(client) {
    if (!client.poll) return
    if (client.activityVersion !== activityVersion) { client.poll.finish(null); return }
    if ([...client.commands.values()].some(command => command.delivered)) return
    const next = [...client.commands.values()].find(command => !command.delivered)
    if (!next) return
    next.delivered = true
    client.poll.finish({ id: next.id, expiresAt: next.expiresAt, ...next.payload })
  }
  return {
    setActivity(value) {
      activity = structuredClone(value)
      activityVersion++
      for (const client of clients.values()) deliver(client)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    list() {
      expire()
      return [...clients.values()].map(client => ({
        desktopId: client.id, title: client.state.title || 'world',
        activeWindow: client.state.activeWindow, windows: client.state.windows.length,
      }))
    },
    async call(operation, payload, signal) {
      assertLive()
      signal?.throwIfAborted()
      expire()
      if (operation === 'connect') {
        const client = { id: randomUUID(), token: randomUUID(), seen: Date.now(),
          state: snapshot(payload.state), commands: new Map(), poll: null, activityVersion: 0 }
        clients.set(client.id, client)
        publish(client)
        return { desktopId: client.id, token: client.token }
      }
      const client = clientOf(payload)
      if (operation === 'update') {
        acceptState(client, payload.state)
        publish(client)
        return {}
      }
      if (operation === 'disconnect') {
        remove(client, failure('桌面已关闭。', 'WORLD_DESKTOP_OFFLINE'))
        return {}
      }
      if (operation === 'reply') {
        const command = client.commands.get(payload.commandId)
        if (!command?.delivered) return { accepted: false }
        const result = payload.result
        if (result?.ok === true) {
          acceptState(client, result.value?.state)
          publish(client)
          command.finish(null, { desktopId: client.id, ...result.value, state: structuredClone(client.state) })
        } else command.finish(failure(String(result?.error?.message || '桌面操作失败。'),
          String(result?.error?.code || 'WORLD_DESKTOP_ACTION')))
        return { accepted: true }
      }
      if (operation !== 'poll') throw failure('不支持的桌面通信操作。', 'WORLD_DESKTOP_INVALID')
      if (client.poll) throw failure('桌面已经在等待命令。', 'WORLD_DESKTOP_BUSY')
      return new Promise((resolve, reject) => {
        let pollTimer
        const abort = () => finish(null, signal.reason)
        const finish = (command, error) => {
          clearTimeout(pollTimer)
          signal?.removeEventListener('abort', abort)
          client.poll = null
          if (error) reject(error)
          else {
            client.activityVersion = activityVersion
            resolve({ command, ...(activity ? { activity: structuredClone(activity) } : {}) })
          }
        }
        client.poll = { finish }
        pollTimer = setTimeout(() => finish(null), pollMs)
        signal?.addEventListener('abort', abort, { once: true })
        deliver(client)
      })
    },
    request(payload, { desktopId, signal } = {}) {
      assertLive()
      signal?.throwIfAborted()
      expire()
      if (!clients.size) throw failure('没有连接的 world 桌面，请先打开 DSH 的 world 界面。', 'WORLD_DESKTOP_OFFLINE')
      if (!desktopId && clients.size > 1)
        throw failure('有多个桌面连接，请先调用 world_desktop_state 并指定 desktopId。', 'WORLD_DESKTOP_AMBIGUOUS')
      const client = desktopId ? clients.get(desktopId) : clients.values().next().value
      if (!client) throw failure('指定桌面已断开。', 'WORLD_DESKTOP_OFFLINE')
      if (client.commands.size >= 32) throw failure('桌面操作队列已满，请稍后再试。', 'WORLD_DESKTOP_BUSY')
      return new Promise((resolve, reject) => {
        const id = randomUUID(), expiresAt = Date.now() + timeoutMs
        const finish = (error, value) => {
          clearTimeout(commandTimer)
          signal?.removeEventListener('abort', abort)
          client.commands.delete(id)
          if (error) reject(error)
          else resolve(value)
          deliver(client)
        }
        const abort = () => finish(signal.reason || failure('操作已取消。', 'WORLD_DESKTOP_CANCELLED'))
        const commandTimer = setTimeout(() => finish(failure(
          '等待桌面确认超时；操作可能已经执行，请先查看桌面状态，不要直接重试。', 'WORLD_DESKTOP_TIMEOUT')), timeoutMs)
        client.commands.set(id, { id, expiresAt, payload, delivered: false, finish })
        signal?.addEventListener('abort', abort, { once: true })
        deliver(client)
      })
    },
    dispose() {
      disposed = true
      clearInterval(timer)
      for (const client of [...clients.values()]) remove(client, failure('桌面服务已停止。', 'WORLD_DESKTOP_STOPPED'))
      listeners.clear()
    },
  }
}
