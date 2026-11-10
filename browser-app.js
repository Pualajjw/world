/**
 * world 桌面的内置浏览器窗口。
 *
 * 外壳复用 .world-vscode-window 的几何/标题栏/缩放手柄（同一套 --vscode-* 变量）。
 * 网页内容区由本组件**命令式**持有：React 只渲染一个空的 .world-browser-views 容器，
 * 每个标签一个 .world-browser-viewport + 一个 <webview>（或降级 <iframe>），
 * 切标签只改 visibility，绝不销毁 DOM —— 主进程一个 lease 只能 attach 一次
 * （apps/desktop/src/browser-guests.ts:72-80）。
 *
 * 三档后端：
 *   webview  ← dshDesktop.protocolVersion === 1 且 browser 桥可用
 *   iframe   ← Web profile / 桥缺失 / acquire 失败
 *   blocked  ← iframe 也不允许时显示空态（由 onNotice / 错误页承担）
 *
 * 隐私：不读页面正文、不注入脚本；tab 的 url/title 只在窗口内部，不进 desktopState。
 */
import React from 'react'
import {
  BROWSER_WORKSPACE, MAX_TABS, createGuestAttributes, createLeasePool, createTabStore,
  describeBrowserFailure, hostLabel, parseBrowserAddress, resolveBrowserBridge,
} from './browser-frame.js'

const h = React.createElement
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'
const QUICK_LINKS = [
  { label: '示例页面', url: 'https://example.com/' },
  { label: 'MDN', url: 'https://developer.mozilla.org/' },
  { label: 'GitHub', url: 'https://github.com/' },
]

export function BrowserGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, focusable: 'false' },
    h('defs', null,
      h('linearGradient', { id: 'worldBrowserGradient', x1: '0', y1: '0', x2: '1', y2: '1' },
        h('stop', { offset: '0', stopColor: '#48b7ff' }),
        h('stop', { offset: '1', stopColor: '#2f6ee0' }))),
    h('circle', { cx: 24, cy: 24, r: 21, fill: 'url(#worldBrowserGradient)' }),
    h('circle', { cx: 24, cy: 24, r: 15, fill: 'none', stroke: 'rgba(255,255,255,.92)', strokeWidth: 1.6 }),
    h('path', {
      d: 'M9 24h30M24 9c4.2 4.2 6.2 9.3 6.2 15S28.2 34.8 24 39c-4.2-4.2-6.2-9.3-6.2-15S19.8 13.2 24 9z',
      fill: 'none', stroke: 'rgba(255,255,255,.92)', strokeWidth: 1.6, strokeLinecap: 'round',
    }))
}

function Cap({ label, onClick, close, disabled, children }) {
  return h('button', {
    type: 'button', className: `world-browser-cap${close ? ' world-browser-close' : ''}`,
    title: label, 'aria-label': label, disabled, onClick,
  }, children)
}

function Icon({ name }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (name === 'back') return h('svg', common, h('path', { d: 'M10 3 5 8l5 5' }))
  if (name === 'forward') return h('svg', common, h('path', { d: 'M6 3l5 5-5 5' }))
  if (name === 'reload') return h('svg', common, h('path', { d: 'M13.2 6.4A5.4 5.4 0 1 0 13 10' }), h('path', { d: 'M13.4 2.8v3.8H9.6' }))
  if (name === 'home') return h('svg', common, h('path', { d: 'M2.5 7.2 8 2.6l5.5 4.6v6.1H2.5z' }))
  if (name === 'external') return h('svg', common, h('path', { d: 'M9 2.8h4.2V7' }), h('path', { d: 'M13.2 2.8 7.4 8.6' }), h('path', { d: 'M11.6 9.6v3.6H2.8V4.4h3.6' }))
  return null
}

/** 新标签页：深色起始页，只有一个输入框和几个入口；不做搜索、不联网。 */
function BrowserHome({ onNavigate }) {
  const [value, setValue] = React.useState('')
  const submit = event => { event.preventDefault(); if (onNavigate(value)) setValue('') }
  return h('div', { className: 'world-browser-home', 'data-world-browser-home': true },
    h('div', { className: 'world-browser-home-mark' }, h(BrowserGlyph, { size: 56 })),
    h('strong', { className: 'world-browser-home-title' }, '浏览器'),
    h('form', { className: 'world-browser-home-form', onSubmit: submit },
      h('input', {
        type: 'text', value, 'aria-label': '输入网址', placeholder: '输入网址，例如 example.com',
        spellCheck: false, autoComplete: 'off', onChange: event => setValue(event.target.value),
      }),
      h('button', { type: 'submit' }, '前往')),
    h('div', { className: 'world-browser-home-links' },
      QUICK_LINKS.map(link => h('button', {
        key: link.url, type: 'button', onClick: () => onNavigate(link.url),
      }, link.label))),
    h('p', { className: 'world-browser-home-note' },
      '内置浏览器不支持下载、摄像头与登录持久化；受限时请用地址栏右侧的「在系统浏览器打开」。'))
}

