/** Captured standalone windows don't pass through the dock-host gesture handlers. */
export function watchWindowDrag(target, pointerId, interrupt) {
  const view = target.ownerDocument.defaultView
  const lost = event => { if (event.pointerId === pointerId) interrupt() }
  const move = event => { if (event.pointerId === pointerId && !(event.buttons & 1)) interrupt() }
  const blur = event => { if (event.target === view) interrupt() }
  const escape = event => { if (event.key === 'Escape') interrupt() }
  const outsideUp = event => { if (event.pointerId === pointerId && !target.contains(event.target)) interrupt() }
  const entries = [[target, 'lostpointercapture', lost], [view, 'blur', blur], [view, 'keydown', escape],
    [view, 'pointermove', move], [view, 'pointerup', outsideUp], [view, 'pointercancel', lost]]
  for (const [node, type, handler] of entries) node.addEventListener(type, handler, true)
  return () => { for (const [node, type, handler] of entries) node.removeEventListener(type, handler, true) }
}

/** Paint only the moving window; commit its React state once when the gesture ends. */
export function previewWindowDrag(event, drag, commit) {
  drag.commit = commit
  if (!drag.preview) {
    const node = event.currentTarget.closest('.world-vscode-window,.world-plugin-window')
    if (!node) return
    const properties = ['left', 'top', 'width', 'height', 'transition']
    const previous = properties.map(name => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)])
    const dialogs = node.dataset.worldPlugin
      ? [...document.querySelectorAll('body > [data-world-dialog]')].filter(dialog => dialog.dataset.worldDialog === node.dataset.worldPlugin)
      : []
    drag.preview = { node, previous, dialogs, frame: 0 }
    node.style.transition = 'none'
  }
  const preview = drag.preview
  if (preview.frame) return
  preview.frame = requestAnimationFrame(() => {
    preview.frame = 0
    if (!preview.node.isConnected) return
    const { x, y, w, h } = drag.next
    // Ordinary style properties do not invalidate inherited CSS variables throughout the editor.
    Object.assign(preview.node.style, { left: `${x}vw`, top: `${y}vh`, width: `${w}vw`, height: `${h}vh` })
    for (const dialog of preview.dialogs) {
      for (const [axis, value] of Object.entries({ x, y, w, h }))
        dialog.style.setProperty(`--world-dialog-${axis}`, `${value}${axis === 'x' || axis === 'w' ? 'vw' : 'vh'}`)
    }
  })
}

/** Cancel queued paints before snap/dock/unmount can take ownership of the window. */
export function finishWindowDrag(drag, commit = true) {
  if (!drag) return
  drag.unwatch?.(); drag.unwatch = null
  const preview = drag.preview
  if (preview) {
    cancelAnimationFrame(preview.frame)
    for (const [name, value, priority] of preview.previous) {
      if (value) preview.node.style.setProperty(name, value, priority)
      else preview.node.style.removeProperty(name)
    }
    drag.preview = null
  }
  if (commit && drag.next) drag.commit?.(drag.next)
  drag.commit = null
}
