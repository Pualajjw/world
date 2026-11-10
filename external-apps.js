/**
 * .worldapp 外部应用的视图层：桌面/开始菜单/任务栏图标与独立 iframe 窗口。
 * 格式校验、注册表与窗口几何在 app-format.js（无 React 依赖，可单独测试）。
 */
import React from 'react'

export {
  APP_FORMAT, APP_FILE_PATTERN, RESERVED_IDS, MAX_APP_FILE, parseWorldApp,
  readExternalApps, saveExternalApps, clampAppRect, defaultAppRect,
  readExternalRect, saveExternalRect, removeExternalRect,
} from './app-format.js'

const h = React.createElement
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** 桌面 / 开始菜单 / 任务栏共用的应用图标。 */
export function ExternalAppGlyph({ app, size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, focusable: 'false' },
    h('rect', { x: 2, y: 2, width: 44, height: 44, rx: 13, fill: app?.color || '#4c86ff' }),
    h('rect', { x: 2, y: 2, width: 44, height: 44, rx: 13, fill: 'none', stroke: 'rgba(255,255,255,.28)' }),
    h('text', { x: 24, y: 32, textAnchor: 'middle', fontSize: 24, fontFamily: 'Segoe UI Emoji, system-ui' }, app?.icon || '🧩'))
}

function Cap({ label, onClick, close, children }) {
  return h('button', {
    type: 'button', className: `world-external-cap${close ? ' world-external-close' : ''}`,
    title: label, 'aria-label': label, onClick,
  }, children)
}

/** 外部应用的独立窗口：复用 VSCode 窗口外观，内容是一个 iframe。 */
export function ExternalAppWindow({
  app, rect, state, active, onActivate, onClose, onMinimize, onToggleMaximize,
  onDragStart, onDragMove, onDragEnd, onResizeStart,
}) {
  const minimized = state === 'min'
  const maximized = state === 'max'
  const style = maximized
    ? { '--vscode-x': '0vw', '--vscode-y': '0vh', '--vscode-w': '100vw',
      '--vscode-h': 'calc(100vh - var(--world-desktop-top) - var(--world-taskbar-height))', zIndex: active ? 5 : 3 }
    : { '--vscode-x': `${rect.x}vw`, '--vscode-y': `${rect.y}vh`,
      '--vscode-w': `${rect.w}vw`, '--vscode-h': `${rect.h}vh`, zIndex: active ? 5 : 3 }
  if (minimized) style.display = 'none'

  return h('section', {
    className: `world-vscode-window world-external-window${maximized ? ' is-max' : ''}`,
    'data-world-app-id': app.id, 'aria-label': app.name, 'aria-hidden': minimized,
    style, onPointerDown: onActivate,
  },
  h('header', {
    className: 'world-vscode-titlebar',
    onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    onDoubleClick: event => { if (!event.target.closest('button')) onToggleMaximize() },
  },
    h('div', { className: 'world-vscode-title' },
      h(ExternalAppGlyph, { app, size: 16 }), h('span', null, app.name)),
    h('div', { className: 'world-vscode-controls' },
      h(Cap, { label: '最小化', onClick: onMinimize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
      h(Cap, { label: maximized ? '还原' : '最大化', onClick: onToggleMaximize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))),
      h(Cap, { label: '关闭', close: true, onClick: onClose },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('path', { d: 'M0 0l10 10M10 0L0 10', stroke: 'currentColor', strokeWidth: 1 }))))),
  h('div', { className: 'world-external-body' },
    h('iframe', { title: app.name, src: app.url, className: 'world-external-frame' })),
  !minimized && !maximized
    ? RESIZE_EDGES.map(edge => h('div', {
      key: edge, className: `world-vscode-resize world-vscode-resize-${edge}`, 'aria-hidden': true,
      onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    }))
    : null)
}
