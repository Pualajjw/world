import React from 'react'
import { fitSavedDesktopRect } from './responsive.js'
import { PLUGIN_SLOT, createPluginCatalog } from './plugin-catalog.js'

export { PLUGIN_SLOT, createPluginCatalog }

const h = React.createElement
const TASKBAR_HEIGHT = 48
const RECT_STORAGE_PREFIX = 'dsh.world.plugin.'
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function desktopTop() {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
}

/** Clamp a percentage rect to the desktop area; mirrors the built-in VSCode window geometry. */
export function clampPluginRect(rect) {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const top = desktopTop()
  const minW = Math.min(width, 720) / width * 100
  const minH = Math.min(Math.max(0, height - top - TASKBAR_HEIGHT), 480) / height * 100
  const w = Math.min(100, Math.max(minW, Number(rect?.w) || minW))
  const h = Math.min(Math.max(0, (height - top - TASKBAR_HEIGHT) / height * 100), Math.max(minH, Number(rect?.h) || minH))
  const x = Math.min(100 - w, Math.max(0, Number(rect?.x) || 0))
  const minY = top / height * 100
  const maxY = Math.max(minY, (height - TASKBAR_HEIGHT - height * h / 100) / height * 100)
  return { x, y: Math.min(maxY, Math.max(minY, Number(rect?.y) || minY)), w, h }
}

/** Cascading default position so several plugin windows stay visible at once. */
export function defaultPluginRect(index = 0) {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const top = desktopTop()
  const availableHeight = Math.max(0, height - top - TASKBAR_HEIGHT)
  const windowWidth = Math.min(width, Math.max(Math.min(720, width), width * 0.8))
  const windowHeight = Math.min(availableHeight, Math.max(Math.min(480, availableHeight), height * 0.8))
  const step = 2.4
  const offset = (index % 6) * step
  return clampPluginRect({
    x: (Math.max(0, (width - windowWidth) / 2) + offset * width / 100) / width * 100,
    y: (top + Math.max(0, (availableHeight - windowHeight) / 2) + offset * height / 100) / height * 100,
    w: windowWidth / width * 100,
    h: windowHeight / height * 100,
  })
}

export function readPluginRect(key, index = 0) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(RECT_STORAGE_PREFIX + key) || 'null')
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) return fitSavedDesktopRect(stored, clampPluginRect)
  } catch {}
  return defaultPluginRect(index)
}

export function savePluginRect(key, rect) {
  try { window.localStorage.setItem(RECT_STORAGE_PREFIX + key, JSON.stringify(rect)) } catch {}
}

function GenericGlyph({ size = 20 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
    h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
    h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
    h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
    h('rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }))
}

class GlyphBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    const { icon, size } = this.props
    if (this.state.failed || typeof icon !== 'function') return h(GenericGlyph, { size })
    return h(icon, { size, active: false })
  }
}

/** Plugin-owned sidebar icon with a generic fallback for incompatible icon components. */
export function PluginGlyph({ icon, size = 20 }) {
  return h(GlyphBoundary, { icon, size })
}

/**
 * A mirrored page runs in world's window, not in the layout seat it was written for, and a third-party page may
 * throw. Without this boundary that would unmount the whole desktop with it.
 */
class PageBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, message: '' }
  }
  static getDerivedStateFromError(error) { return { failed: true, message: String(error?.message || error) } }
  componentDidCatch(error) { console.warn(`[world] plugin page "${this.props.label}" failed:`, error) }
  render() {
    if (!this.state.failed) return this.props.children
    return h('div', { className: 'world-plugin-placeholder' },
      h('strong', null, this.props.label),
      h('span', null, `页面没能打开：${this.state.message}`))
  }
}

function Cap({ label, title, onClick, children }) {
  return h('button', { className: `world-cap${label === '关闭' ? ' world-close' : ''}`, type: 'button', title, 'aria-label': title, onClick }, children)
}

/** One independent virtual window hosting a registered whole-page plugin. */
export function PluginWindow({ app, win, active, renderSlot, children, onActivate, onMinimize, onToggleMaximize, onClose, onDragStart, onDragMove, onDragEnd, onResizeStart }) {
  const minimized = win.state === 'min'
  const maximized = win.state === 'max'
  const stateClass = minimized ? ' is-min' : maximized ? ' is-max' : ''
  return h('section', {
    className: `world-plugin-window${stateClass}${active ? ' is-active' : ''}`,
    'data-world-plugin': app.key,
    'aria-label': `${app.label} 窗口`,
    'aria-hidden': minimized,
    style: {
      '--plugin-x': `${win.rect.x}vw`, '--plugin-y': `${win.rect.y}vh`,
      '--plugin-w': `${win.rect.w}vw`, '--plugin-h': `${win.rect.h}vh`,
      zIndex: active ? 6 : 2,
    },
    onPointerDown: onActivate,
  },
  h('header', {
    className: 'world-plugin-titlebar',
    onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    onDoubleClick: event => { if (!event.target.closest('button')) onToggleMaximize() },
  },
    h('div', { className: 'world-plugin-title' },
      h(PluginGlyph, { icon: app.icon, size: 16 }), h('span', null, app.label)),
    h('div', { className: 'world-window-controls' },
      h(Cap, { label: '最小化', title: '最小化', onClick: onMinimize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true }, h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
      h(Cap, { label: maximized ? '还原' : '最大化', title: maximized ? '还原' : '最大化', onClick: onToggleMaximize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))),
      h(Cap, { label: '关闭', title: '关闭', onClick: onClose },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true }, h('path', { d: 'M0 0l10 10M10 0L0 10', stroke: 'currentColor', strokeWidth: 1 }))))),
  h('div', { className: 'world-plugin-body' },
    children !== undefined ? children : typeof renderSlot !== 'function'
      ? h('div', { className: 'world-plugin-placeholder' },
        h('strong', null, app.label),
        h('span', null, '当前宿主未提供页面渲染通道。'))
      : h(PageBoundary, { label: app.label }, renderSlot(PLUGIN_SLOT, {}, {
        entryKey: app.key,
        fallback: h('div', { className: 'world-plugin-placeholder' },
          h('strong', null, app.label), h('span', null, '插件页面尚未注册。')),
      }))),
  !minimized && !maximized
    ? RESIZE_EDGES.map(edge => h('div', {
      key: edge, className: `world-plugin-resize world-plugin-resize-${edge}`, 'aria-hidden': true,
      onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    }))
    : null)
}
