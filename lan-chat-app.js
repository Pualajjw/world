/**
 * world 桌面的内置「局域网聊天」应用窗口。
 *
 * 窗口外观复用 VSCode 窗口的几何/标题栏/缩放手柄（同一套 --vscode-* 变量，
 * 每个窗口在自己元素上以内联变量定义，互不干扰），内容区是一个指向本机
 * 聊天服务的 iframe：服务由 world 的 Host 入口 index.js 启动，端口经 RPC 查询。
 */
import React from 'react'

const h = React.createElement
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export function LanChatGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, focusable: 'false' },
    h('defs', null,
      h('linearGradient', { id: 'worldLanChatGradient', x1: '0', y1: '0', x2: '1', y2: '1' },
        h('stop', { offset: '0', stopColor: '#5aa9ff' }),
        h('stop', { offset: '1', stopColor: '#8268ff' }))),
    h('rect', { x: 2, y: 2, width: 44, height: 44, rx: 13, fill: 'url(#worldLanChatGradient)' }),
    h('path', { d: 'M12 16h24a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H22l-8 6v-6h-2a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4z', fill: '#fff', opacity: '.95' }),
    h('circle', { cx: 19, cy: 26, r: 2, fill: '#4b7bec' }),
    h('circle', { cx: 26, cy: 26, r: 2, fill: '#4b7bec' }),
    h('circle', { cx: 33, cy: 26, r: 2, fill: '#4b7bec' }))
}

function unwrap(result) {
  if (result?.ok === false) throw Object.assign(new Error(result.error?.message || '端口查询失败'), { code: result.error?.code })
  return result?.ok === true && Object.hasOwn(result, 'value') ? result.value : result
}

function Cap({ label, onClick, close, children }) {
  return h('button', {
    type: 'button', className: `world-lanchat-cap${close ? ' world-lanchat-close' : ''}`,
    title: label, 'aria-label': label, onClick,
  }, children)
}

export function LanChatWindow({
  rect, state, rpc, onActivate, onClose, onMinimize, onToggleMaximize,
  onDragStart, onDragMove, onDragEnd, onResizeStart,
}) {
  const [port, setPort] = React.useState(null)
  const [error, setError] = React.useState('')
  const [attempt, setAttempt] = React.useState(0)
  const [botCount, setBotCount] = React.useState(0)
  const frameUrl = port ? globalThis.__WORLD_MOBILE_ACCESS__
    ? new URL('/_world_mobile/lan-chat/', window.location.href).href : `http://127.0.0.1:${port}/` : ''
  const frameRef = React.useRef(null)
  const sendThemeRef = React.useRef(() => {})

  React.useEffect(() => {
    const tokens = ['bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'label-primary', 'label-secondary',
      'label-tertiary', 'border-l1', 'border-l2', 'border-l3', 'interactive-bg-hover', 'interactive-bg-active',
      'state-business-primary']
    const readTheme = () => {
      const body = document.body
      const style = getComputedStyle(body)
      const colors = {}
      for (const token of tokens) colors[token] = style.getPropertyValue(`--dsw-alias-${token}`).trim()
      const dark = body.hasAttribute('data-ds-dark-theme') || document.documentElement.hasAttribute('data-ds-dark-theme')
        || body.dataset.theme === 'dark' || document.documentElement.dataset.theme === 'dark'
      return { type: 'world-dsh-theme', theme: dark ? 'dark' : 'light', colors }
    }
    const send = () => {
      const frame = frameRef.current
      if (!frame?.contentWindow || !port) return
      frame.contentWindow.postMessage(readTheme(), new URL(frameUrl).origin)
    }
    sendThemeRef.current = send
    send()
    const observer = new MutationObserver(send)
    const themeAttributes = ['data-ds-dark-theme', 'data-theme', 'class']
    observer.observe(document.body, { attributes: true, attributeFilter: themeAttributes })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: themeAttributes })
    return () => { observer.disconnect(); if (sendThemeRef.current === send) sendThemeRef.current = () => {} }
  }, [port, frameUrl])

  React.useEffect(() => {
    let alive = true
    setError('')
    setPort(null)
    setBotCount(0)
    if (!rpc || typeof rpc.call !== 'function') {
      setError('当前宿主没有提供 RPC 通道。')
      return () => { alive = false }
    }
    Promise.resolve(rpc.call('/api', 'world-lan-chat/port', {})).then(unwrap).then(value => {
      if (!alive) return
      if (Number.isInteger(value?.bots)) setBotCount(Math.max(0, value.bots))
      if (value?.port) setPort(value.port)
      else setError('聊天服务没有返回可用端口。')
    }).catch(cause => {
      if (alive) setError(String(cause?.message || cause))
    })
    return () => { alive = false }
  }, [rpc, attempt])

  const minimized = state === 'min'
  const maximized = state === 'max'
  const style = maximized
    ? { '--vscode-x': '0vw', '--vscode-y': '0vh', '--vscode-w': '100vw',
      '--vscode-h': 'calc(100vh - var(--world-desktop-top) - var(--world-taskbar-height))' }
    : { '--vscode-x': `${rect.x}vw`, '--vscode-y': `${rect.y}vh`,
      '--vscode-w': `${rect.w}vw`, '--vscode-h': `${rect.h}vh` }
  if (minimized) style.display = 'none'

  return h('section', {
    className: `world-vscode-window world-lanchat-window${maximized ? ' is-max' : ''}`,
    'data-world-app': 'lan-chat', 'aria-label': '局域网聊天', 'aria-hidden': minimized,
    style, onPointerDown: onActivate,
  },
  h('header', {
    className: 'world-vscode-titlebar',
    onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    onDoubleClick: event => { if (!event.target.closest('button')) onToggleMaximize() },
  },
    h('div', { className: 'world-vscode-title' },
      h(LanChatGlyph, { size: 16 }), h('span', null, '局域网聊天 · LAN Chat'),
      // 徽标是 port RPC 查回来的真实数量：本机配置的每个模型都是聊天里的一个好友
      botCount > 0
        ? h('span', { className: 'world-lanchat-botcount', title: '本机配置的模型好友，可以在聊天里 @ 他们干活' },
          '🤖 ' + botCount + ' 模型好友')
        : null),
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
  h('div', { className: 'world-lanchat-body' },
    error
      ? h('div', { className: 'world-lanchat-error', role: 'status' },
        h('strong', null, '无法连接局域网聊天服务'),
        h('span', null, error),
        h('span', null, '请确认 world 插件已更新并重启 dsh；也可以单独运行 lan-chat/start.cmd。'),
        h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, '重试'))
      : port
        ? h('iframe', { ref: frameRef, title: '局域网聊天', src: frameUrl, className: 'world-lanchat-frame',
          onLoad: () => sendThemeRef.current() })
        : h('div', { className: 'world-lanchat-loading', role: 'status' }, '正在连接本机聊天服务…')),
  !minimized && !maximized
    ? RESIZE_EDGES.map(edge => h('div', {
      key: edge, className: `world-vscode-resize world-vscode-resize-${edge}`, 'aria-hidden': true,
      onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    }))
    : null)
}
