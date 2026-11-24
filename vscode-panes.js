import React from 'react'
import { createPortal } from 'react-dom'
import { movePreservingState } from './window-docking.js'
import { groupsOf, paneBounds, paneRatioLimit, splitBounds, tabGroupOf } from './vscode-layout.js'

const h = React.createElement
const KEY_STEP = 0.03

/** Stable content hosts preserve editors and previews when the split tree changes. */
export function createPaneMounts() {
  const hosts = new Map(), slots = new Map()
  const place = id => {
    const host = hosts.get(id)
    if (!host) return
    const slot = slots.get(id)
    const target = slot || host.home
    if (target?.isConnected && host.node.parentNode !== target) movePreservingState(target, host.node)
  }
  return {
    register(id, node, home) { hosts.set(id, { node, home }); place(id); return () => { hosts.delete(id); node.remove() } },
    slot(id, node) {
      if (node) slots.set(id, node); else slots.delete(id)
      if (node && !node.isConnected) queueMicrotask(() => place(id))
      else place(id)
    },
  }
}

export function TabSurface({ manager, id, children }) {
  const home = React.useRef(null)
  const [node] = React.useState(() => {
    const element = document.createElement('div')
    element.className = 'world-vscode-pane-surface'
    return element
  })
  React.useLayoutEffect(() => manager.register(id, node, home.current), [manager, id, node])
  return h('div', { hidden: true, ref: home }, createPortal(children, node))
}

function PaneSlot({ manager, id }) {
  const ref = React.useCallback(node => manager.slot(id, node), [manager, id])
  return h('div', { ref, className: 'world-vscode-pane-target' })
}

/**
 * 拖动分隔条改变两格的分配比例。
 * 位置一律用百分比（和 PaneLayout 的定位同一套坐标系），只有换算成像素才用容器实测尺寸 ——
 * 窗口缩放、侧栏折叠、最大化都不需要额外重算。
 */
function PaneSash({ splitter, onRatio, onReset }) {
  const horizontal = splitter.axis === 'row'
  const [dragging, setDragging] = React.useState(false)
  const drag = React.useRef(null)

  const measure = node => {
    const box = node?.offsetParent?.getBoundingClientRect()
    if (!box) return { box: null, size: 0, limit: 0.5 }
    const size = horizontal ? (splitter.rect.w / 100) * box.width : (splitter.rect.h / 100) * box.height
    return { box, size, limit: paneRatioLimit(size) }
  }
  const clamp = (ratio, limit) => Math.min(1 - limit, Math.max(limit, ratio))

  const start = event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const { box, size, limit } = measure(event.currentTarget)
    if (!box || !size) return
    drag.current = {
      pointerId: event.pointerId,
      node: event.currentTarget,
      origin: horizontal ? box.left + (splitter.rect.x / 100) * box.width : box.top + (splitter.rect.y / 100) * box.height,
      size, limit,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const move = event => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    if (!event.buttons) { end(event); return }
    const pointer = horizontal ? event.clientX : event.clientY
    onRatio(splitter.path, clamp((pointer - state.origin) / state.size, state.limit))
  }
  const end = event => {
    const state = drag.current
    if (!state) return
    drag.current = null
    setDragging(false)
    try { state.node.releasePointerCapture(state.pointerId) } catch { /* already released */ }
  }
  React.useEffect(() => {
    if (!dragging) return
    const finish = event => {
      if (event.type === 'blur' || event.type === 'keydown' && event.key === 'Escape' || event.pointerId === drag.current?.pointerId) end(event)
    }
    for (const type of ['pointerup', 'pointercancel', 'blur', 'keydown']) window.addEventListener(type, finish, true)
    return () => { for (const type of ['pointerup', 'pointercancel', 'blur', 'keydown']) window.removeEventListener(type, finish, true) }
  }, [dragging])
  const keyDown = event => {
    const forward = horizontal ? 'ArrowRight' : 'ArrowDown'
    const backward = horizontal ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== forward && event.key !== backward) return
    event.preventDefault()
    event.stopPropagation()
    const { limit } = measure(event.currentTarget)
    onRatio(splitter.path, clamp(splitter.ratio + (event.key === forward ? KEY_STEP : -KEY_STEP), limit))
  }

  const style = horizontal
    ? { left: `${splitter.rect.x + splitter.rect.w * splitter.ratio}%`, top: `${splitter.rect.y}%`, height: `${splitter.rect.h}%` }
    : { top: `${splitter.rect.y + splitter.rect.h * splitter.ratio}%`, left: `${splitter.rect.x}%`, width: `${splitter.rect.w}%` }
  return h('div', {
    className: `world-vscode-sash is-${horizontal ? 'row' : 'column'}${dragging ? ' is-dragging' : ''}`,
    style, role: 'separator', tabIndex: 0,
    'aria-orientation': horizontal ? 'vertical' : 'horizontal',
    'aria-label': '调整分屏比例',
    'aria-valuenow': Math.round(splitter.ratio * 100), 'aria-valuemin': 5, 'aria-valuemax': 95,
    title: '拖动调整比例，双击复位',
    onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end,
    onLostPointerCapture: end,
    // 设计组的默认比例不是 50:50，双击要回到这一层自己的默认值。
    onDoubleClick: () => onReset ? onReset(splitter.path) : onRatio(splitter.path, 0.5),
    onKeyDown: keyDown,
  })
}

export function PaneLayout({ layout, mounts, surface, active, preview, onRatio, strip, scope, nested, onReset }) {
  const bounds = paneBounds(layout)
  const groups = groupsOf(layout)
  const splitters = onRatio ? splitBounds(layout) : []
  const activeGid = tabGroupOf(layout, active)
  return [
    ...groups.map(entry => {
      const rect = bounds.get(entry.gid)
      return h('section', {
        key: entry.gid,
        className: `world-vscode-pane${rect ? '' : ' is-hidden'}${entry.gid === activeGid ? ' is-active' : ''}`,
        'data-world-pane': entry.gid, 'data-world-scope': scope,
        style: rect ? { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` } : undefined,
      },
      // 每格自己的标签栏：组内在场的标签都在这儿，只有 active 那个显示内容
      strip ? strip(entry) : null,
      nested?.(entry.active) || h(PaneSlot, { manager: mounts, id: surface(entry.active, entry) }),
      preview?.tab === entry.gid ? h('div', { className: `world-snap-preview world-vscode-pane-preview is-${preview.edge}`, 'aria-hidden': true }) : null)
    }),
    ...splitters.map(splitter => h(PaneSash, { key: `sash-${splitter.path.join('.')}`, splitter, onRatio, onReset })),
  ]
}

export const TAB_DRAG_TYPE = 'application/x-world-vscode-tab'
