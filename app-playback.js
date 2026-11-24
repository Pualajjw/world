/** App-side invocation inbox. Work is admitted immediately; presentation prefers a completed result,
 * but a slow operation becomes visible while it is still running. A revoked queue is never resurrected by a later receipt. */
export function createAppPlayback({ canInvoke, present, presentResult, changed, onError, onReceive, onResult }) {
  const rows = new Map(), queue = [], skipped = new Set()
  let active = null, timer, disposed = false, expected = 1
  function trim() {
    if (rows.size <= 100) return
    for (const [id, row] of rows) {
      if (rows.size <= 100) break
      if (row.done && row !== active?.row && !queue.includes(row)) rows.delete(id)
    }
  }
  function cancelTurn() {
    if (!active) return
    const turn = active
    active = null
    turn.controller.abort()
    turn.settle() // wake an unfinished row without waiting for (or cancelling) its actual tool
  }
  function pump() {
    clearTimeout(timer)
    while (skipped.delete(expected)) expected++
    if (active || disposed || !queue.length || queue[0].sequence !== expected) return
    const head = queue[0], delay = head.receivedAt + 500 - Date.now()
    if (!head.done && delay > 0) { timer = setTimeout(pump, delay); return }
    const row = queue.shift(); expected++
    if (!canInvoke(row)) { pump(); return }
    const controller = new AbortController(), signal = controller.signal
    let settle
    const finished = new Promise(resolve => { settle = resolve })
    const turn = { row, controller, settle }; active = turn; changed()
    Promise.resolve().then(async () => {
      signal.throwIfAborted()
      const windowId = await present(row, signal)
      if (!row.done) await finished
      signal.throwIfAborted()
      if (canInvoke(row)) await presentResult?.(row, signal, windowId)
    })
      .catch(e => { if (!controller.signal.aborted) onError(String(e?.message || e)) })
      .finally(() => { if (active === turn) { active = null; trim(); pump(); changed() } })
  }
  function enqueue(row) {
    queue.push(row); queue.sort((a,b) => a.sequence - b.sequence); pump()
  }
  return {
    invoke(command, invokeCapability) {
      if (disposed || !canInvoke(command) || rows.has(command.receiptId)) throw new Error('应用未接收调用：授权、绑定或安装状态已变化。')
      if (queue.length >= 256) throw new Error('应用补播队列已满。此调用未执行。')
      const row = { ...command, id: command.receiptId, done: false, receivedAt: Date.now() }
      row.trace = onReceive?.(row)
      rows.set(row.id, row)
      if (!row.transport) enqueue(row)
      changed()
      // Run the app's bound DSH capability, not a second local imitation of its implementation.
      // The RPC starts work and returns immediately; the final result comes back independently.
      return invokeCapability({ appId: row.appId, tool: row.tool, receiptId: row.id })
    },
    finish(command, liveGrant) {
      const row = rows.get(command.receiptId)
      if (!row) {
        if (liveGrant && liveGrant === command.controlId && command.sequence >= expected) {
          skipped.add(command.sequence); pump()
        }
        return {}
      }
      if (row.done || row.controlId !== command.controlId) return {}
      Object.assign(row, { done: true, doneAt: Date.now(), output: command.output, failed: command.failed })
      onResult?.(row.trace, row)
      if (row.path && command.resolvedPath) row.path = command.resolvedPath
      if (row.transport) {
        if (command.hasChildren) rows.delete(row.id)
        else {
          row.transport = false // pure program: keep its output even after human takeover
          if (Number.isSafeInteger(command.sequence) && command.controlId === liveGrant) {
            row.sequence = command.sequence; enqueue(row)
          }
        }
      }
      if (active?.row === row) active.settle()
      trim(); pump(); changed(); return {}
    },
    current: () => active?.row,
    /** 还在排队、尚未上台的调用数；不含正在播的那一条。可传入过滤只看某个窗口的。 */
    pending: filter => filter ? queue.filter(filter).length : queue.length,
    history: () => [...rows.values()].filter(row => !row.transport),
    revoke() {
      clearTimeout(timer); queue.length = 0; expected = 1; skipped.clear()
      cancelTurn(); trim(); changed()
    },
    dispose() { clearTimeout(timer); disposed = true; queue.length = 0; cancelTurn(); rows.clear() },
  }
}
