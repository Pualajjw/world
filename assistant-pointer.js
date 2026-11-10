/** The visible work area uses the same viewport CSS coordinates as desktop UI actions. */
function desktopBounds() {
  const rect = document.querySelector('[data-world-assistant-pointer-layer]')?.getBoundingClientRect()
  return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    : { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
}

/** Independent assistant cursor: only an action from the current grant can move it. */
const CLICK_ACTIONS = { click: 'click', double_click: 'double', context_click: 'context' }
const TYPE_ACTIONS = new Set(['fill', 'type_text', 'select_option'])

export function createAssistantPointer({ getControl, getBounds = desktopBounds }) {
  let state = { visible: false, controlId: null, x: 0, y: 0, pulse: null }
  let pulseId = 0
  const listeners = new Set()
  const pulseFor = (action, x, y) => {
    const kind = CLICK_ACTIONS[action] || (TYPE_ACTIONS.has(action) ? 'type' : null)
    return kind ? { id: ++pulseId, x, y, kind } : state.pulse
  }
  const publish = next => {
    if (Object.keys(state).every(key => state[key] === next[key])) return
    state = next
    for (const listener of listeners) listener()
  }
  const clamp = point => {
    const bounds = getBounds()
    return {
      x: Math.max(bounds.left, point.x >= bounds.right ? bounds.right - 1 : point.x),
      y: Math.max(bounds.top, point.y >= bounds.bottom ? bounds.bottom - 1 : point.y),
    }
  }
  const sync = () => {
    const control = getControl()
    if (control.owner !== 'assistant' || !control.controlId) {
      publish({ ...state, visible: false, controlId: null, pulse: null })
      return
    }
    if (state.controlId === control.controlId) return
    const bounds = getBounds()
    publish({ visible: true, controlId: control.controlId, pulse: null,
      ...clamp({ x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }) })
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    sync,
    resize() { sync(); if (state.visible) publish({ ...state, ...clamp(state) }) },
    move(point, controlId, action) {
      const control = getControl()
      if (control.owner !== 'assistant' || !controlId || control.controlId !== controlId
        || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
      const next = clamp(point)
      publish({ ...state, visible: true, controlId, ...next, pulse: pulseFor(action, next.x, next.y) })
      return true
    },
  }
}