function BrowserError({ error, onRetry, onExternal }) {
  return h('div', { className: 'world-browser-error', role: 'status', 'data-world-browser-error': true },
    h('strong', null, '网页无法加载'),
    h('code', null, `ERR_${error?.code ?? 'FAILED'}`),
    h('span', null, error?.description || describeBrowserFailure('load-failed')),
    h('div', { className: 'world-browser-error-actions' },
      h('button', { type: 'button', onClick: onRetry }, '重试'),
      h('button', { type: 'button', onClick: onExternal }, '在系统浏览器打开')))
}

/**
 * @param {object} props
 * @param {{x:number,y:number,w:number,h:number}} props.rect 百分比几何
 * @param {'normal'|'max'|'min'} props.state
 * @param {boolean} props.active 是否前台
 * @param {boolean} props.suspended 开始菜单打开 / 其它应用窗口在前台时隐藏原生视图
 */
export function BrowserWindow({
  rect, state, active, suspended, onActivate, onClose, onMinimize, onToggleMaximize,
  onDragStart, onDragMove, onDragEnd, onResizeStart, onTakeOver,
}) {
  const [bridge] = React.useState(resolveBrowserBridge)
  const [store] = React.useState(() => {
    const instance = createTabStore()
    instance.addTab()
    return instance
  })
  const [pool] = React.useState(() => bridge ? createLeasePool({ bridge, workspace: BROWSER_WORKSPACE }) : null)
  const tabs = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [address, setAddress] = React.useState('')
  const [addressFocused, setAddressFocused] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [compatDismissed, setCompatDismissed] = React.useState(false)
  const [compat, setCompat] = React.useState(!bridge)
  const viewsRef = React.useRef(null)
  const guestsRef = React.useRef(new Map())
  const aliveRef = React.useRef(true)
  const noticeTimer = React.useRef(0)
  const appOrigin = typeof window === 'undefined' ? undefined : window.location?.origin

  const activeTab = tabs.tabs.find(tab => tab.id === tabs.activeId) || null
  const minimized = state === 'min'
  const maximized = state === 'max'
  const hiddenViews = Boolean(suspended) || minimized

  const showNotice = text => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3200)
  }

  React.useEffect(() => {
    if (!addressFocused) setAddress(activeTab?.url || '')
  }, [activeTab?.url, activeTab?.title, addressFocused])

  React.useEffect(() => () => {
    aliveRef.current = false
    window.clearTimeout(noticeTimer.current)
    for (const id of [...guestsRef.current.keys()]) unmountGuest(id)
    void pool?.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentTab = id => store.getSnapshot().tabs.find(tab => tab.id === id)

  const unmountGuest = id => {
    const guest = guestsRef.current.get(id)
    if (!guest) return
    guestsRef.current.delete(id)
    for (const off of guest.disposers) {
      try { off() } catch { /* 卸载时不再向外抛 */ }
    }
    guest.element.remove()
    if (guest.lease) void pool?.release(guest.lease)
  }

  const observe = id => {
    const guest = guestsRef.current.get(id)
    if (!guest || guest.mode !== 'webview' || !guest.ready || !aliveRef.current) return
    const element = guest.element
    try {
      const url = element.getURL?.()
      const title = element.getTitle?.()
      const patch = {
        address: 'observed',
        loading: Boolean(element.isLoading?.()),
        canGoBack: Boolean(element.canGoBack?.()),
        canGoForward: Boolean(element.canGoForward?.()),
      }
      if (typeof url === 'string' && /^https?:/u.test(url)) patch.url = url
      if (title) patch.title = title
      store.update(id, patch)
    } catch { /* guest 正在销毁，忽略 */ }
  }

  const fail = (id, cause) => {
    if (!aliveRef.current) return
    store.update(id, {
      loading: false,
      error: {
        code: cause?.code ?? 'FAILED',
        description: cause?.description || cause?.message || describeBrowserFailure('load-failed'),
      },
    })
  }

  const openInNewTab = url => {
    const parsed = parseBrowserAddress(url, appOrigin)
    if (!parsed.ok) return
    if (!store.addTab({ url: parsed.target.url, title: parsed.target.title, address: 'requested' })) {
      showNotice(describeBrowserFailure('tab-limit'))
    }
  }

  /** 一个标签 = 一个 lease；异步 acquire 期间标签被关掉时不留下悬空 guest。 */
  const mountGuest = async tab => {
    const views = viewsRef.current
    if (!views || guestsRef.current.has(tab.id)) return
    const viewport = views.querySelector(`[data-world-browser-viewport="${tab.id}"]`)
    if (!viewport) return
    let reservation = null
    let mode = bridge ? 'webview' : 'iframe'
    if (mode === 'webview') {
      try { reservation = await pool.acquire() }
      catch {
        mode = 'iframe'
        setCompat(true)
        showNotice(describeBrowserFailure('bridge-failed'))
      }
    }
    const current = currentTab(tab.id)
    if (!aliveRef.current || !current?.url || guestsRef.current.has(tab.id)) {
      if (reservation) void pool.release(reservation.lease)
      return
    }

    const element = document.createElement(mode === 'webview' ? 'webview' : 'iframe')
    element.className = 'world-browser-frame'
    element.setAttribute('title', `浏览器标签 ${tab.id}`)
    const guest = {
      id: tab.id, element, viewport, mode, ready: false,
      lease: reservation?.lease || null, disposers: [],
    }
    guestsRef.current.set(tab.id, guest)
    const listen = (name, handler, options) => {
      element.addEventListener(name, handler, options)
      guest.disposers.push(() => element.removeEventListener(name, handler, options))
    }

    if (mode === 'webview') {
      // 必须在 append 之前写好：主进程 will-attach-webview 校验 src/partition
      for (const [key, value] of Object.entries(createGuestAttributes(reservation))) {
        element.setAttribute(key, value)
      }
      const unsubscribeOpen = pool.watchOpen(guest.lease, url => {
        if (aliveRef.current && guestsRef.current.get(tab.id) === guest) openInNewTab(url)
      })
      guest.disposers.push(unsubscribeOpen)
      listen('dom-ready', () => {
        if (!aliveRef.current || guestsRef.current.get(tab.id) !== guest) return
        guest.ready = true
        try { element.clearHistory?.() } catch { /* 引导页不算历史 */ }
        const target = currentTab(tab.id)?.url
        if (target) void Promise.resolve(element.loadURL?.(target)).catch(error => fail(tab.id, error))
      }, { once: true })
      listen('did-navigate', () => { store.update(tab.id, { error: null }); observe(tab.id) })
      listen('did-navigate-in-page', event => { if (event?.isMainFrame !== false) observe(tab.id) })
      listen('page-title-updated', () => observe(tab.id))
      listen('did-start-navigation', event => {
        if (event?.isMainFrame !== false) store.update(tab.id, { loading: true, error: null })
      })
      listen('did-start-loading', () => store.update(tab.id, { loading: true }))
      listen('did-stop-loading', () => { store.update(tab.id, { loading: false }); observe(tab.id) })
      listen('did-fail-load', event => {
        if (event?.isMainFrame === false || event?.errorCode === -3) return
        fail(tab.id, { code: event?.errorCode, description: event?.errorDescription })
      })
      for (const name of ['render-process-gone', 'destroyed']) {
        listen(name, () => { unmountGuest(tab.id); fail(tab.id, { code: 'GONE', description: '网页进程已退出，请重试' }) })
      }
      listen('focus', () => onTakeOver?.())
    } else {
      element.setAttribute('sandbox', IFRAME_SANDBOX)
      element.setAttribute('referrerpolicy', 'no-referrer')
      listen('load', () => store.update(tab.id, {
        loading: false, address: 'unknown', canGoBack: false, canGoForward: false,
      }))
      element.src = current.url
    }
    listen('pointerdown', () => onTakeOver?.(), true)
    viewport.append(element)
    store.update(tab.id, { mode, error: null, loading: true })
  }

  // 命令式协调：tab 增删 / url 变化 / 前后台切换都走这里，React 不碰 viewport 内的节点
  React.useEffect(() => {
    const views = viewsRef.current
    if (!views) return
    const live = new Set(tabs.tabs.map(tab => tab.id))
    for (const id of [...guestsRef.current.keys()]) {
      if (!live.has(id) || !currentTab(id)?.url) unmountGuest(id)
    }
    for (const node of [...views.children]) {
      if (!live.has(node.dataset.worldBrowserViewport)) node.remove()
    }
    for (const tab of tabs.tabs) {
      if (![...views.children].some(node => node.dataset.worldBrowserViewport === tab.id)) {
        const viewport = document.createElement('div')
        viewport.className = 'world-browser-viewport'
        viewport.dataset.worldBrowserViewport = tab.id
        views.append(viewport)
      }
    }
    for (const node of views.children) {
      const shown = node.dataset.worldBrowserViewport === tabs.activeId && !hiddenViews
        && !currentTab(node.dataset.worldBrowserViewport)?.error
      node.style.visibility = shown ? 'visible' : 'hidden'
      node.setAttribute('aria-hidden', shown ? 'false' : 'true')
    }
    for (const tab of tabs.tabs) {
      if (tab.url && !tab.error && !guestsRef.current.has(tab.id)) void mountGuest(tab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, hiddenViews])

  const navigate = value => {
    const parsed = parseBrowserAddress(value, appOrigin)
    if (!parsed.ok) { showNotice(describeBrowserFailure(parsed.reason)); return false }
    const id = store.activeId
    if (!id) return false
    store.update(id, {
      url: parsed.target.url, title: parsed.target.title, address: 'requested',
      error: null, loading: true, canGoBack: false, canGoForward: false,
    })
    setAddress(parsed.target.url)
    const guest = guestsRef.current.get(id)
    if (guest?.mode === 'webview' && guest.ready) {
      void Promise.resolve(guest.element.loadURL?.(parsed.target.url)).catch(error => fail(id, error))
    } else if (guest?.mode === 'iframe') {
      guest.element.src = parsed.target.url
    }
    return true
  }

  const command = action => {
    const id = store.activeId
    const guest = id ? guestsRef.current.get(id) : null
    if (action === 'home') {
      if (id) store.update(id, {
        url: '', title: '新标签页', address: 'requested', error: null,
        loading: false, canGoBack: false, canGoForward: false, mode: 'pending',
      })
      return
    }
    if (action === 'external') {
      if (activeTab?.url) window.open(activeTab.url, '_blank', 'noopener')
      else showNotice('当前是起始页，没有可在系统浏览器打开的网址')
      return
    }
    if (action === 'retry') {
      if (guest?.mode === 'webview' && guest.ready) {
        store.update(id, { error: null, loading: true })
        void Promise.resolve(guest.element.reload?.()).catch(error => fail(id, error))
      } else if (activeTab?.url) {
        // guest 已经掉了：清掉 url 再写回，触发协调重新挂载
        store.update(id, { url: '', error: null })
        window.setTimeout(() => store.update(id, { url: activeTab.url }), 0)
      }
      return
    }
    if (!guest || guest.mode !== 'webview' || !guest.ready) return
    const element = guest.element
    if (action === 'back') element.goBack?.()
    else if (action === 'forward') element.goForward?.()
    else if (action === 'reload') {
      store.update(id, { error: null, loading: true })
      void Promise.resolve(element.reload?.()).catch(error => fail(id, error))
    }
  }

  const onAddressKeyDown = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (navigate(address)) event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setAddress(activeTab?.url || '')
      event.currentTarget.blur()
    }
  }

  const style = maximized
    ? { '--vscode-x': '0vw', '--vscode-y': '0vh', '--vscode-w': '100vw',
      '--vscode-h': 'calc(100vh - var(--world-desktop-top) - var(--world-taskbar-height))' }
    : { '--vscode-x': `${rect.x}vw`, '--vscode-y': `${rect.y}vh`,
      '--vscode-w': `${rect.w}vw`, '--vscode-h': `${rect.h}vh` }

  const banner = notice || (compat && !compatDismissed
    ? '兼容模式：当前环境无法创建独立网页容器，部分网站会拒绝嵌入。'
    : '')

  return h('section', {
    className: `world-vscode-window world-browser-window${maximized ? ' is-max' : ''}${minimized ? ' is-min' : ''}${active ? ' is-active' : ''}`,
    'data-world-app': 'browser', 'data-world-browser-mode': compat ? 'iframe' : 'webview',
    'aria-label': '浏览器', 'aria-hidden': minimized, style, onPointerDown: onActivate,
  },
    h('header', {
      className: 'world-vscode-titlebar',
      onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
      onDoubleClick: event => { if (!event.target.closest('button')) onToggleMaximize() },
    },
      h('div', { className: 'world-vscode-title' },
        h(BrowserGlyph, { size: 16 }), h('span', null, '浏览器')),
      h('div', { className: 'world-vscode-controls world-vscode-caps' },
        h(Cap, { label: '最小化', onClick: onMinimize },
          h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
            h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
        h(Cap, { label: maximized ? '还原' : '最大化', onClick: onToggleMaximize },
          h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
            h('rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))),
        h(Cap, { label: '关闭', close: true, onClick: onClose },
          h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
            h('path', { d: 'M0 0l10 10M10 0L0 10', stroke: 'currentColor', strokeWidth: 1 }))))),
    h('div', { className: 'world-browser-tabs', role: 'tablist', 'aria-label': '浏览器标签' },
      tabs.tabs.map(tab => h('div', {
        key: tab.id, role: 'tab', 'aria-selected': tab.id === tabs.activeId,
        className: `world-browser-tab${tab.id === tabs.activeId ? ' on' : ''}`,
        'data-world-browser-tab': tab.id, title: tab.title,
        onClick: () => store.activate(tab.id),
        onAuxClick: event => { if (event.button === 1) { event.preventDefault(); store.closeTab(tab.id) } },
      },
        h('span', { className: 'world-browser-tab-title' }, tab.title || hostLabel(tab.url)),
        h('button', {
          type: 'button', className: 'world-browser-tab-close', title: '关闭标签', 'aria-label': '关闭标签',
          onClick: event => { event.stopPropagation(); store.closeTab(tab.id) },
        }, '×'))),
      h('button', {
        type: 'button', className: 'world-browser-tab-add', title: '新建标签', 'aria-label': '新建标签',
        'data-world-browser-add': true, disabled: tabs.tabs.length >= MAX_TABS,
        onClick: () => { if (!store.addTab()) showNotice(describeBrowserFailure('tab-limit')) },
      }, '+')),
    h('div', { className: 'world-browser-toolbar' },
      h(Cap, { label: '后退', disabled: !activeTab?.canGoBack || compat, onClick: () => command('back') }, h(Icon, { name: 'back' })),
      h(Cap, { label: '前进', disabled: !activeTab?.canGoForward || compat, onClick: () => command('forward') }, h(Icon, { name: 'forward' })),
      h(Cap, { label: '刷新', onClick: () => command('reload') }, h(Icon, { name: 'reload' })),
      h(Cap, { label: '起始页', onClick: () => command('home') }, h(Icon, { name: 'home' })),
      h('input', {
        className: 'world-browser-address', type: 'text', value: address,
        'data-world-browser-address': true, 'aria-label': '地址栏', spellCheck: false, autoComplete: 'off',
        placeholder: '输入网址，例如 example.com',
        onChange: event => setAddress(event.target.value),
        onFocus: () => setAddressFocused(true),
        onBlur: () => setAddressFocused(false),
        onKeyDown: onAddressKeyDown,
      }),
      h(Cap, { label: '在系统浏览器打开', onClick: () => command('external') }, h(Icon, { name: 'external' })),
      h('div', { className: `world-browser-progress${activeTab?.loading ? ' on' : ''}`, 'aria-hidden': true })),
    banner
      ? h('div', { className: 'world-browser-notice', role: 'status', 'data-world-browser-notice': true },
        h('span', null, banner),
        h('button', {
          type: 'button', title: '关闭提示', 'aria-label': '关闭提示',
          onClick: () => { setNotice(''); setCompatDismissed(true) },
        }, '×'))
      : null,
    h('div', { className: 'world-browser-content' },
      h('div', { className: 'world-browser-views', ref: viewsRef }),
      activeTab && !activeTab.url && !minimized
        ? h(BrowserHome, { onNavigate: navigate })
        : null,
      activeTab?.error && !minimized
        ? h(BrowserError, {
          error: activeTab.error,
          onRetry: () => command('retry'),
          onExternal: () => command('external'),
        })
        : null,
      hiddenViews && !minimized && activeTab?.url
        ? h('div', { className: 'world-browser-paused', 'data-world-browser-paused': true },
          '网页容器已隐藏（窗口不在前台）')
        : null),
    !minimized && !maximized
      ? RESIZE_EDGES.map(edge => h('div', {
        key: edge, className: `world-vscode-resize world-vscode-resize-${edge}`, 'aria-hidden': true,
        onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
      }))
      : null)
}
