import React from 'react'
import { createPortal } from 'react-dom'
import { closestPaneEdge } from './vscode-layout.js'

const h = React.createElement
const TITLEBARS = '.world-titlebar,.world-vscode-titlebar,.world-plugin-titlebar'

export function movePreservingState(target, node, before = null) {
  if (typeof target.moveBefore === 'function' && node.isConnected && target.isConnected) target.moveBefore(node, before)
  else target.insertBefore(node, before)
}

/** Keep each application mounted in one stable portal while moving its host into an editor pane. */
export function createWindowDocking() {
  const windows = new Map(), entries = new Map(), slots = new Map(), listeners = new Set()
  let snapshot = [], nonce = 0
  const publish = () => { snapshot = [...entries.values()]; for (const notify of listeners) notify() }
  const place = id => {
    const win = windows.get(id)
    if (!win) return
    const entry = entries.get(id), slot = slots.get(id)
    const target = entry && slot ? slot : win.anchor.parentNode
    if (!target?.isConnected) return
    win.host.classList.toggle('is-docked', Boolean(entry))
    win.host.hidden = Boolean(entry && !slot)
    if (win.host.parentNode !== target) movePreservingState(target, win.host)
    if (id === 'dsh') {
      const root = document.getElementById('root')
      if (root && entry && slot) {
        if (!win.rootHome) win.rootHome = { parent: root.parentNode, next: root.nextSibling }
        if (root.parentNode !== win.host) movePreservingState(win.host, root)
        document.body.dataset.worldDshDocked = 'true'
      } else if (root && win.rootHome) {
        movePreservingState(win.rootHome.parent, root, win.rootHome.next?.parentNode === win.rootHome.parent ? win.rootHome.next : null)
        win.rootHome = null
        delete document.body.dataset.worldDshDocked
      }
    }
  }
  const undock = id => {
    if (!entries.delete(id)) return
    slots.delete(id); place(id); publish()
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    entry: id => entries.get(id),
    focus(id) {
      const entry = entries.get(id)
      if (entry) { entries.set(id, { ...entry, focusNonce: ++nonce }); publish() }
    },
    setVisible(id, visible) {
      const entry = entries.get(id)
      if (entry && entry.visible !== visible) { entries.set(id, { ...entry, visible }); publish() }
    },
    register(id, win) {
      windows.set(id, win); place(id)
      return () => { undock(id); win.host.remove(); windows.delete(id) }
    },
    dock(id, owner, placement) {
      const win = windows.get(id)
      if (!win) return
      entries.set(id, { id, owner, label: win.label, placement, nonce: ++nonce })
      place(id); publish()
    },
    undock,
    releaseOwner(owner) { for (const entry of [...entries.values()]) if (entry.owner === owner) undock(entry.id) },
    setSlot(id, node) {
      if (node) slots.set(id, node); else slots.delete(id)
      if (node && !node.isConnected) queueMicrotask(() => place(id))
      else place(id)
    },
  }
}

export function DockableWindow({ manager, id, label, children }) {
  const anchor = React.useRef(null)
  const [host] = React.useState(() => {
    const node = document.createElement('div')
    node.className = 'world-dock-host'; node.dataset.worldDockId = id
    return node
  })
  React.useLayoutEffect(() => manager.register(id, { host, anchor: anchor.current, label }), [manager, id, host])
  return h(React.Fragment, null, h('span', { ref: anchor, hidden: true }), createPortal(children, host))
}

export function DockSlot({ manager, id, visible }) {
  const slot = React.useCallback(node => manager.setSlot(id, node), [manager, id])
  React.useEffect(() => { manager.setVisible(id, visible) }, [manager, id, visible])
  return h('div', { className: 'world-vscode-app-slot', ref: slot, 'data-world-app-slot': id })
}

