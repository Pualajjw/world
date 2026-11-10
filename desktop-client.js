export const desktopError = (message, code = 'WORLD_DESKTOP_ACTION') => Object.assign(new Error(message), { code })

/** Wait for React to commit an action, with cancellation and a finite deadline. */
export async function waitForDesktop(read, signal, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (true) {
    signal?.throwIfAborted()
    const value = read()
    if (value) return value
    if (Date.now() >= until) throw desktopError('等待窗口更新超时，请重新查看桌面状态。', 'WORLD_DESKTOP_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Long polls use the existing authenticated RPC channel, including its worker transport. */
export function startDesktopClient({ rpc, getState, execute, onDisconnect, subscribe, onActivity }) {
  const lifetime = new AbortController()
  let connection = null
  let updateQueued = false
  const call = async (operation, payload, signal = lifetime.signal) => {
    const result = await rpc.call('/api', `world-desktop/${operation}`, payload, signal)
    if (result?.ok !== true) throw desktopError(result?.error?.message || '桌面连接失败。', result?.error?.code)
    return result.value
  }
  const disconnect = () => {
    const previous = connection
    connection = null
    onDisconnect?.()
    if (previous) void call('disconnect', previous, AbortSignal.timeout(2000)).catch(() => {})
  }
  const unsubscribe = subscribe?.(() => {
    if (!connection || updateQueued || lifetime.signal.aborted) return
    updateQueued = true
    queueMicrotask(() => {
      updateQueued = false
      if (connection && !lifetime.signal.aborted) {
        const current = connection
        void call('update', { ...current, state: getState() }).catch(() => {
          if (connection === current) disconnect()
        })
      }
    })
  })
  const done = (async () => {
    while (!lifetime.signal.aborted) {
      try {
        if (!connection) connection = await call('connect', { state: getState() })
        const { command, activity } = await call('poll', connection)
        if (activity) onActivity?.(activity)
        if (!command) continue
        let result
        try {
          if (Date.now() >= command.expiresAt) throw desktopError('命令已过期。', 'WORLD_DESKTOP_TIMEOUT')
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(1, command.expiresAt - Date.now()))])
          const value = command.action === 'state' ? {} : await execute(command, signal)
          result = { ok: true, value: { ...value, state: getState() } }
        } catch (error) {
          result = { ok: false, error: { code: error.code || 'WORLD_DESKTOP_ACTION', message: String(error.message || error) } }
        }
        await call('reply', { ...connection, commandId: command.id, result })
      } catch {
        disconnect()
        if (lifetime.signal.aborted) break
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, 1500)
          lifetime.signal.addEventListener('abort', finish, { once: true })
        })
      }
    }
  })()
  return { done, dispose() { unsubscribe?.(); lifetime.abort(); disconnect() } }
}
