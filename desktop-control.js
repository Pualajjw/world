import { desktopError } from './desktop-client.js'

const taken = () => desktopError('用户已接管桌面。请等待用户再次点击“交给助手”，再读取新的 controlId 后继续。', 'WORLD_DESKTOP_TAKEN_OVER')
const descriptions = {
  open_app: '正在打开应用', focus_window: '正在切换窗口', minimize_window: '正在最小化窗口',
  maximize_window: '正在最大化窗口', restore_window: '正在还原窗口', open_file: '正在打开文件',
  screenshot: '正在截取桌面',
}

/** A grant belongs to one DSH session and one handoff; old queued commands cannot regain it. */
export function createDesktopControl({ makeId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-') } = {}) {
  let state = { owner: 'human', controlId: null, sessionId: null, phase: 'idle', message: '', revision: 0 }
  const listeners = new Set(), running = new Set()
  let handoffRevision = 0, inputDepth = 0
  const update = next => { state = { ...next, revision: state.revision + 1 }; for (const notify of listeners) notify() }
  const takeOver = () => {
    handoffRevision++
    if (state.owner === 'human' && state.phase === 'idle') return
    update({ owner: 'human', controlId: null, sessionId: null, phase: 'idle', message: '' })
    for (const controller of running) controller.abort(taken())
    running.clear()
  }
  return {
    getSnapshot: () => state,
    dispatchInput(body) { inputDepth++; try { return body() } finally { inputDepth-- } },
    isDispatchingInput: () => inputDepth > 0,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    grant(sessionId) {
      if (!sessionId) throw desktopError('请先打开一个 DSH 会话，再交给助手。', 'WORLD_DESKTOP_SESSION')
      takeOver()
      update({ owner: 'assistant', controlId: makeId(), sessionId, phase: 'ready', message: '已接手桌面，等待助手的下一步操作。' })
    },
    async handoff(resolveBrain) {
      takeOver()
      const revision = handoffRevision
      update({ ...state, phase: 'granting' })
      try {
        const brain = await resolveBrain()
        if (revision !== handoffRevision) return false
        if (!brain) { takeOver(); return false }
        this.grant(brain.sessionId)
        return true
      } catch (error) {
        if (revision === handoffRevision) takeOver()
        throw error
      }
    },
    takeOver,
    async run(command, signal, execute) {
      signal?.throwIfAborted()
      if (state.owner !== 'assistant' || command.controlId !== state.controlId) throw taken()
      if (command.actor?.sessionId !== state.sessionId)
        throw desktopError('桌面控制权属于另一个会话，请勿操作。', 'WORLD_DESKTOP_SESSION')
      const controlId = state.controlId
      if (command.action === 'layout') {
        const value = await execute(signal)
        signal?.throwIfAborted()
        if (state.controlId !== controlId) throw taken()
        return value
      }
      const controller = new AbortController()
      running.add(controller)
      const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const message = command.message || descriptions[command.action] || '正在操作桌面'
      const activity = command.path ? `${message}：${command.path}` : message
      update({ ...state, phase: 'working', message: activity })
      try {
        const value = command.action === 'explain' ? {} : await execute(active)
        active.throwIfAborted()
        if (state.controlId === controlId) update({ ...state, phase: 'ready', message: activity })
        return value
      } catch (error) {
        if (state.controlId === controlId) update({ ...state, phase: 'ready', message: String(error?.message || error) })
        throw error
      } finally { running.delete(controller) }
    },
    dispose() { takeOver(); listeners.clear() },
  }
}

/** A human's first input keeps its normal browser behavior while immediately revoking the grant. */
export function observeDesktopInput(control, target = window.document) {
  const input = event => {
    if (!event.isTrusted) return
    // Native conversation inputs, approvals and their owned body portals do not take the desktop.
    if (event.target?.closest?.('[data-world-control-ui]')) return
    const transcript = event.target?.closest?.('[data-world-session-content]')
    if (transcript && (['pointerdown', 'wheel'].includes(event.type)
      || (event.type === 'keydown' && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)))) return
    const toggle = event.target?.closest?.('[data-world-control-button]')
    if (toggle && (event.type === 'pointerdown' || (event.type === 'keydown' && ['Enter', ' '].includes(event.key)))) return
    control.takeOver()
  }
  for (const type of ['pointerdown', 'wheel', 'keydown']) target.addEventListener(type, input, { capture: true, passive: true })
  // Focus entering an embedded page still belongs to this document; minimizing/switching apps does not.
  const blur = () => {
    if (!control.isDispatchingInput?.() && target.hasFocus() && target.activeElement?.tagName === 'IFRAME') control.takeOver()
  }
  target.defaultView?.addEventListener('blur', blur)
  return () => {
    for (const type of ['pointerdown', 'wheel', 'keydown']) target.removeEventListener(type, input, true)
    target.defaultView?.removeEventListener('blur', blur)
  }
}