/** Pointer capture keeps window drags working even while the source covers the editor. */
export function installWindowDocking(manager, onDock, onCancel = () => {}) {
  let drag, preview, shield
  const clear = () => { preview?.remove(); preview = null }
  const end = () => { clear(); shield?.remove(); shield = null }
  const abandon = () => {
    const source = drag
    drag = null; end()
    if (!source) return
    try { source.title.releasePointerCapture?.(source.pointer) } catch { /* capture may already be gone */ }
    onCancel()
  }
  const targetAt = event => {
    const editors = [...document.querySelectorAll('.world-vscode-window[data-world-vscode-key]:not(.is-min)')]
      .filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height)
      .sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))
    for (const editor of editors) {
      // 标签栏现在嵌在每一格内部，而且 DOM 顺序上排在格子之后：
      // 一次 querySelectorAll 会先命中整格、把「落在标签栏」误判成「落在顶边」，所以分两批、标签栏优先。
      const strips = editor.querySelectorAll(':scope > .world-vscode-body > .world-vscode-editor .world-vscode-tabs')
      const panes = editor.querySelectorAll(':scope > .world-vscode-body > .world-vscode-editor .world-vscode-pane:not(.is-hidden)')
      for (const area of [...strips, ...panes]) {
        const rect = area.getBoundingClientRect()
        if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue
        const strip = area.classList.contains('world-vscode-tabs')
        return { owner: editor.dataset.worldVscodeKey,
          tab: strip ? (area.dataset.worldActive || '') : (area.dataset.worldPane || ''),
          edge: strip ? null : closestPaneEdge(rect, event.clientX, event.clientY), rect }
      }
    }
    return null
  }
  const down = event => {
    if (drag && event.pointerId === drag.pointer) abandon()
    if (event.button !== 0 || window.innerWidth <= 600 || event.target.closest('button,input,textarea')) return
    const title = event.target.closest(TITLEBARS), host = title?.closest('.world-dock-host')
    if (!host || host.classList.contains('is-docked')) return
    drag = { id: host.dataset.worldDockId, pointer: event.pointerId, x: event.clientX, y: event.clientY, title }
  }
  const move = event => {
    if (drag && event.pointerId === drag.pointer && event.buttons === 0) { abandon(); return }
    if (!drag || drag.pointer !== event.pointerId || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
    if (!shield) {
      shield = document.createElement('div'); shield.className = 'world-dock-drag-shield'
      shield.dataset.worldPortal = 'dsh-world'; shield.setAttribute('aria-hidden', 'true')
      document.body.append(shield)
    }
    const target = targetAt(event)
    clear()
    if (!target) return
    preview = document.createElement('div'); preview.className = 'world-snap-preview world-dock-preview'
    preview.dataset.worldPortal = 'dsh-world'; preview.setAttribute('aria-hidden', 'true')
    const { rect, edge } = target
    const vertical = edge === 'top' || edge === 'bottom'
    Object.assign(preview.style, { left: `${rect.left + (edge === 'right' ? rect.width / 2 : 0)}px`,
      top: `${rect.top + (edge === 'bottom' ? rect.height / 2 : 0)}px`,
      width: `${edge && !vertical ? rect.width / 2 : rect.width}px`, height: `${vertical ? rect.height / 2 : rect.height}px` })
    document.body.append(preview)
  }
  const up = event => {
    if (!drag || drag.pointer !== event.pointerId) return
    const source = drag; drag = null; end()
    if (event.type !== 'pointerup' || Math.hypot(event.clientX - source.x, event.clientY - source.y) < 6) return
    const target = targetAt(event)
    if (!target) return
    event.preventDefault(); event.stopPropagation()
    source.title.releasePointerCapture?.(event.pointerId)
    onDock(source.id, target.owner)
    manager.dock(source.id, target.owner, { tab: target.tab, edge: target.edge })
  }
  const cancel = event => { if (event.key === 'Escape') abandon() }
  const lost = event => { if (drag && event.pointerId === drag.pointer && event.target === drag.title) abandon() }
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('pointermove', move, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('pointercancel', up, true)
  document.addEventListener('lostpointercapture', lost, true)
  document.addEventListener('dragstart', abandon, true)
  document.addEventListener('dragend', abandon, true)
  window.addEventListener('blur', abandon)
  window.addEventListener('keydown', cancel, true)
  return () => {
    drag = null; end()
    document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointermove', move, true)
    document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true)
    document.removeEventListener('lostpointercapture', lost, true)
    document.removeEventListener('dragstart', abandon, true); document.removeEventListener('dragend', abandon, true)
    window.removeEventListener('blur', abandon)
    window.removeEventListener('keydown', cancel, true)
  }
}
