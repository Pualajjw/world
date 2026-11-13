import React from 'react'
import { createPortal } from 'react-dom'
import { VscodeGlyph, VscodeWindow } from './vscode-app.js'
import { LanChatGlyph, LanChatWindow } from './lan-chat-app.js'
import { BrowserGlyph, BrowserWindow } from './browser-app.js'
import { TerminalGlyph, TerminalWindow } from './terminal-app.js'
import { DeskWalker } from './walker.js'
import { layoutDeskIcons, groundOf } from './plane.js'
import {
  APP_FILE_PATTERN, parseWorldApp, readExternalApps, saveExternalApps,
  readExternalRect, saveExternalRect, removeExternalRect, clampAppRect,
  ExternalAppGlyph, ExternalAppWindow,
} from './external-apps.js'
import {
  PLUGIN_SLOT, PluginGlyph, PluginWindow, clampPluginRect, createPluginCatalog,
  readPluginRect, savePluginRect,
} from './plugin-apps.js'
import stylesheet from './styles.css'
import { desktopError, startDesktopClient, waitForDesktop } from './desktop-client.js'
import { createDesktopControl, observeDesktopInput } from './desktop-control.js'
import { createDesktopUi } from './desktop-ui.js'
import { createAssistantPointer } from './assistant-pointer.js'
import { AssistantPointer } from './assistant-pointer-view.js'
import { UI_ACTIONS } from './desktop-ui-protocol.js'
import { createJournalClient } from './journal-client.js'
import { JOURNAL_APPS, JournalPage } from './journal-app.js'
import { TASK_APPS, TasksPage } from './task-app.js'
import { FileLinkGlyph, HolderGlyph, HolderPage, RenameDialog } from './holder-app.js'
import { openNativeSettings } from './native-settings.js'
import { HOST_PANELS, openHostPanel } from './host-panels.js'
import { version as WORLD_VERSION } from './package.json'
import { PHONE_BREAKPOINT, isPhoneViewport, fitSavedDesktopRect } from './responsive.js'
import { WorkbenchSetup } from './workbench-setup.js'
import { readWallpaper, saveWallpaper, wallpaperFor, wallpaperStyle, wallpaperTone } from './wallpaper.js'
import { WallpaperPanel } from './wallpaper-panel.js'
import { MobileConnect, MobileGlyph } from './mobile-connect.js'
import { activityTiming } from './assistant-activity.js'
import { createConversationSeat } from './conversation-seat.js'
import { captureDesktopScreenshot } from './desktop-shot.js'
import {
  ASSISTANT_CONVERSATION_SLOT, AssistantConversation, AssistantConversationContent,
  suspendMainConversation, observeConversationPortals,
} from './assistant-conversation.js'

export const inject = ['slots', 'sessions', 'remote', 'remote.workspaceFiles', 'connection', 'layout']

const h = React.createElement
const STORAGE_KEY = 'dsh.world.window.position'
const APPS_STORAGE_KEY = 'dsh.world.apps'
const VSCODE_STORAGE_KEY = 'dsh.world.vscode.window'
const LANCHAT_STORAGE_KEY = 'dsh.world.lanchat.window'
const BROWSER_STORAGE_KEY = 'dsh.world.browser.window'
const TERMINAL_STORAGE_KEY = 'dsh.world.terminal.window'
const BROWSER_MIGRATION_KEY = 'dsh.world.browser.migrated'
const TERMINAL_MIGRATION_KEY = 'dsh.world.terminal.migrated'
const DEPTH_STORAGE_KEY = 'dsh.world.depth'
const ICON_POSITIONS_KEY = 'dsh.world.iconPositions'
const FILE_LINKS_KEY = 'dsh.world.fileLinks'
const HOLDERS_KEY = 'dsh.world.holders'
const KNOWN_APPS = ['vscode', 'lanchat', 'browser', 'terminal']
const TASKBAR_HEIGHT = 48
/** 窗口最小尺寸（CSS 像素）：主窗口过去没有下限，能被拖成一条 2px 的缝，找不回来。 */
const MIN_WINDOW_WIDTH = 720
const MIN_WINDOW_HEIGHT = 480
/** 甩到桌面顶边多近算「要最大化」（CSS 像素）。 */
const TOP_SNAP_SLACK = 6
const DEFAULT_POSITION = { x: 20, y: 9, w: 60, h: 68 }
const EMPTY_APPS = []
const NOOP_SUBSCRIBE = () => () => {}
const EMPTY_CATALOG = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => EMPTY_APPS }
/** 设置、日记、待办只在开始菜单里出现；桌面上不摆这三个图标。 */
const DESKTOP_HIDDEN = new Set(['settings', 'plugins', 'plugin:world-diary', 'plugin:world-tasks'])
const KIND_HINTS = { app: '应用', external: '外部应用', file: '文件', directory: '文件夹', holder: '收纳盒' }
const DIALOG_ROLES = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"]'

function dialogVars(node, rect) {
  node.style.setProperty('--world-dialog-x', `${rect.x}vw`)
  node.style.setProperty('--world-dialog-y', `${rect.y}vh`)
  node.style.setProperty('--world-dialog-w', `${rect.w}vw`)
  node.style.setProperty('--world-dialog-h', `${rect.h}vh`)
}

function currentMainSession(sessions) {
  const list = sessions?.list?.getSnapshot?.()
  const row = list && Object.values(list.byId || {}).find(item => (item.retainedBy?.mainView || 0) > 0)
  return row ? { id: row.id, cwd: row.cwd || '' } : null
}

/**
 * 浏览器和终端像 Win11 自带的应用：默认已安装、允许卸载。
 * 老配置里没有终端，所以迁移只补一次——卸载过的人不会下次打开又被装回来。
 */
function readInstalledApps() {
  try {
    const raw = window.localStorage.getItem(APPS_STORAGE_KEY)
    if (raw === null) return new Set(['browser', 'terminal'])
    const value = JSON.parse(raw || '[]')
    const apps = Array.isArray(value) ? new Set(value.filter(id => KNOWN_APPS.includes(id))) : new Set()
    if (!window.localStorage.getItem(BROWSER_MIGRATION_KEY)) {
      apps.add('browser')
      saveInstalledApps(apps)
      window.localStorage.setItem(BROWSER_MIGRATION_KEY, '1')
    }
    if (!window.localStorage.getItem(TERMINAL_MIGRATION_KEY)) {
      apps.add('terminal')
      saveInstalledApps(apps)
      window.localStorage.setItem(TERMINAL_MIGRATION_KEY, '1')
    }
    return apps
  } catch { return new Set(['browser', 'terminal']) }
}

function saveInstalledApps(apps) {
  try { window.localStorage.setItem(APPS_STORAGE_KEY, JSON.stringify([...apps])) } catch {}
}

// 3D 景深默认开启；关掉后退回原来的平面壁纸（视差与地面透视全部停止）。
function readDepth() {
  try {
    const value = window.localStorage.getItem(DEPTH_STORAGE_KEY)
    return value === null ? true : value === 'on'
  } catch { return true }
}

function saveDepth(on) {
  try { window.localStorage.setItem(DEPTH_STORAGE_KEY, on ? 'on' : 'off') } catch {}
}

function readIconPositions() {
  const sane = value => {
    const out = {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out
    for (const [key, position] of Object.entries(value)) {
      if (typeof key !== 'string' || !key || !position || typeof position !== 'object') continue
      const x = Number(position.x), y = Number(position.y)
      if (Number.isFinite(x) && Number.isFinite(y)) {
        // vw/vh 是存下这个位置时的视口（平面模式是容器）尺寸，换尺寸时按比例还原。
        const vw = Number(position.vw), vh = Number(position.vh)
        out[key] = Number.isFinite(vw) && Number.isFinite(vh) && vw > 0 && vh > 0
          ? { x, y, vw, vh }
          : { x, y }
      }
    }
    return out
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(ICON_POSITIONS_KEY) || '{}')
    return { flat: sane(value?.flat), depth: sane(value?.depth) }
  } catch { return { flat: {}, depth: {} } }
}

function saveIconPositions(value) {
  try { window.localStorage.setItem(ICON_POSITIONS_KEY, JSON.stringify(value)) } catch {}
}

/** 图标当前的边长：窗口缩小时 plane.js 会整档降低，拖动/落点都得按它收边。 */
function iconSizeOf(container) {
  if (!container) return 0
  if (typeof window === 'undefined' || !window.getComputedStyle) return 0
  const raw = getComputedStyle(container).getPropertyValue('--world-icon-size')
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 96
}

const newId = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('')
const slashPath = path => String(path || '').replaceAll('\\', '/')
const baseNameOf = path => slashPath(path).split('/').filter(Boolean).at(-1) || slashPath(path)
function dirNameOf(path) {
  const text = slashPath(path)
  const index = text.lastIndexOf('/')
  if (index < 0) return ''
  const dir = text.slice(0, index)
  return /^[a-zA-Z]:$/u.test(dir) ? `${dir}/` : dir
}

function readFileLinks() {
  try {
    const value = JSON.parse(window.localStorage.getItem(FILE_LINKS_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter(item => item && typeof item.id === 'string' && item.id.startsWith('file:')
      && typeof item.path === 'string' && item.path && typeof item.name === 'string' && item.name)
      .map(item => ({ id: item.id, path: item.path, name: item.name, type: item.type === 'directory' ? 'directory' : 'file' }))
  } catch { return [] }
}

function saveFileLinks(value) {
  try { window.localStorage.setItem(FILE_LINKS_KEY, JSON.stringify(value)) } catch {}
}

function readHolders() {
  try {
    const value = JSON.parse(window.localStorage.getItem(HOLDERS_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter(item => item && typeof item.id === 'string' && item.id.startsWith('holder:')
      && typeof item.name === 'string' && item.name && Array.isArray(item.items))
      .map(item => ({ id: item.id, name: item.name.slice(0, 40), items: item.items.filter(id => typeof id === 'string' && id) }))
  } catch { return [] }
}

function saveHolders(value) {
  try { window.localStorage.setItem(HOLDERS_KEY, JSON.stringify(value)) } catch {}
}

function readLanChatRect() {
  try {
    const value = JSON.parse(window.localStorage.getItem(LANCHAT_STORAGE_KEY) || 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return fitSavedDesktopRect(value, clampVscodeRect)
  } catch {}
  return defaultVscodeRect()
}

function readBrowserRect() {
  try {
    const value = JSON.parse(window.localStorage.getItem(BROWSER_STORAGE_KEY) || 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return fitSavedDesktopRect(value, clampVscodeRect)
  } catch {}
  return defaultVscodeRect()
}

function readTerminalRect() {
  try {
    const value = JSON.parse(window.localStorage.getItem(TERMINAL_STORAGE_KEY) || 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return fitSavedDesktopRect(value, clampVscodeRect)
  } catch {}
  return defaultVscodeRect()
}

function defaultVscodeRect() {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
  const availableHeight = Math.max(0, height - top - TASKBAR_HEIGHT)
  const windowWidth = Math.min(width, Math.max(Math.min(720, width), width * 0.8))
  const windowHeight = Math.min(availableHeight, Math.max(Math.min(480, availableHeight), height * 0.8))
  return { x: Math.max(0, (width - windowWidth) / 2) / width * 100,
    y: (top + Math.max(0, (availableHeight - windowHeight) / 2)) / height * 100,
    w: windowWidth / width * 100, h: windowHeight / height * 100 }
}

function readVscodeRect() {
  try {
    const value = JSON.parse(window.localStorage.getItem(VSCODE_STORAGE_KEY) || 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return fitSavedDesktopRect(value, clampVscodeRect)
  } catch {}
  return defaultVscodeRect()
}

/** 任务栏显示文件夹名：多开时一眼看出哪个窗口开的是哪个目录。 */
function folderName(path) {
  const text = String(path || '').replace(/[\\/]+$/u, '')
  return text.split(/[\\/]/u).filter(Boolean).at(-1) || 'Visual Studio Code'
}

/** 文件夹身份：统一分隔符、去掉结尾斜杠；Windows 盘符 / UNC 路径大小写不敏感。 */
function vscodeFolderKey(path) {
  const text = String(path || '').replace(/\\/g, '/').replace(/\/+$/u, '')
  return /^[a-zA-Z]:\//u.test(text) || text.startsWith('//') ? text.toLowerCase() : text
}

function clampVscodeRect(rect) {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
  const minW = Math.min(width, 720) / width * 100
  const minH = Math.min(Math.max(0, height - top - TASKBAR_HEIGHT), 480) / height * 100
  const w = Math.min(100, Math.max(minW, Number(rect.w) || minW))
  const h = Math.min(Math.max(0, (height - top - TASKBAR_HEIGHT) / height * 100), Math.max(minH, Number(rect.h) || minH))
  const x = Math.min(100 - w, Math.max(0, Number(rect.x) || 0))
  const minY = top / height * 100
  const maxY = Math.max(minY, (height - TASKBAR_HEIGHT - height * h / 100) / height * 100)
  return { x, y: Math.min(maxY, Math.max(minY, Number(rect.y) || minY)), w, h }
}

function clampRect(rect) {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const desktopTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
  const minY = desktopTop / height * 100
  const maxWidth = 100
  const maxHeight = Math.max(0, (height - desktopTop - TASKBAR_HEIGHT) / height * 100)
  const minW = Math.min(width, MIN_WINDOW_WIDTH) / width * 100
  const minH = Math.min(Math.max(0, height - desktopTop - TASKBAR_HEIGHT), MIN_WINDOW_HEIGHT) / height * 100
  const w = Math.min(maxWidth, Math.max(minW, Number(rect?.w) || minW))
  const h = Math.min(maxHeight, Math.max(minH, Number(rect?.h) || minH))
  const x = Math.min(100 - w, Math.max(0, Number(rect?.x) || 0))
  const maxY = Math.max(minY, (height - TASKBAR_HEIGHT - height * h / 100) / height * 100)
  return {
    x,
    y: Math.min(maxY, Math.max(minY, Number(rect?.y) || minY)),
    w,
    h,
  }
}

/** 指针在桌面顶边松手：按 Windows 的手感把这个窗口最大化，而不是留一条贴在标题栏下的缝。 */
function droppedOnTopEdge(event) {
  const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
  return event.clientY <= top + TOP_SNAP_SLACK
}

/**
 * 这次拖动到底动没动（不是点了一下）。
 * 不能只看窗口坐标有没有变：窗口已经贴在顶边时再往上拖，clamp 之后位置一个像素都不变，
 * 那种情况恰恰是最想「甩到顶部」的一次。
 */
function dragTraveled(event, drag) {
  const x = Number.isFinite(drag?.startX) ? drag.startX : drag?.x
  const y = Number.isFinite(drag?.startY) ? drag.startY : drag?.y
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return Math.hypot(event.clientX - x, event.clientY - y) >= 4
}

function readPosition() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) return fitSavedDesktopRect({ ...DEFAULT_POSITION, ...stored }, clampRect)
  } catch {}
  return DEFAULT_POSITION
}

function savePosition(position) {
  saveRect(STORAGE_KEY, position)
}

/** 窗口位置落盘：localStorage 不可用（file://、无存储的 webview）时不能把拖拽/缩放也带崩。 */
function saveRect(key, rect) {
  try { window.localStorage.setItem(key, JSON.stringify(rect)) } catch {}
}

function usePortalContainer() {
  const [container, setContainer] = React.useState(null)
  React.useLayoutEffect(() => {
    // Electron combines drag regions in document order. Place the native row
    // before the host menus so their no-drag regions keep accepting clicks.
    const titlebar = document.createElement('div')
    titlebar.className = 'world-desktop-titlebar'
    titlebar.dataset.worldPortal = 'dsh-world-titlebar'
    titlebar.setAttribute('aria-hidden', 'true')
    document.body.prepend(titlebar)
    const node = document.createElement('div')
    node.dataset.worldPortal = 'dsh-world'
    node.style.display = 'contents'
    document.body.append(node)
    setContainer(node)
    return () => { node.remove(); titlebar.remove() }
  }, [])
  return container
}

function useHostWindow(state, position) {
  const [rootReady, setRootReady] = React.useState(() => Boolean(document.getElementById('root')))

  React.useLayoutEffect(() => {
    const body = document.body
    const previousState = body.getAttribute('data-world-window')
    const propertyNames = ['--world-win-x', '--world-win-y', '--world-win-w', '--world-win-h']
    const previousProperties = new Map(propertyNames.map(name => [name, [body.style.getPropertyValue(name), body.style.getPropertyPriority(name)]]))
    const previousInert = new Map()

    const syncRoot = () => {
      const root = document.getElementById('root')
      const locked = new Set()
      if (root && (state === 'closed' || state === 'min')) {
        const overlay = root.querySelector('[data-shell-overlay]')
        const frame = overlay?.parentElement
        if (frame) for (const sibling of frame.children) if (sibling !== overlay) locked.add(sibling)
        for (const sibling of body.children) {
          if (sibling !== root && sibling.dataset.worldPortal !== 'dsh-world' && sibling.dataset.worldPortal !== 'dsh-world-titlebar'
            && sibling.dataset.windowsMenu === undefined && sibling.dataset.worldDialog === undefined) locked.add(sibling)
        }
      }
      for (const [element, inert] of previousInert) if (!locked.has(element)) {
        element.inert = inert
        previousInert.delete(element)
      }
      for (const element of locked) {
        if (!previousInert.has(element)) previousInert.set(element, element.inert)
        element.inert = true
      }
      setRootReady(Boolean(root))
    }

    body.dataset.worldWindow = state
    body.style.setProperty('--world-win-x', `${position.x}vw`)
    body.style.setProperty('--world-win-y', `${position.y}vh`)
    body.style.setProperty('--world-win-w', `${position.w}vw`)
    body.style.setProperty('--world-win-h', `${position.h}vh`)
    syncRoot()

    const observer = new MutationObserver(syncRoot)
    observer.observe(document.documentElement, { childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-world-portal'] })
    return () => {
      observer.disconnect()
      for (const [element, inert] of previousInert) element.inert = inert
      if (previousState === null) body.removeAttribute('data-world-window')
      else body.setAttribute('data-world-window', previousState)
      for (const [name, [value, priority]] of previousProperties) {
        if (value) body.style.setProperty(name, value, priority)
        else body.style.removeProperty(name)
      }
    }
  }, [state, position.x, position.y, position.w, position.h])

  return rootReady
}

/** Mirror the native layout state; the Host remains the only owner of sidebar visibility. */
function useHostSidebar() {
  const [sidebar, setSidebar] = React.useState(null)
  React.useLayoutEffect(() => {
    const sync = () => {
      const root = document.getElementById('root')
      const frame = root?.querySelector('[data-shell-overlay]')?.parentElement
      const nativeToggle = root?.querySelector('[data-sidebar-toggle],[data-sidebar-opener]')
      const next = frame && nativeToggle ? { collapsed: frame.hasAttribute('data-sidebar-collapsed'), blocked: root.inert } : null
      setSidebar(previous => previous?.collapsed === next?.collapsed && previous?.blocked === next?.blocked ? previous : next)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-sidebar-collapsed', 'inert'] })
    return () => observer.disconnect()
  }, [])
  return sidebar
}

/** Keep background apps mounted, but remove them from phone input and keyboard navigation. */
function usePhoneWindows(phone, activeWindow) {
  React.useLayoutEffect(() => {
    if (!phone) return
    const previous = new Map()
    const sync = () => {
      for (const node of document.querySelectorAll('.world-window-frame,.world-vscode-window,.world-plugin-window,body > [data-world-dialog]')) {
        if (node.dataset.worldAssistantDialog === 'true') continue
        const id = node.classList.contains('world-window-frame') ? 'dsh'
          : node.dataset.worldPlugin ? `plugin:${node.dataset.worldPlugin}`
          : node.dataset.worldDialog ? `plugin:${node.dataset.worldDialog}`
          : node.dataset.worldAppId ? `ext:${node.dataset.worldAppId}`
          : node.dataset.worldVscodeKey ? `vscode:${node.dataset.worldVscodeKey}`
          : node.classList.contains('world-lanchat-window') ? 'lanchat' : node.dataset.worldApp
        if (!previous.has(node)) previous.set(node, node.inert)
        const hidden = id !== activeWindow
        node.toggleAttribute('data-world-phone-hidden', hidden)
        node.inert = hidden || previous.get(node)
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-world-dialog'] })
    return () => {
      observer.disconnect()
      for (const [node, inert] of previous) {
        node.inert = inert
        node.removeAttribute('data-world-phone-hidden')
      }
    }
  }, [phone, activeWindow])
}

function PhoneGlyph({ kind }) {
  return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
    kind === 'home' ? h('circle', { cx: 12, cy: 12, r: 7 })
      : kind === 'recent' ? h('rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 })
        : h('path', { d: 'M5 6h14M5 12h14M5 18h14', strokeLinecap: 'round' }))
}

/** 开始菜单 / 桌面上的「设置」图标：一个齿轮，跟桌面其它图标一样用 currentColor。 */
function SettingsGlyph({ size = 20 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
    h('circle', { cx: 12, cy: 12, r: 3.1 }),
    h('path', {
      strokeLinecap: 'round', strokeLinejoin: 'round',
      d: 'M19.1 14.6a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V20.5a1.94 1.94 0 1 1-3.88 0v-.1a1.6 1.6 0 0 0-1.04-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H3.5a1.94 1.94 0 1 1 0-3.88h.1a1.6 1.6 0 0 0 1.46-1.04 1.6 1.6 0 0 0-.32-1.77l-.06-.06A1.94 1.94 0 1 1 7.43 4.9l.06.06a1.6 1.6 0 0 0 1.77.32H9.3a1.6 1.6 0 0 0 .97-1.47V3.5a1.94 1.94 0 1 1 3.88 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.05a1.6 1.6 0 0 0 1.47.97h.1a1.94 1.94 0 1 1 0 3.88h-.1a1.6 1.6 0 0 0-1.47.97z',
    }))
}

/** 开始菜单 / 搜索里的「插件」：只能在 DSH 窗口里打开的宿主页面。 */
function PluginsGlyph({ size = 20 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
    h('rect', { x: 3, y: 3, width: 7.4, height: 7.4, rx: 1.6 }),
    h('rect', { x: 13.6, y: 3, width: 7.4, height: 7.4, rx: 1.6 }),
    h('rect', { x: 3, y: 13.6, width: 7.4, height: 7.4, rx: 1.6 }),
    h('rect', { x: 13.6, y: 13.6, width: 7.4, height: 7.4, rx: 1.6, strokeDasharray: '2.6 2.2' }))
}

function DshMark({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true },
    h('rect', { x: 2, y: 2, width: 44, height: 44, rx: 11, fill: '#4cc2ff' }),
    h('path', { d: 'M13 17.5 19.5 24 13 30.5', fill: 'none', stroke: '#062b47', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    h('path', { d: 'M23 30.5h11', stroke: '#062b47', strokeWidth: 4, strokeLinecap: 'round' }))
}

function WindowControls({ state, onMinimize, onToggleMaximize, onClose }) {
  const maximized = state === 'max'
  return h('div', { className: 'world-window-controls' },
    h('button', { className: 'world-cap', type: 'button', title: '最小化', 'aria-label': '最小化', onClick: onMinimize },
      h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true }, h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
    h('button', { className: 'world-cap', type: 'button', title: maximized ? '还原' : '最大化', 'aria-label': maximized ? '还原' : '最大化', onClick: onToggleMaximize },
      maximized
        ? h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('rect', { x: 0.5, y: 2.5, width: 7, height: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }),
          h('path', { d: 'M2.5 2.5V.5h7v7h-2', fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))
        : h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true }, h('rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))),
    h('button', { className: 'world-cap world-close', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: onClose },
      h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true }, h('path', { d: 'M0 0l10 10M10 0L0 10', stroke: 'currentColor', strokeWidth: 1 }))))
}

function DepthGlyph({ size = 15 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round',
  },
  h('path', { d: 'M8 1.7l5.3 2.7v6.2L8 13.3 2.7 10.6V4.4L8 1.7z' }),
  h('path', { d: 'M2.7 4.4L8 7.1l5.3-2.7' }),
  h('path', { d: 'M8 7.1v6.2' }))
}

function ControlGlyph() {
  return h('svg', {
    width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true,
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round',
  }, h('path', { d: 'M4 2.5v14l3.8-3.8 2.8 5.3 2.7-1.4-2.7-5.1 5.4-.6L4 2.5z' }))
}

function AssistantActivity({ activity, control }) {
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const host = activity?.sessionId === control.sessionId ? activity : null
  const explanation = control.message?.startsWith('已接手桌面，') ? '' : control.message
  // 一句话说清"我在做什么"：先说状态再说细节，没有细节就不硬凑一行。
  const saying = control.phase === 'working' ? `正在操作桌面 · ${control.message}`
    : host ? `${host.label} · ${explanation || host.summary}`
    : explanation ? `刚接手 · ${explanation}`
    : '刚接过桌面，正在看看状况。'
  return h(React.Fragment, null,
    h('p', { role: 'status', 'aria-live': 'polite', title: saying, 'data-world-assistant-activity': host?.phase || 'syncing' }, saying),
    h('span', { 'data-world-assistant-timing': true }, activityTiming(host, now)))
}

function DesktopLayer({ sessions, remote, rpc, renderSlot, SessionProvider, catalog, conversationSeat, getDirectoryPicker, openSettings, openPanel, toggleSidebar }) {
  const portal = usePortalContainer()
  const hostSidebar = useHostSidebar()
  const sidebarControl = hostSidebar && typeof toggleSidebar === 'function'
  const catalogApi = catalog || EMPTY_CATALOG
  const pluginApps = React.useSyncExternalStore(catalogApi.subscribe, catalogApi.getSnapshot)
  const [journalClient] = React.useState(() => createJournalClient(rpc))
  const taskDirtyRef = React.useRef(false)
  React.useEffect(() => {
    const guard = event => { if (journalClient.hasDirty() || taskDirtyRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => { window.removeEventListener('beforeunload', guard); journalClient.dispose() }
  }, [journalClient])
  const [state, setState] = React.useState('closed')
  const [selected, setSelected] = React.useState(false)
  const [startOpen, setStartOpen] = React.useState(false)
  const [startQuery, setStartQuery] = React.useState('')
  const [startHit, setStartHit] = React.useState(0)
  const startSearchRef = React.useRef(null)
  // The menu stays mounted (only its class changes), so the caret is placed on open rather than on mount,
  // and taken away again on close: a hidden field that still has focus eats keystrokes meant for the desktop.
  React.useEffect(() => {
    if (!startOpen) {
      setStartQuery(''); setStartHit(0)
      startSearchRef.current?.blur()
      return
    }
    startSearchRef.current?.focus()
  }, [startOpen])
  const [position, setPosition] = React.useState(readPosition)
  const [installedApps, setInstalledApps] = React.useState(readInstalledApps)
  const [vscodeWindows, setVscodeWindows] = React.useState([])
  const [vscodeDirty, setVscodeDirty] = React.useState(() => new Set())
  const [lanChatOpen, setLanChatOpen] = React.useState(false)
  const [lanChatState, setLanChatState] = React.useState('normal')
  const [lanChatRect, setLanChatRect] = React.useState(readLanChatRect)
  const [browserOpen, setBrowserOpen] = React.useState(false)
  const [browserState, setBrowserState] = React.useState('normal')
  const [browserRect, setBrowserRect] = React.useState(readBrowserRect)
  const [terminalOpen, setTerminalOpen] = React.useState(false)
  const [terminalState, setTerminalState] = React.useState('normal')
  const [terminalRect, setTerminalRect] = React.useState(readTerminalRect)
  const [externalApps, setExternalApps] = React.useState(readExternalApps)
  const [externalWindows, setExternalWindows] = React.useState([])
  const [fileLinks, setFileLinks] = React.useState(readFileLinks)
  const [holders, setHolders] = React.useState(readHolders)
  const [rename, setRename] = React.useState(null)
  const holderApps = holders.map(holder => ({ key: holder.id, label: holder.name, icon: HolderGlyph, description: '收纳盒' }))
  const windowApps = [...JOURNAL_APPS, ...TASK_APPS, ...holderApps, ...pluginApps]
  const [contextMenu, setContextMenu] = React.useState(null)
  const [dropActive, setDropActive] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [pluginWindows, setPluginWindows] = React.useState([])
  const [session, setSession] = React.useState(() => currentMainSession(sessions))
  const [activeWindow, setActiveWindow] = React.useState('dsh')
  const [phone, setPhone] = React.useState(isPhoneViewport)
  const [phoneRecent, setPhoneRecent] = React.useState(false)
  const desktopFocusRef = React.useRef('dsh')
  const phoneDesktopRects = React.useRef(new Map())
  const recentRef = React.useRef(null)
  const [clock, setClock] = React.useState(null)
  const [depth, setDepth] = React.useState(readDepth)
  const [wallpaper, setWallpaper] = React.useState(readWallpaper)
  const [wallpaperOpen, setWallpaperOpen] = React.useState(false)
  const [mobileOpen, setMobileOpen] = React.useState(false)

  React.useEffect(() => {
    const syncTheme = () => {
      const body = document.body, root = document.documentElement
      const dark = body.hasAttribute('data-ds-dark-theme') || root.hasAttribute('data-ds-dark-theme')
        || body.dataset.theme === 'dark' || root.dataset.theme === 'dark'
      const theme = dark ? 'dark' : 'light'
      if (body.dataset.worldTheme !== theme) body.dataset.worldTheme = theme
    }
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    const themeAttributes = ['data-ds-dark-theme', 'data-theme', 'class']
    observer.observe(document.body, { attributes: true, attributeFilter: themeAttributes })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: themeAttributes })
    return () => { observer.disconnect(); delete document.body.dataset.worldTheme }
  }, [])
  // 壁纸配置每改一次就落盘；纯色时给图标文字标一个明暗，避免浅底白字。
  const wallpaperConfig = wallpaperFor(wallpaper, depth)
  const wallpaperToneValue = wallpaperTone(wallpaperConfig)
  React.useEffect(() => { saveWallpaper(wallpaper) }, [wallpaper])
  React.useEffect(() => {
    if (wallpaperToneValue) document.body.dataset.worldWallTone = wallpaperToneValue
    else delete document.body.dataset.worldWallTone
    return () => { delete document.body.dataset.worldWallTone }
  }, [wallpaperToneValue])
  const depthRef = React.useRef(depth)
  const clockRef = React.useRef(null)
  const iconsRef = React.useRef(null)
  const lastOpenState = React.useRef('normal')
  const lastLanChatOpenState = React.useRef('normal')
  const lastBrowserOpenState = React.useRef('normal')
  const lastTerminalOpenState = React.useRef('normal')
  const dragRef = React.useRef(null)
  const appDragRef = React.useRef(null)
  const lanChatDragRef = React.useRef(null)
  const browserDragRef = React.useRef(null)
  const terminalDragRef = React.useRef(null)
  const externalDragRef = React.useRef(null)
  const pluginDragRef = React.useRef(null)
  const ignoreDoubleClick = React.useRef(false)
  const iconPositionsRef = React.useRef(readIconPositions())
  const iconDragRef = React.useRef(null)
  const suppressIconClickRef = React.useRef(false)
  const suppressIconTimerRef = React.useRef(0)
  const noticeTimer = React.useRef(0)
  const activeWindowRef = React.useRef(activeWindow)
  const pluginWindowsRef = React.useRef(pluginWindows)
  const externalAppsRef = React.useRef(externalApps)
  const fileLinksRef = React.useRef(fileLinks)
  const holdersRef = React.useRef(holders)
  const sessionRef = React.useRef(session)
  const externalWindowsRef = React.useRef(externalWindows)
  const vscodeWindowsRef = React.useRef(vscodeWindows)
  const vscodeDirtyRef = React.useRef(vscodeDirty)
  const nextVscodeKey = React.useRef(0)
  const desktopApi = React.useRef(null)
  const [control] = React.useState(createDesktopControl)
  const [assistantPointer] = React.useState(() => createAssistantPointer({ getControl: control.getSnapshot }))
  const [desktopUi] = React.useState(() => createDesktopUi({
    getState: () => desktopApi.current.getState(), activate: (id, signal) => desktopApi.current.focusForUi(id, signal),
    dispatch: body => control.dispatchInput(body), onHumanInput: () => control.takeOver(),
    onPointer: (point, controlId, action) => assistantPointer.move(point, controlId, action),
  }))
  React.useEffect(() => () => desktopUi.dispose(), [desktopUi])
  const [brainSessionId, setBrainSessionId] = React.useState(null)
  const [brainProfile, setBrainProfile] = React.useState(null)
  const brainRequest = React.useRef(0)
  const preferenceRead = React.useRef(null)
  const [assistantActivity, setAssistantActivity] = React.useState(null)
  const [assistantCollapsed, setAssistantCollapsed] = React.useState(false)
  const [brainSetup, setBrainSetup] = React.useState(null)
  const [personalization, setPersonalization] = React.useState(null)
  const controlState = React.useSyncExternalStore(control.subscribe, control.getSnapshot)
  const assistantCardRef = React.useRef(null)
  const assistantPanelInteractionRef = React.useRef(false)
  React.useLayoutEffect(() => {
    assistantPanelInteractionRef.current = false
    if (controlState.owner === 'assistant' && assistantCardRef.current) return observeConversationPortals(assistantCardRef.current)
  }, [controlState.owner])
  const editorHandles = React.useRef(new Map())
  const registerDesktopEditor = React.useCallback((key, handle) => {
    editorHandles.current.set(key, handle)
    return () => { if (editorHandles.current.get(key) === handle) editorHandles.current.delete(key) }
  }, [])
  activeWindowRef.current = activeWindow
  pluginWindowsRef.current = pluginWindows
  externalAppsRef.current = externalApps
  externalWindowsRef.current = externalWindows
  fileLinksRef.current = fileLinks
  holdersRef.current = holders
  sessionRef.current = session
  depthRef.current = depth
  vscodeWindowsRef.current = vscodeWindows
  vscodeDirtyRef.current = vscodeDirty

  React.useLayoutEffect(() => {
    const media = window.matchMedia(`(max-width: ${PHONE_BREAKPOINT}px)`)
    const sync = () => {
      if (media.matches) desktopFocusRef.current = activeWindowRef.current
      else if (activeWindowRef.current === 'desktop') setActiveWindow(desktopFocusRef.current)
      setPhone(media.matches)
      setPhoneRecent(false)
    }
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  React.useLayoutEffect(() => {
    document.body.dataset.worldLayout = phone ? 'phone' : 'desktop'
    return () => { delete document.body.dataset.worldLayout }
  }, [phone])
  React.useLayoutEffect(() => {
    if (!phone) return
    for (const [id, rect] of [['dsh', position], ['browser', browserRect], ['terminal', terminalRect], ['lanchat', lanChatRect],
      ...vscodeWindows.map(win => [`vscode:${win.key}`, win.rect]), ...pluginWindows.map(win => [`plugin:${win.key}`, win.rect])]) {
      if (!phoneDesktopRects.current.has(id)) phoneDesktopRects.current.set(id, rect)
    }
  }, [phone, position, browserRect, terminalRect, lanChatRect, vscodeWindows, pluginWindows])
  usePhoneWindows(phone, phoneRecent ? 'desktop' : activeWindow)
  React.useEffect(() => {
    if (!phoneRecent) return
    recentRef.current?.querySelector('button')?.focus()
    const onKeyDown = event => { if (event.key === 'Escape') { event.preventDefault(); setPhoneRecent(false) } }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [phoneRecent])

  const showNotice = message => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600)
  }
  const rootReady = useHostWindow(phone && (activeWindow !== 'dsh' || phoneRecent) && state !== 'closed' ? 'min' : state, position)
  const brainCall = async (operation, payload, signal) => {
    const request = ++brainRequest.current
    const result = await rpc.call('/api', `world-desktop-brain/${operation}`, payload, signal)
    signal?.throwIfAborted()
    if (!result?.ok) throw desktopError(result?.error?.message || '无法连接固定助手。', result?.error?.code)
    if (request === brainRequest.current) {
      setBrainSessionId(result.value.sessionId)
      setBrainProfile(result.value.profile || null)
    }
    return result.value
  }
  const workbenchCall = async operation => {
    const result = await rpc.call('/api', `world-workbench/${operation}`, {})
    if (!result?.ok) throw desktopError(result?.error?.message || '无法调整自动推进。', result?.error?.code)
    return result.value
  }
  const paused = Boolean(assistantActivity?.paused)
  const [pauseBusy, setPauseBusy] = React.useState(false)
  const togglePause = async () => {
    if (pauseBusy) return
    setPauseBusy(true)
    try { await workbenchCall(paused ? 'resume' : 'pause') }
    catch (error) { showNotice(error.message) }
    finally { setPauseBusy(false) }
  }
  const closePersonalization = () => {
    preferenceRead.current?.abort()
    preferenceRead.current = null
    setPersonalization(null)
  }
  const openPersonalization = async () => {
    setStartOpen(false)
    preferenceRead.current?.abort()
    const pending = new AbortController()
    preferenceRead.current = pending
    setPersonalization({ loading: true })
    try {
      const info = await brainCall('get', {}, pending.signal)
      if (!pending.signal.aborted) setPersonalization({ info, loading: false })
    } catch (error) {
      if (!pending.signal.aborted) setPersonalization({ loading: false, error: error.message })
    }
  }

  React.useEffect(() => {
    const stopInput = observeDesktopInput(control)
    const onFrameInput = event => {
      if (event.data?.type !== 'world-human-input') return
      for (const frame of document.querySelectorAll('.world-lanchat-frame')) {
        if (frame.contentWindow === event.source && event.origin === new URL(frame.src, document.baseURI).origin) {
          control.takeOver()
          break
        }
      }
    }
    window.addEventListener('message', onFrameInput)
    return () => { stopInput(); window.removeEventListener('message', onFrameInput); control.dispose() }
  }, [control])
  React.useEffect(() => {
    const lifetime = new AbortController()
    if (rpc?.call) void brainCall('get', {}, lifetime.signal).catch(() => {})
    return () => { lifetime.abort(); preferenceRead.current?.abort(); ++brainRequest.current }
  }, [rpc])

  React.useEffect(() => {
    let previousMinute = ''
    const update = () => {
      const now = new Date()
      const minute = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${now.getMinutes()}`
      if (minute === previousMinute) return
      previousMinute = minute
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const date = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`
      if (clockRef.current) {
        clockRef.current.querySelector('[data-world-time]').textContent = time
        clockRef.current.querySelector('[data-world-date]').textContent = date
      } else setClock({ time, date })
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [phone])

  // 3D 景深：把指针位置写进 CSS 变量，让地面网格与光晕做反向视差。
  // 只移动壁纸层，图标列与窗口保持原坐标，拖拽/点击/测试用的 rect 都不受影响。
  React.useEffect(() => {
    document.body.dataset.worldDepth = depth ? 'on' : 'off'
    saveDepth(depth)
    if (!depth) {
      document.body.style.removeProperty('--world-par-x')
      document.body.style.removeProperty('--world-par-y')
      return
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    let target = null
    const flush = () => {
      frame = 0
      if (!target) return
      document.body.style.setProperty('--world-par-x', `${target.x.toFixed(2)}px`)
      document.body.style.setProperty('--world-par-y', `${target.y.toFixed(2)}px`)
    }
    const queue = (x, y) => {
      target = { x, y }
      if (!frame) frame = window.requestAnimationFrame(flush)
    }
    const onPointerMove = event => {
      const width = window.innerWidth || 1
      const height = window.innerHeight || 1
      const nx = (event.clientX / width - .5) * 2
      const ny = (event.clientY / height - .5) * 2
      // 反方向、小幅度：像透过一扇窗看进去；幅度再大就会让人晕。
      queue(-nx * 18, -ny * 12)
    }
    const onLeave = () => queue(0, 0)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('blur', onLeave)
    document.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('blur', onLeave)
      document.removeEventListener('pointerleave', onLeave)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [depth])

  // 3D 开启时，图标站到地面上：按深度缩放、向消失点收敛；关掉就回到左侧常规网格。
  // 图标数量变了（装/卸 .worldapp、开关内置应用）要重排。
  React.useEffect(() => {
    const container = iconsRef.current
    if (!container) return
    const apply = () => { if (!isPhoneViewport()) layoutDeskIcons(container, depth, iconPositionsRef.current[depth ? 'depth' : 'flat']) }
    // 拖窗口时 resize 一秒能来几十次，重排要等这一帧的尺寸定下来再做，别每来一次都算。
    let frame = 0
    const relayout = () => { if (!isPhoneViewport()) layoutDeskIcons(container, depth,
      iconPositionsRef.current[depth ? 'depth' : 'flat'], { resolveCollisions: true }) }
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => { frame = 0; relayout() })
    }
    apply()
    window.addEventListener('resize', schedule)
    // 任务栏高度、宿主标题栏这类变化不一定伴随 window.resize，容器自己的尺寸也要盯着。
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(container)
    return () => {
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [depth, portal, installedApps, externalApps, fileLinks, holders, phone])

  // 收纳盒被移除后，它的窗口和对应的 VSCode 收纳盒视图一起关掉。
  React.useEffect(() => {
    const ids = new Set(holders.map(holder => holder.id))
    setPluginWindows(list => {
      const next = list.filter(win => !win.key.startsWith('holder:') || ids.has(win.key))
      return next.length === list.length ? list : next
    })
  }, [holders])
  React.useEffect(() => {
    const ids = new Set(holders.map(holder => holder.id))
    setVscodeWindows(list => {
      const next = list.filter(win => !win.collectionId || ids.has(win.collectionId))
      return next.length === list.length ? list : next
    })
  }, [holders])

  // 外部 .worldapp 应用包：只在 world 桌面层接收拖放，宿主 #root 内的文件拖放不受影响
  React.useEffect(() => {
    if (!portal) return
    let depth = 0
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')
    const onDragEnter = event => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDropActive(true)
    }
    const onDragOver = event => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setDropActive(true)
    }
    const onDragLeave = event => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDropActive(false)
    }
    const onDrop = async event => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDropActive(false)
      const files = Array.from(event.dataTransfer?.files || [])
      const appFile = files.find(item => APP_FILE_PATTERN.test(item.name))
      if (appFile) {
        if (appFile.size > 64 * 1024) return showNotice('应用包超过 64 KB')
        let parsed
        try { parsed = parseWorldApp(await appFile.text(), appFile.size) }
        catch { return showNotice('读取应用包失败') }
        if (!parsed.ok) return showNotice(parsed.error)
        const app = parsed.app
        const exists = externalAppsRef.current.some(item => item.id === app.id)
        const next = exists
          ? externalAppsRef.current.map(item => item.id === app.id ? app : item)
          : [...externalAppsRef.current, app]
        externalAppsRef.current = next
        saveExternalApps(next)
        setExternalApps(next)
        showNotice(exists ? `已更新「${app.name}」` : `已安装「${app.name}」`)
        return
      }
      if (!files.length) return
      const pathFor = window.__DSH_HOST_PATHS__?.pathFor
      if (typeof pathFor !== 'function') return showNotice('当前环境拿不到文件的绝对路径，请在桌面版里拖入文件')
      const paths = files.map(file => { try { return pathFor(file) || file.path || '' } catch { return '' } }).filter(Boolean)
      if (!paths.length) return showNotice('没有拿到拖入文件的绝对路径')
      const known = new Set(fileLinksRef.current.map(link => slashPath(link.path).toLowerCase()))
      const fresh = paths.filter(path => !known.has(slashPath(path).toLowerCase()))
      if (!fresh.length) return showNotice('这些文件已经在桌面上了')
      const sessionId = sessionRef.current?.id
      const probed = await Promise.all(fresh.map(async path => {
        try {
          const result = await rpc.call('/api', 'world-vscode-source/probe', { sessionId, path })
          const value = result?.ok ? result.value : null
          return { path: slashPath(value?.path || path), type: value?.type === 'directory' ? 'directory' : 'file',
            name: value?.name || baseNameOf(path) }
        } catch { return { path: slashPath(path), type: 'file', name: baseNameOf(path) } }
      }))
      const links = probed.map(item => ({ id: `file:${newId()}`, path: item.path, name: item.name, type: item.type }))
      const positions = iconPositionsRef.current
      const origin = iconsRef.current?.getBoundingClientRect()
      links.forEach((link, index) => {
        if (depthRef.current) {
          const width = window.innerWidth || 1280, height = window.innerHeight || 800
          const ground = groundOf(width, height)
          const y = ground.clampY(event.clientY), scale = ground.scaleAt(y)
          positions.depth[link.id] = { x: Math.min(Math.max(event.clientX + index * 104, 48 * scale), width - 48 * scale), y }
        } else if (origin) {
          // 图标档位会随窗口缩小降档，落点得按当前实际边长收边，不能写死 96。
          const size = iconSizeOf(iconsRef.current) || 96
          positions.flat[link.id] = {
            x: Math.min(Math.max(event.clientX - origin.left - size / 2 + index * 104, 0), Math.max(0, origin.width - size)),
            y: Math.min(Math.max(event.clientY - origin.top - size / 2, 0), Math.max(0, origin.height - size)),
            vw: origin.width, vh: origin.height,
          }
        }
      })
      saveIconPositions(positions)
      const next = [...fileLinksRef.current, ...links]
      fileLinksRef.current = next
      setFileLinks(next)
      saveFileLinks(next)
      showNotice(`已登记 ${links.length} 个文件（只记录路径，不复制）`)
    }
    portal.addEventListener('dragenter', onDragEnter)
    portal.addEventListener('dragover', onDragOver)
    portal.addEventListener('dragleave', onDragLeave)
    portal.addEventListener('drop', onDrop)
    return () => {
      portal.removeEventListener('dragenter', onDragEnter)
      portal.removeEventListener('dragover', onDragOver)
      portal.removeEventListener('dragleave', onDragLeave)
      portal.removeEventListener('drop', onDrop)
    }
  }, [portal])

  React.useEffect(() => {
    const update = () => setSession(currentMainSession(sessions))
    update()
    const unsubscribe = sessions?.list?.subscribe?.(update)
    return () => unsubscribe?.()
  }, [sessions])

  React.useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape') { setStartOpen(false); setContextMenu(null) }
    }
    const onPointerDown = event => {
      const pluginWindow = event.target.closest?.('.world-plugin-window')
      const externalWindow = event.target.closest?.('.world-external-window')
      const vscodeWindow = event.target.closest?.('.world-vscode-window')
      if (pluginWindow) setActiveWindow(`plugin:${pluginWindow.dataset.worldPlugin}`)
      else if (externalWindow) setActiveWindow(`ext:${externalWindow.dataset.worldAppId}`)
      else if (event.target.closest?.('.world-lanchat-window')) setActiveWindow('lanchat')
      else if (event.target.closest?.('.world-browser-window')) setActiveWindow('browser')
      else if (event.target.closest?.('.world-terminal-window')) setActiveWindow('terminal')
      else if (vscodeWindow) setActiveWindow(`vscode:${vscodeWindow.dataset.worldVscodeKey}`)
      else if (event.target.closest?.('.world-window-frame')
        || (['normal', 'max'].includes(document.body.dataset.worldWindow) && event.target.closest?.('#root'))) setActiveWindow('dsh')
      if (!event.target.closest?.('.world-start, .world-start-button')) setStartOpen(false)
      if (!event.target.closest?.('.world-desktop-icon')) setSelected(false)
      if (!event.target.closest?.('.world-context-menu')) setContextMenu(null)
    }
    // Retain the desktop rectangles throughout the resize gesture, including the
    // intermediate 601px desktop viewport on the way back to a wide window.
    const resizedRect = (id, current, clamp) => {
      const saved = phoneDesktopRects.current
      if (!saved.has(id)) saved.set(id, current)
      return isPhoneViewport() ? current : clamp(saved.get(id))
    }
    const onResize = () => setPosition(current => {
      const next = resizedRect('dsh', current, clampRect)
      return next
    })
    const onAppResize = () => setVscodeWindows(list => {
      let changed = false
      const next = list.map(win => {
        const rect = resizedRect(`vscode:${win.key}`, win.rect, clampVscodeRect)
        if (rect.x === win.rect.x && rect.y === win.rect.y && rect.w === win.rect.w && rect.h === win.rect.h) return win
        changed = true
        return { ...win, rect }
      })
      return changed ? next : list
    })
    const onLanChatResize = () => setLanChatRect(current => {
      const next = resizedRect('lanchat', current, clampVscodeRect)
      return next
    })
    const onBrowserResize = () => setBrowserRect(current => {
      const next = resizedRect('browser', current, clampVscodeRect)
      return next
    })
    const onTerminalResize = () => setTerminalRect(current => {
      const next = resizedRect('terminal', current, clampVscodeRect)
      return next
    })
    const onPluginResize = () => setPluginWindows(list => {
      let changed = false
      const next = list.map(win => {
        const rect = resizedRect(`plugin:${win.key}`, win.rect, clampPluginRect)
        if (rect.x === win.rect.x && rect.y === win.rect.y && rect.w === win.rect.w && rect.h === win.rect.h) return win
        changed = true
        return { ...win, rect }
      })
      return changed ? next : list
    })
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onResize)
    window.addEventListener('resize', onAppResize)
    window.addEventListener('resize', onLanChatResize)
    window.addEventListener('resize', onBrowserResize)
    window.addEventListener('resize', onTerminalResize)
    window.addEventListener('resize', onPluginResize)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('resize', onAppResize)
      window.removeEventListener('resize', onLanChatResize)
      window.removeEventListener('resize', onBrowserResize)
      window.removeEventListener('resize', onTerminalResize)
      window.removeEventListener('resize', onPluginResize)
    }
  }, [])

  React.useEffect(() => {
    // CSS 用 data-world-active-kind 判断「哪一类窗口在最前」；完整 id 留给需要区分第几个窗口的地方
    const kind = activeWindow.startsWith('vscode:') ? 'vscode'
      : activeWindow.startsWith('plugin:') ? 'plugin'
        : activeWindow.startsWith('ext:') ? 'external' : activeWindow
    document.body.dataset.worldActiveWindow = activeWindow
    document.body.dataset.worldActiveKind = kind
    document.body.dataset.worldActiveId = activeWindow
    return () => {
      if (document.body.dataset.worldActiveWindow === activeWindow) {
        delete document.body.dataset.worldActiveWindow
        delete document.body.dataset.worldActiveKind
        delete document.body.dataset.worldActiveId
      }
    }
  }, [activeWindow])

  React.useEffect(() => {
    const tagDialogs = () => {
      if (control.getSnapshot().owner === 'assistant' && assistantPanelInteractionRef.current) return
      const id = activeWindowRef.current
      if (!id.startsWith('plugin:')) return
      const key = id.slice(7)
      const win = pluginWindowsRef.current.find(item => item.key === key)
      if (!win) return
      for (const node of document.body.children) {
        if (!(node instanceof Element) || node.id === 'root' || node.dataset.worldPortal
          || node.dataset.windowsMenu !== undefined || node.dataset.worldDialog) continue
        if (!node.matches(DIALOG_ROLES) && !node.querySelector(DIALOG_ROLES)) continue
        node.dataset.worldDialog = key
        node.dataset.worldPortal = 'dsh-world'
        dialogVars(node, win.rect)
      }
    }
    let scheduled = false
    const onChange = () => {
      tagDialogs()
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => { scheduled = false; tagDialogs() })
    }
    const observer = new MutationObserver(onChange)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    for (const node of document.body.querySelectorAll('[data-world-dialog]')) {
      if (node.dataset.worldAssistantDialog === 'true') continue
      const win = pluginWindows.find(item => item.key === node.dataset.worldDialog)
      if (win) dialogVars(node, win.rect)
      else {
        delete node.dataset.worldDialog
        delete node.dataset.worldPortal
        for (const name of ['x', 'y', 'w', 'h']) node.style.removeProperty(`--world-dialog-${name}`)
      }
    }
  }, [pluginWindows])

  const openWindow = () => {
    setPhoneRecent(false)
    if (state === 'closed') { lastOpenState.current = 'normal'; setState('normal') }
    else if (state === 'min') setState(lastOpenState.current)
    setActiveWindow('dsh')
    setStartOpen(false)
  }
  const minimize = () => {
    if (state === 'normal' || state === 'max') {
      lastOpenState.current = state
      setState('min')
    }
  }
  const toggleMaximize = () => {
    if (state === 'normal') { lastOpenState.current = 'max'; setState('max') }
    else if (state === 'max') { lastOpenState.current = 'normal'; setState('normal') }
  }
  const closeWindow = () => {
    lastOpenState.current = 'normal'
    setState('closed')
    setStartOpen(false)
  }

  const focusPlugin = key => setActiveWindow(`plugin:${key}`)
  const openPlugin = key => {
    setStartOpen(false)
    setPluginWindows(list => {
      const found = list.find(win => win.key === key)
      if (found) return list.map(win => win.key === key
        ? { ...win, state: win.state === 'min' ? (win.lastOpen || 'normal') : win.state } : win)
      return [...list, { key, state: 'normal', lastOpen: 'normal', rect: readPluginRect(key, list.length) }]
    })
    focusPlugin(key)
  }
  const minimizePlugin = key => setPluginWindows(list => list.map(win => win.key === key
    ? { ...win, lastOpen: win.state === 'max' ? 'max' : 'normal', state: 'min' } : win))
  const toggleMaximizePlugin = key => setPluginWindows(list => list.map(win => {
    if (win.key !== key) return win
    if (win.state === 'max') return { ...win, state: 'normal', lastOpen: 'normal' }
    return { ...win, state: 'max', lastOpen: 'max' }
  }))
  const closePlugin = key => {
    setPluginWindows(list => list.filter(win => win.key !== key))
    if (activeWindowRef.current === `plugin:${key}`) setActiveWindow('dsh')
  }
  const restoreWindow = id => {
    setPhoneRecent(false)
    setStartOpen(false)
    if (id === 'dsh') return openWindow()
    if (id.startsWith('vscode:')) {
      const key = id.slice('vscode:'.length)
      // 点任务栏还原：回到最小化前的那一层（最大化过的窗还原后仍是最大化）
      setVscodeWindows(list => list.map(win => win.key === key && win.state === 'min'
        ? { ...win, state: win.lastOpen === 'max' ? 'max' : 'normal' } : win))
      setActiveWindow(id)
      return
    }
    if (id === 'lanchat') return openLanChat()
    if (id === 'browser') return openBrowser()
    if (id === 'terminal') return openTerminal()
    if (id.startsWith('ext:')) return openExternalApp(id.slice(4))
    if (id.startsWith('plugin:')) openPlugin(id.slice(7))
  }

  /**
   * 点任务栏按钮（Windows 的手感）：窗口已经在前台就收回任务栏，否则叫回来。
   * 助手派的 `focus_window` 仍走 restoreWindow —— 那里「把窗口拿到前台」是字面意思，
   * 不该因为目标已经在前面就把它最小化。
   */
  const taskbarToggle = id => {
    const minimized = (() => {
      if (id === 'dsh') return state === 'min' || state === 'closed'
      if (id.startsWith('vscode:')) return vscodeWindowsRef.current.find(win => win.key === id.slice(7))?.state === 'min'
      if (id === 'lanchat') return lanChatState === 'min'
      if (id === 'browser') return browserState === 'min'
      if (id === 'terminal') return terminalState === 'min'
      if (id.startsWith('plugin:')) return pluginWindowsRef.current.find(win => win.key === id.slice(7))?.state === 'min'
      if (id.startsWith('ext:')) return externalWindowsRef.current.find(win => win.id === id.slice(4))?.state === 'min'
      return false
    })()
    if (!minimized && activeWindowRef.current === id) {
      if (id === 'dsh') return minimize()
      if (id.startsWith('vscode:')) return minimizeVscode(id.slice(7))
      if (id === 'lanchat') return minimizeLanChat()
      if (id === 'browser') return minimizeBrowser()
      if (id === 'terminal') return minimizeTerminal()
      if (id.startsWith('plugin:')) return minimizePlugin(id.slice(7))
      if (id.startsWith('ext:')) return minimizeExternalApp(id.slice(4))
    }
    restoreWindow(id)
  }

  /** 开始菜单 / 桌面上的「设置」：先把 DSH 窗口立起来，再打开原生设置面板。
   * 面板是 body 级浮层，world 的 CSS 按 DSH 窗口矩形给它定位；窗口关着或最小化时
   * 它被 `visibility:hidden` 藏住，所以必须先把窗口还原，否则点了像没反应。 */
  const openSettingsPanel = () => {
    setContextMenu(null)
    openWindow()
    const opened = typeof openSettings === 'function' ? openSettings() : false
    if (!opened) showNotice('没能打开设置：当前宿主没有暴露原生设置面板。')
  }

  /** 插件管理页声明了自己的子槽位，搬不进虚拟窗口，所以和设置一样：立起 DSH 窗口再切面板。 */
  const openHostPage = id => {
    setContextMenu(null)
    openWindow()
    const opened = typeof openPanel === 'function' ? openPanel(id) : false
    const page = HOST_PANELS.find(item => item.id === id)
    if (!opened) showNotice(`没能打开${page?.label || id}页：当前宿主没有这个面板。`)
  }

  const beginPluginDrag = key => event => {
    if (isPhoneViewport()) return
    if (event.target.closest('button')) return
    const win = pluginWindowsRef.current.find(item => item.key === key)
    if (!win || win.state !== 'normal') return
    phoneDesktopRects.current.delete(`plugin:${key}`)
    focusPlugin(key)
    pluginDragRef.current = {
      kind: 'move', key, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, rect: win.rect,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const beginPluginResize = key => edge => event => {
    phoneDesktopRects.current.delete(`plugin:${key}`)
    event.stopPropagation()
    event.preventDefault()
    const win = pluginWindowsRef.current.find(item => item.key === key)
    if (!win || win.state !== 'normal') return
    focusPlugin(key)
    pluginDragRef.current = {
      kind: 'resize', edge, key, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, rect: win.rect,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const movePluginDrag = event => {
    const drag = pluginDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.x) / (window.innerWidth || 1) * 100
    const dy = (event.clientY - drag.y) / (window.innerHeight || 1) * 100
    const next = { ...drag.rect }
    if (drag.kind === 'move') { next.x += dx; next.y += dy }
    else {
      if (drag.edge.includes('w')) { next.x += dx; next.w -= dx }
      if (drag.edge.includes('e')) next.w += dx
      if (drag.edge.includes('n')) { next.y += dy; next.h -= dy }
      if (drag.edge.includes('s')) next.h += dy
    }
    const rect = clampPluginRect(next)
    drag.next = rect
    setPluginWindows(list => list.map(win => win.key === drag.key ? { ...win, rect } : win))
  }
  const endPluginDrag = event => {
    const drag = pluginDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    pluginDragRef.current = null
    // 甩到顶边：把矩形退回拖动前再最大化，还原时才不会贴在标题栏下面
    if (drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)) {
      setPluginWindows(list => list.map(win => win.key === drag.key
        ? { ...win, rect: drag.rect, state: 'max', lastOpen: 'max' } : win))
      return
    }
    if (drag.next) savePluginRect(drag.key, drag.next)
  }

  const installApp = id => setInstalledApps(current => {
    const next = new Set(current)
    next.add(id)
    saveInstalledApps(next)
    return next
  })
  const uninstallApp = id => setInstalledApps(current => {
    const next = new Set(current)
    next.delete(id)
    saveInstalledApps(next)
    return next
  })
  const installVscode = () => installApp('vscode')

  /**
   * 新窗口斜向错开：每列露出 60px，正好盖过 48px 活动栏，后面的窗口看得出是完整的一列图标；
   * 每满 3 列换一行，第 4 个窗口不会又叠回第一个身上。
   */
  const nextVscodeRect = index => {
    const base = readVscodeRect()
    const width = window.innerWidth || 1
    const height = window.innerHeight || 1
    return clampVscodeRect({
      ...base,
      x: base.x + (index % 3) * 60 / width * 100,
      y: base.y + Math.floor(index / 3) * 26 / height * 100,
    })
  }

  /** 同一个文件夹只保留一个实例：把它拿到前台（最小化的还原），返回已有窗口的 key。 */
  const focusVscodeFolder = (folder, excludeKey) => {
    const key = vscodeFolderKey(folder)
    const existing = vscodeWindowsRef.current.find(win => win.key !== excludeKey && vscodeFolderKey(win.rootPath) === key)
    if (!existing) return ''
    setVscodeWindows(list => list.map(win => win.key === existing.key && win.state === 'min'
      ? { ...win, state: win.lastOpen === 'max' ? 'max' : 'normal' } : win))
    setActiveWindow(`vscode:${existing.key}`)
    return existing.key
  }

  const openVscode = (rootPath, owner = session) => {
    setStartOpen(false)
    // 从事件处理直接调用时第一个参数是事件对象，只认字符串
    const folder = typeof rootPath === 'string' ? rootPath : ''
    const root = folder || owner?.cwd || ''
    const focused = focusVscodeFolder(root)
    if (focused) return `vscode:${focused}`
    const key = `win${++nextVscodeKey.current}`
    setVscodeWindows(list => [...list, {
      key,
      session: owner,
      rootPath: root,
      rect: nextVscodeRect(list.length),
      state: 'normal',
    }])
    setActiveWindow(`vscode:${key}`)
    return `vscode:${key}`
  }

  /** Open a real file in a VSCode window rooted at its folder, reusing that folder's window. */
  const openVscodeFile = filePath => {
    if (!installedApps.has('vscode')) { showNotice('先从开始菜单安装 VSCode'); return }
    setStartOpen(false)
    const dir = dirNameOf(filePath)
    const owner = sessionRef.current
    const root = dir || owner?.cwd || ''
    const focused = focusVscodeFolder(root)
    if (focused) {
      setVscodeWindows(list => list.map(win => win.key === focused
        ? { ...win, openRequest: { path: filePath, nonce: (win.openRequest?.nonce || 0) + 1 } } : win))
      return `vscode:${focused}`
    }
    const key = `win${++nextVscodeKey.current}`
    setVscodeWindows(list => [...list, {
      key, session: owner, rootPath: root, openRequest: { path: filePath, nonce: 1 },
      rect: nextVscodeRect(list.length), state: 'normal',
    }])
    setActiveWindow(`vscode:${key}`)
    return `vscode:${key}`
  }

  const openVscodeCollection = holder => {
    if (!installedApps.has('vscode')) { showNotice('先从开始菜单安装 VSCode'); return }
    setStartOpen(false)
    setContextMenu(null)
    const entries = holder.items.map(id => fileLinksRef.current.find(link => link.id === id)).filter(Boolean)
    if (!entries.length) { showNotice('收纳盒里还没有文件或文件夹'); return }
    const existing = vscodeWindowsRef.current.find(win => win.collectionId === holder.id)
    if (existing) {
      setVscodeWindows(list => list.map(win => win.key === existing.key && win.state === 'min'
        ? { ...win, state: win.lastOpen === 'max' ? 'max' : 'normal' } : win))
      setActiveWindow(`vscode:${existing.key}`)
      return
    }
    const key = `win${++nextVscodeKey.current}`
    setVscodeWindows(list => [...list, {
      key, session: sessionRef.current, collectionId: holder.id, rootPath: '',
      rect: nextVscodeRect(list.length), state: 'normal',
    }])
    setActiveWindow(`vscode:${key}`)
  }

  /** 最小化：记住最小化前是不是最大化，任务栏还原时回到那一层。 */
  const minimizeVscode = key => {
    setVscodeWindows(list => list.map(win => win.key === key
      ? { ...win, state: 'min', lastOpen: win.state === 'max' ? 'max' : 'normal' } : win))
    if (activeWindowRef.current === `vscode:${key}`) setActiveWindow('dsh')
  }

  const toggleMaximizeVscode = key => setVscodeWindows(list => list.map(win => win.key === key
    ? { ...win, state: win.state === 'max' ? 'normal' : 'max' } : win))

  const closeVscode = key => {
    if (vscodeDirtyRef.current.has(key) && !window.confirm('这个 VSCode 窗口有未保存的修改。仍要关闭吗？')) return
    const remaining = vscodeWindowsRef.current.filter(win => win.key !== key)
    setVscodeWindows(remaining)
    setVscodeDirty(current => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
    if (activeWindowRef.current === `vscode:${key}`) {
      // 关掉的正好是前台：把前台交给还开着的那一个，而不是一律退回 DSH 桌面
      const fallback = [...remaining].reverse().find(win => win.state !== 'min')
      setActiveWindow(fallback ? `vscode:${fallback.key}` : 'dsh')
    }
  }

  const uninstallVscode = () => {
    if (vscodeDirtyRef.current.size && !window.confirm('VSCode 中有未保存的修改。卸载会关闭所有窗口并放弃修改，继续吗？')) return
    uninstallApp('vscode')
    setVscodeWindows([])
    setVscodeDirty(new Set())
    if (activeWindowRef.current.startsWith('vscode:')) setActiveWindow('dsh')
  }

  const updateVscodeRoot = (key, rootPath) => setVscodeWindows(list => list
    .map(win => win.key === key ? { ...win, rootPath } : win))

  const setVscodeWindowDirty = (key, dirty) => setVscodeDirty(current => {
    if (current.has(key) === dirty) return current
    const next = new Set(current)
    if (dirty) next.add(key)
    else next.delete(key)
    return next
  })

  // 内置局域网聊天：安装状态与 VSCode 共用同一份应用目录
  const installLanChat = () => installApp('lanchat')
  const uninstallLanChat = () => {
    uninstallApp('lanchat')
    setLanChatOpen(false)
    setLanChatState('normal')
    if (activeWindowRef.current === 'lanchat') setActiveWindow('dsh')
  }
  const openLanChat = () => {
    setStartOpen(false)
    setLanChatOpen(true)
    setLanChatState(current => current === 'min' ? lastLanChatOpenState.current : current)
    setActiveWindow('lanchat')
  }
  const closeLanChat = () => {
    setLanChatOpen(false)
    setLanChatState('normal')
    if (activeWindowRef.current === 'lanchat') setActiveWindow('dsh')
  }
  const minimizeLanChat = () => {
    if (lanChatState === 'normal' || lanChatState === 'max') {
      lastLanChatOpenState.current = lanChatState
      setLanChatState('min')
    }
  }
  const toggleMaximizeLanChat = () => setLanChatState(current => current === 'max' ? 'normal' : 'max')

  // 内置浏览器：P1 单窗口多标签，状态机与局域网聊天同构；标签状态在 BrowserWindow 内部，不进 desktopState
  const installBrowser = () => installApp('browser')
  const uninstallBrowser = () => {
    uninstallApp('browser')
    setBrowserOpen(false)
    setBrowserState('normal')
    if (activeWindowRef.current === 'browser') setActiveWindow('dsh')
  }
  const openBrowser = () => {
    setStartOpen(false)
    setBrowserOpen(true)
    setBrowserState(current => current === 'min' ? lastBrowserOpenState.current : current)
    setActiveWindow('browser')
  }
  const closeBrowser = () => {
    setBrowserOpen(false)
    setBrowserState('normal')
    if (activeWindowRef.current === 'browser') setActiveWindow('dsh')
  }
  const minimizeBrowser = () => {
    if (browserState === 'normal' || browserState === 'max') {
      lastBrowserOpenState.current = browserState
      setBrowserState('min')
    }
  }
  const toggleMaximizeBrowser = () => setBrowserState(current => current === 'max' ? 'normal' : 'max')

  // 内置终端：窗口状态机与浏览器/聊天同构，命令由宿主端的 world-terminal 服务执行
  const installTerminal = () => installApp('terminal')
  const uninstallTerminal = () => {
    uninstallApp('terminal')
    setTerminalOpen(false)
    setTerminalState('normal')
    if (activeWindowRef.current === 'terminal') setActiveWindow('dsh')
  }
  const openTerminal = () => {
    setStartOpen(false)
    setTerminalOpen(true)
    setTerminalState(current => current === 'min' ? lastTerminalOpenState.current : current)
    setActiveWindow('terminal')
  }
  const closeTerminal = () => {
    setTerminalOpen(false)
    setTerminalState('normal')
    if (activeWindowRef.current === 'terminal') setActiveWindow('dsh')
  }
  const minimizeTerminal = () => {
    if (terminalState === 'normal' || terminalState === 'max') {
      lastTerminalOpenState.current = terminalState
      setTerminalState('min')
    }
  }
  const toggleMaximizeTerminal = () => setTerminalState(current => current === 'max' ? 'normal' : 'max')
  const beginTerminalDrag = event => {
    if (isPhoneViewport()) return
    if (event.target.closest('button') || terminalState !== 'normal') return
    phoneDesktopRects.current.delete('terminal')
    setActiveWindow('terminal')
    terminalDragRef.current = { kind: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: terminalRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const beginTerminalResize = edge => event => {
    phoneDesktopRects.current.delete('terminal')
    event.stopPropagation()
    event.preventDefault()
    if (terminalState !== 'normal') return
    setActiveWindow('terminal')
    terminalDragRef.current = { kind: 'resize', edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: terminalRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveTerminal = event => {
    const drag = terminalDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.x) / (window.innerWidth || 1) * 100
    const dy = (event.clientY - drag.y) / (window.innerHeight || 1) * 100
    const next = { ...drag.rect }
    if (drag.kind === 'move') { next.x += dx; next.y += dy }
    else {
      if (drag.edge.includes('w')) { next.x += dx; next.w -= dx }
      if (drag.edge.includes('e')) next.w += dx
      if (drag.edge.includes('n')) { next.y += dy; next.h -= dy }
      if (drag.edge.includes('s')) next.h += dy
    }
    terminalDragRef.current.next = clampVscodeRect(next)
    setTerminalRect(terminalDragRef.current.next)
  }
  const endTerminalDrag = event => {
    const drag = terminalDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    terminalDragRef.current = null
    if (drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)) {
      setTerminalRect(drag.rect)
      toggleMaximizeTerminal()
      return
    }
    saveRect(TERMINAL_STORAGE_KEY, drag.next || terminalRect)
  }
  const beginBrowserDrag = event => {
    if (isPhoneViewport()) return
    if (event.target.closest('button') || browserState !== 'normal') return
    phoneDesktopRects.current.delete('browser')
    setActiveWindow('browser')
    browserDragRef.current = { kind: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: browserRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const beginBrowserResize = edge => event => {
    phoneDesktopRects.current.delete('browser')
    event.stopPropagation()
    event.preventDefault()
    if (browserState !== 'normal') return
    setActiveWindow('browser')
    browserDragRef.current = { kind: 'resize', edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: browserRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveBrowser = event => {
    const drag = browserDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.x) / (window.innerWidth || 1) * 100
    const dy = (event.clientY - drag.y) / (window.innerHeight || 1) * 100
    const next = { ...drag.rect }
    if (drag.kind === 'move') { next.x += dx; next.y += dy }
    else {
      if (drag.edge.includes('w')) { next.x += dx; next.w -= dx }
      if (drag.edge.includes('e')) next.w += dx
      if (drag.edge.includes('n')) { next.y += dy; next.h -= dy }
      if (drag.edge.includes('s')) next.h += dy
    }
    browserDragRef.current.next = clampVscodeRect(next)
    setBrowserRect(browserDragRef.current.next)
  }
  const endBrowserDrag = event => {
    const drag = browserDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    browserDragRef.current = null
    if (drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)) {
      setBrowserRect(drag.rect)
      toggleMaximizeBrowser()
      return
    }
    saveRect(BROWSER_STORAGE_KEY, drag.next || browserRect)
  }

  const beginVscodeDrag = key => event => {
    if (isPhoneViewport()) return
    if (event.target.closest('button')) return
    const win = vscodeWindowsRef.current.find(item => item.key === key)
    // 最大化时标题栏不给拖：先还原再拖（和 Windows 一致）比拖着一个全屏窗口跑更不容易出怪动作
    if (!win || win.state !== 'normal') return
    phoneDesktopRects.current.delete(`vscode:${key}`)
    setActiveWindow(`vscode:${key}`)
    appDragRef.current = { key, kind: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: win.rect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const beginVscodeResize = key => edge => event => {
    phoneDesktopRects.current.delete(`vscode:${key}`)
    event.stopPropagation()
    event.preventDefault()
    const win = vscodeWindowsRef.current.find(item => item.key === key)
    if (!win || win.state !== 'normal') return
    setActiveWindow(`vscode:${key}`)
    appDragRef.current = { key, kind: 'resize', edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: win.rect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveVscode = event => {
    const drag = appDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.x) / (window.innerWidth || 1) * 100
    const dy = (event.clientY - drag.y) / (window.innerHeight || 1) * 100
    const next = { ...drag.rect }
    if (drag.kind === 'move') { next.x += dx; next.y += dy }
    else {
      if (drag.edge.includes('w')) { next.x += dx; next.w -= dx }
      if (drag.edge.includes('e')) next.w += dx
      if (drag.edge.includes('n')) { next.y += dy; next.h -= dy }
      if (drag.edge.includes('s')) next.h += dy
    }
    drag.next = clampVscodeRect(next)
    setVscodeWindows(list => list.map(win => win.key === drag.key ? { ...win, rect: drag.next } : win))
  }
  const endVscodeDrag = event => {
    const drag = appDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    appDragRef.current = null
    if (drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)) {
      setVscodeWindows(list => list.map(win => win.key === drag.key
        ? { ...win, rect: drag.rect, state: 'max' } : win))
      return
    }
    if (drag.next) saveRect(VSCODE_STORAGE_KEY, drag.next)
  }

  const beginLanChatDrag = event => {
    if (isPhoneViewport()) return
    if (event.target.closest('button') || lanChatState !== 'normal') return
    phoneDesktopRects.current.delete('lanchat')
    setActiveWindow('lanchat')
    lanChatDragRef.current = { kind: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: lanChatRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const beginLanChatResize = edge => event => {
    phoneDesktopRects.current.delete('lanchat')
    event.stopPropagation()
    event.preventDefault()
    if (lanChatState !== 'normal') return
    setActiveWindow('lanchat')
    lanChatDragRef.current = { kind: 'resize', edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: lanChatRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveLanChat = event => {
    const drag = lanChatDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.x) / (window.innerWidth || 1) * 100
    const dy = (event.clientY - drag.y) / (window.innerHeight || 1) * 100
    const next = { ...drag.rect }
    if (drag.kind === 'move') { next.x += dx; next.y += dy }
    else {
      if (drag.edge.includes('w')) { next.x += dx; next.w -= dx }
      if (drag.edge.includes('e')) next.w += dx
      if (drag.edge.includes('n')) { next.y += dy; next.h -= dy }
      if (drag.edge.includes('s')) next.h += dy
    }
    lanChatDragRef.current.next = clampVscodeRect(next)
    setLanChatRect(lanChatDragRef.current.next)
  }
  const endLanChatDrag = event => {
    const drag = lanChatDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    lanChatDragRef.current = null
    if (drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)) {
      setLanChatRect(drag.rect)
      toggleMaximizeLanChat()
      return
    }
    saveRect(LANCHAT_STORAGE_KEY, drag.next || lanChatRect)
  }

  // 外部 .worldapp 应用：安装后的窗口状态机
  const uninstallExternalApp = id => {
    const next = externalAppsRef.current.filter(item => item.id !== id)
    externalAppsRef.current = next
    saveExternalApps(next)
    setExternalApps(next)
    setExternalWindows(list => list.filter(win => win.id !== id))
    removeExternalRect(id)
    if (activeWindowRef.current === `ext:${id}`) setActiveWindow('dsh')
    showNotice('已卸载应用')
  }
  const openExternalApp = id => {
    const app = externalAppsRef.current.find(item => item.id === id)
    if (!app) return
    setStartOpen(false)
    setExternalWindows(list => {
      const found = list.find(win => win.id === id)
      if (found) return list.map(win => win.id === id
        ? { ...win, state: win.state === 'min' ? (win.lastOpen || 'normal') : win.state } : win)
      return [...list, { id, state: 'normal', rect: readExternalRect(id, list.length, app.size) }]
    })
    setActiveWindow(`ext:${id}`)
  }
  const closeExternalApp = id => {
    setExternalWindows(list => list.filter(win => win.id !== id))
    if (activeWindowRef.current === `ext:${id}`) setActiveWindow('dsh')
  }
  const minimizeExternalApp = id => setExternalWindows(list => list.map(win => win.id === id && win.state !== 'min'
    ? { ...win, state: 'min', lastOpen: win.state === 'max' ? 'max' : 'normal' } : win))
  const toggleMaximizeExternalApp = id => setExternalWindows(list => list.map(win => win.id === id
    ? { ...win, state: win.state === 'max' ? 'normal' : 'max' } : win))
  const beginExternalDrag = id => event => {
    if (isPhoneViewport()) return
    if (event.target.closest('button')) return
    const win = externalWindowsRef.current.find(item => item.id === id && item.state === 'normal')
    if (!win) return
    setActiveWindow(`ext:${id}`)
    externalDragRef.current = { id, kind: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: win.rect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const beginExternalResize = id => edge => event => {
    event.stopPropagation()
    event.preventDefault()
    const win = externalWindowsRef.current.find(item => item.id === id && item.state === 'normal')
    if (!win) return
    setActiveWindow(`ext:${id}`)
    externalDragRef.current = { id, kind: 'resize', edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: win.rect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveExternalDrag = event => {
    const drag = externalDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.x) / (window.innerWidth || 1) * 100
    const dy = (event.clientY - drag.y) / (window.innerHeight || 1) * 100
    const next = { ...drag.rect }
    if (drag.kind === 'move') { next.x += dx; next.y += dy }
    else {
      if (drag.edge.includes('w')) { next.x += dx; next.w -= dx }
      if (drag.edge.includes('e')) next.w += dx
      if (drag.edge.includes('n')) { next.y += dy; next.h -= dy }
      if (drag.edge.includes('s')) next.h += dy
    }
    drag.next = clampAppRect(next)
    setExternalWindows(list => list.map(win => win.id === drag.id ? { ...win, rect: drag.next } : win))
  }
  const endExternalDrag = event => {
    const drag = externalDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    externalDragRef.current = null
    if (drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)) {
      setExternalWindows(list => list.map(win => win.id === drag.id
        ? { ...win, rect: drag.rect, state: 'max' } : win))
      return
    }
    if (drag.next) saveExternalRect(drag.id, drag.next)
  }

  // 桌面图标右键菜单：DSH 主应用只给「打开」，其它应用才可以卸载
  const openContextMenu = (event, appId, label, kind = 'app') => {
    event.preventDefault()
    event.stopPropagation()
    setStartOpen(false)
    setContextMenu({
      x: Math.min(event.clientX, (window.innerWidth || 1280) - 200),
      y: Math.min(event.clientY, (window.innerHeight || 800) - 260),
      appId, label, kind,
    })
  }
  /** 刷新桌面：重读落盘的桌面数据（其它窗口动过也能同步），图标随之重排。 */
  const refreshDesktop = () => {
    setContextMenu(null)
    setSelected(false)
    setStartOpen(false)
    setInstalledApps(readInstalledApps())
    setExternalApps(readExternalApps())
    setFileLinks(readFileLinks())
    setHolders(readHolders())
    setWallpaper(readWallpaper())
    showNotice('桌面已刷新')
  }
  const menuOpen = id => {
    setContextMenu(null)
    entryById(id)?.open()
  }
  const menuUninstall = id => {
    setContextMenu(null)
    if (id === 'dsh' || JOURNAL_APPS.some(app => `plugin:${app.key}` === id) || TASK_APPS.some(app => `plugin:${app.key}` === id)) return
    if (id === 'vscode') uninstallVscode()
    else     if (id === 'lanchat') uninstallLanChat()
    else if (id === 'browser') uninstallBrowser()
    else if (id === 'terminal') uninstallTerminal()
    else uninstallExternalApp(id)
  }

  // 桌面图标拖动：松手后把位置写进本机；3D 下脚底跟着地面交点走，带深度缩放。
  const moveIconDrag = event => {
    const drag = iconDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
      drag.moved = true
      drag.icon.classList.add('is-dragging')
      drag.icon.style.zIndex = '9999'
      document.body.dataset.worldIconDragging = 'true'
    }
    event.preventDefault()
    const origin = drag.origin
    if (drag.mode === 'flat') {
      const size = drag.size || 96
      const x = Math.min(Math.max(event.clientX - origin.left - drag.grabX, 0), Math.max(0, origin.width - size))
      const y = Math.min(Math.max(event.clientY - origin.top - drag.grabY, 0), Math.max(0, origin.height - size))
      drag.icon.style.left = `${x}px`
      drag.icon.style.top = `${y}px`
    } else {
      const width = window.innerWidth || 1280, height = window.innerHeight || 800
      const ground = groundOf(width, height)
      const feetY = ground.clampY(event.clientY + drag.offsetY)
      const scale = ground.scaleAt(feetY), half = 48 * scale
      const feetX = Math.min(Math.max(event.clientX + drag.offsetX, half), width - half)
      drag.icon.style.left = `${feetX - 48 - origin.left}px`
      drag.icon.style.top = `${feetY - 96 - origin.top}px`
      drag.icon.style.transform = `scale(${scale.toFixed(3)})`
    }
    const nextTarget = findMergeTarget(drag)
    if (nextTarget !== drag.mergeTarget) {
      drag.mergeTarget?.classList.remove('is-merge-target')
      drag.mergeTarget = nextTarget
      nextTarget?.classList.add('is-merge-target')
    }
  }
  const endIconDrag = event => {
    const drag = iconDragRef.current
    if (!drag || (event && drag.pointerId !== event.pointerId)) return
    iconDragRef.current = null
    window.removeEventListener('pointermove', drag.handlers.move)
    window.removeEventListener('pointerup', drag.handlers.end)
    window.removeEventListener('pointercancel', drag.handlers.end)
    delete document.body.dataset.worldIconDragging
    drag.icon.classList.remove('is-dragging')
    const mergeTarget = drag.mergeTarget
    mergeTarget?.classList.remove('is-merge-target')
    drag.mergeTarget = null
    if (!drag.moved) return
    if (mergeTarget && mergeIcons(mergeTarget, drag.icon)) {
      suppressIconClickRef.current = true
      window.clearTimeout(suppressIconTimerRef.current)
      suppressIconTimerRef.current = window.setTimeout(() => { suppressIconClickRef.current = false }, 320)
      return
    }
    const value = iconPositionsRef.current
    if (drag.mode === 'flat') {
      value.flat[drag.id] = {
        x: Number.parseFloat(drag.icon.style.left) || 0, y: Number.parseFloat(drag.icon.style.top) || 0,
        vw: drag.origin.width, vh: drag.origin.height,
      }
    } else {
      const left = Number.parseFloat(drag.icon.style.left) || 0
      const top = Number.parseFloat(drag.icon.style.top) || 0
      value.depth[drag.id] = {
        x: left + 48 + drag.origin.left, y: top + 96 + drag.origin.top,
        vw: window.innerWidth || 1, vh: window.innerHeight || 1,
      }
    }
    saveIconPositions(value)
    layoutDeskIcons(iconsRef.current, depth, value[drag.mode])
    suppressIconClickRef.current = true
    window.clearTimeout(suppressIconTimerRef.current)
    suppressIconTimerRef.current = window.setTimeout(() => { suppressIconClickRef.current = false }, 320)
  }
  const beginIconDrag = event => {
    if (isPhoneViewport()) return
    if (event.button !== 0) return
    const icon = event.target.closest?.('.world-desktop-icon')
    if (!icon || !iconsRef.current?.contains(icon)) return
    const id = icon.dataset.worldIconId
    if (!id) return
    const rect = icon.getBoundingClientRect(), origin = iconsRef.current.getBoundingClientRect()
    const handlers = { move: moveIconDrag, end: endIconDrag }
    iconDragRef.current = {
      id, icon, handlers, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      grabX: event.clientX - rect.left, grabY: event.clientY - rect.top,
      offsetX: rect.left + rect.width / 2 - event.clientX, offsetY: rect.bottom - event.clientY,
      origin, mode: depth ? 'depth' : 'flat', moved: false,
      size: iconSizeOf(iconsRef.current) || 96,
    }
    window.addEventListener('pointermove', handlers.move, { passive: false })
    window.addEventListener('pointerup', handlers.end)
    window.addEventListener('pointercancel', handlers.end)
  }
  React.useEffect(() => () => {
    window.clearTimeout(suppressIconTimerRef.current)
    const drag = iconDragRef.current
    if (drag) {
      window.removeEventListener('pointermove', drag.handlers.move)
      window.removeEventListener('pointerup', drag.handlers.end)
      window.removeEventListener('pointercancel', drag.handlers.end)
      delete document.body.dataset.worldIconDragging
    }
  }, [])
  const resetIconPosition = appId => {
    const value = iconPositionsRef.current
    delete value.flat[appId]
    delete value.depth[appId]
    saveIconPositions(value)
    layoutDeskIcons(iconsRef.current, depth, value[depth ? 'depth' : 'flat'])
    setContextMenu(null)
    showNotice('已还原图标位置')
  }
  const resetAllIconPositions = () => {
    iconPositionsRef.current = { flat: {}, depth: {} }
    saveIconPositions(iconPositionsRef.current)
    layoutDeskIcons(iconsRef.current, depth, {})
    setContextMenu(null)
    showNotice('已重排全部图标')
  }

  const commitFileLinks = next => { fileLinksRef.current = next; setFileLinks(next); saveFileLinks(next) }
  const commitHolders = next => { holdersRef.current = next; setHolders(next); saveHolders(next) }
  const iconPositionOf = icon => {
    const origin = iconsRef.current.getBoundingClientRect()
    const left = Number.parseFloat(icon.style.left) || 0
    const top = Number.parseFloat(icon.style.top) || 0
    return depth ? { x: left + 48 + origin.left, y: top + 96 + origin.top } : { x: left, y: top }
  }
  const applyHolderItems = (holder, items) => {
    if (items.length >= 2) commitHolders(holdersRef.current.map(item => item.id === holder.id ? { ...item, items } : item))
    else {
      commitHolders(holdersRef.current.filter(item => item.id !== holder.id))
      setPluginWindows(list => list.filter(win => win.key !== holder.id))
      const positions = iconPositionsRef.current
      delete positions.flat[holder.id]
      delete positions.depth[holder.id]
      saveIconPositions(positions)
      if (items.length === 1) showNotice('收纳盒只剩一个项目，已自动解散并放回桌面')
    }
  }
  const removeHolderItem = (holder, itemId) => {
    applyHolderItems(holder, holder.items.filter(id => id !== itemId))
    if (holder.items.length > 2) showNotice('已移出收纳盒')
  }
  const dissolveHolder = holder => {
    if (!window.confirm(`解散「${holder.name}」？里面的 ${holder.items.length} 个项目会回到桌面。`)) return
    commitHolders(holdersRef.current.filter(item => item.id !== holder.id))
    setPluginWindows(list => list.filter(win => win.key !== holder.id))
    const positions = iconPositionsRef.current
    delete positions.flat[holder.id]
    delete positions.depth[holder.id]
    saveIconPositions(positions)
    showNotice('已解散收纳盒')
  }
  const renameHolderTo = (holder, name) => {
    const next = String(name || '').trim().slice(0, 40)
    if (!next) return
    commitHolders(holdersRef.current.map(item => item.id === holder.id ? { ...item, name: next } : item))
    setRename(null)
    showNotice('已重命名收纳盒')
  }
  const mergeIcons = (targetIcon, sourceIcon) => {
    const targetId = targetIcon?.dataset.worldIconId, sourceId = sourceIcon?.dataset.worldIconId
    if (!targetId || !sourceId || targetId === sourceId) return false
    if (targetId === 'dsh' || sourceId === 'dsh') { showNotice('DeepSeek Harness 主应用不能放进收纳盒'); return false }
    if (sourceId.startsWith('holder:')) { showNotice('收纳盒不能放进另一个收纳盒'); return false }
    const targetHolder = holdersRef.current.find(holder => holder.id === targetId)
    if (targetHolder) {
      if (targetHolder.items.includes(sourceId)) return false
      commitHolders(holdersRef.current.map(holder => holder.id === targetId
        ? { ...holder, items: [...holder.items, sourceId] } : holder))
      showNotice(`已放进「${targetHolder.name}」`)
      return true
    }
    const holder = { id: `holder:${newId()}`, name: '收纳盒', items: [targetId, sourceId] }
    const used = new Set(holdersRef.current.map(item => item.name))
    if (used.has(holder.name)) {
      let index = 2
      while (used.has(`收纳盒 ${index}`)) index++
      holder.name = `收纳盒 ${index}`
    }
    const value = iconPositionsRef.current
    value[depth ? 'depth' : 'flat'][holder.id] = iconPositionOf(targetIcon)
    saveIconPositions(value)
    commitHolders([...holdersRef.current, holder])
    showNotice('已创建收纳盒，右键可以重命名')
    return true
  }
  const findMergeTarget = drag => {
    if (!drag || drag.id === 'dsh' || drag.id.startsWith('holder:')) return null
    const rect = drag.icon.getBoundingClientRect()
    let best = null, bestRatio = 0
    for (const icon of iconsRef.current.querySelectorAll('.world-desktop-icon[data-world-icon-id]')) {
      if (icon === drag.icon) continue
      const id = icon.dataset.worldIconId
      if (!id || id === 'dsh') continue
      const other = icon.getBoundingClientRect()
      const width = Math.max(0, Math.min(rect.right, other.right) - Math.max(rect.left, other.left))
      const height = Math.max(0, Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top))
      const ratio = (width * height) / Math.max(1, Math.min(rect.width * rect.height, other.width * other.height))
      if (ratio > bestRatio) { bestRatio = ratio; best = icon }
    }
    return bestRatio >= .35 ? best : null
  }
  const openHolder = holder => openPlugin(holder.id)
  const openFileLink = link => {
    if (link.type === 'directory') openVscode(link.path)
    else openVscodeFile(link.path)
  }
  const deleteFileLink = link => {
    if (!window.confirm(`从桌面移除「${link.name}」？只移除桌面记录，不会删除磁盘上的文件。`)) return
    commitFileLinks(fileLinksRef.current.filter(item => item.id !== link.id))
    const positions = iconPositionsRef.current
    delete positions.flat[link.id]
    delete positions.depth[link.id]
    saveIconPositions(positions)
    for (const holder of holdersRef.current) {
      if (holder.items.includes(link.id)) applyHolderItems(holder, holder.items.filter(id => id !== link.id))
    }
    setContextMenu(null)
    showNotice('已从桌面移除，文件本身未改动')
  }

  const beginResize = edge => event => {
    phoneDesktopRects.current.delete('dsh')
    if (state !== 'normal') return
    event.stopPropagation()
    event.preventDefault()
    dragRef.current = {
      kind: 'resize', edge, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, position, moved: false,
    }
    document.body.dataset.worldAdjusting = 'true'
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const beginDrag = event => {
    if (isPhoneViewport()) return
    if (state !== 'normal' || event.target.closest('button')) return
    phoneDesktopRects.current.delete('dsh')
    setActiveWindow('dsh')
    dragRef.current = { kind: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, position, moved: false }
    document.body.dataset.worldAdjusting = 'true'
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const moveDrag = event => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const width = window.innerWidth || 1, height = window.innerHeight || 1
    const dx = ((event.clientX - drag.startX) / width) * 100
    const dy = ((event.clientY - drag.startY) / height) * 100
    const nextRect = { ...drag.position }
    if (drag.kind === 'move') {
      nextRect.x += dx
      nextRect.y += dy
    } else {
      if (drag.edge.includes('w')) { nextRect.x += dx; nextRect.w -= dx }
      if (drag.edge.includes('e')) nextRect.w += dx
      if (drag.edge.includes('n')) { nextRect.y += dy; nextRect.h -= dy }
      if (drag.edge.includes('s')) nextRect.h += dy
    }
    const next = clampRect(nextRect)
    drag.moved ||= next.x !== drag.position.x || next.y !== drag.position.y || next.w !== drag.position.w || next.h !== drag.position.h
    drag.next = next
    document.body.style.setProperty('--world-win-x', `${next.x}vw`)
    document.body.style.setProperty('--world-win-y', `${next.y}vh`)
    document.body.style.setProperty('--world-win-w', `${next.w}vw`)
    document.body.style.setProperty('--world-win-h', `${next.h}vh`)
  }
  const endDrag = event => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    // 甩到桌面顶边就地最大化：位置一个字节都不记，还原时窗口回到拖动前的地方
    const snapped = drag.kind === 'move' && dragTraveled(event, drag) && droppedOnTopEdge(event)
    if (snapped) {
      toggleMaximize()
    } else if (drag.moved && drag.next) {
      setPosition(drag.next)
      savePosition(drag.next)
    }
    if (snapped || drag.moved) {
      ignoreDoubleClick.current = true
      window.setTimeout(() => { ignoreDoubleClick.current = false }, 350)
    }
    dragRef.current = null
    delete document.body.dataset.worldAdjusting
  }
  const toggleFromTitlebar = event => {
    if (event.target.closest('button') || ignoreDoubleClick.current) return
    toggleMaximize()
  }

  /**
   * 任务栏标签：同名的文件夹按「同名里的第几个」编号。
   * 直接用数组下标编号的话，[src, workspace, src] 里的 workspace 会变成 (2)，看着像开了两只。
   */
  const vscodeLabels = (() => {
    const nameOf = win => win.collectionId ? (holders.find(holder => holder.id === win.collectionId)?.name || '收纳盒') : folderName(win.rootPath)
    const totals = new Map()
    for (const win of vscodeWindows) {
      const name = nameOf(win)
      totals.set(name, (totals.get(name) || 0) + 1)
    }
    const seen = new Map()
    return vscodeWindows.map(win => {
      const name = nameOf(win)
      const nth = (seen.get(name) || 0) + 1
      seen.set(name, nth)
      return (totals.get(name) || 0) > 1 ? `${name} (${nth})` : name
    })
  })()

  const taskbarWindows = [
    ...(state !== 'closed' ? [{
      id: 'dsh', label: 'DeepSeek Harness', minimized: state === 'min', active: activeWindow === 'dsh',
      glyph: h(DshMark, { size: 20 }),
    }] : []),
    ...(installedApps.has('vscode') ? vscodeWindows.map((win, index) => ({
      id: `vscode:${win.key}`, label: vscodeLabels[index],
      minimized: win.state === 'min', active: activeWindow === `vscode:${win.key}`,
      glyph: h(VscodeGlyph, { size: 20 }),
    })) : []),
    ...(lanChatOpen && installedApps.has('lanchat') ? [{
      id: 'lanchat', label: '局域网聊天', minimized: lanChatState === 'min', active: activeWindow === 'lanchat',
      glyph: h(LanChatGlyph, { size: 20 }),
    }] : []),
    // 标签页标题不进任务栏：desktopState.windows[].name 会把它带进模型上下文
    ...(browserOpen && installedApps.has('browser') ? [{
      id: 'browser', label: '浏览器', minimized: browserState === 'min', active: activeWindow === 'browser',
      glyph: h(BrowserGlyph, { size: 20 }),
    }] : []),
    ...(terminalOpen && installedApps.has('terminal') ? [{
      id: 'terminal', label: '终端', minimized: terminalState === 'min', active: activeWindow === 'terminal',
      glyph: h(TerminalGlyph, { size: 20 }),
    }] : []),
    ...externalWindows.map(win => {
      const app = externalApps.find(item => item.id === win.id)
      return app ? {
        id: `ext:${win.id}`, label: app.name, minimized: win.state === 'min',
        active: activeWindow === `ext:${win.id}`, glyph: h(ExternalAppGlyph, { app, size: 20 }),
      } : null
    }).filter(Boolean),
    ...pluginWindows.map(win => {
      const app = windowApps.find(item => item.key === win.key) || { label: win.key, icon: null }
      return {
        id: `plugin:${win.key}`, label: app.label, minimized: win.state === 'min',
        active: activeWindow === `plugin:${win.key}`, glyph: h(PluginGlyph, { icon: app.icon, size: 20 }),
      }
    }),
  ]

  const phoneWindowKey = taskbarWindows.map(item => `${item.id}:${item.minimized}`).join('|')
  React.useEffect(() => {
    if (phone && !taskbarWindows.some(item => item.id === activeWindow && !item.minimized)) setActiveWindow('desktop')
  }, [phone, activeWindow, phoneWindowKey])
  const showPhoneHome = () => {
    setActiveWindow('desktop'); setStartOpen(false); setPhoneRecent(false); setContextMenu(null)
    document.activeElement?.blur?.()
  }

  const desktopState = () => ({
    title: document.title || 'world',
    version: WORLD_VERSION,
    control: control.getSnapshot(),
    brainSessionId,
    activeWindow: taskbarWindows.some(item => item.id === activeWindow && !item.minimized) ? activeWindow : null,
    apps: [
      { id: 'dsh', name: 'DeepSeek Harness', installed: true },
      { id: 'vscode', name: 'Visual Studio Code', installed: installedApps.has('vscode') },
      { id: 'lanchat', name: '局域网聊天', installed: installedApps.has('lanchat') },
      { id: 'browser', name: '浏览器', installed: installedApps.has('browser') },
      { id: 'terminal', name: '终端', installed: installedApps.has('terminal') },
      ...externalApps.map(app => ({ id: `ext:${app.id}`, name: app.name, installed: true })),
      ...windowApps.map(app => ({ id: `plugin:${app.key}`, name: app.label, installed: true })),
    ],
    windows: taskbarWindows.map(item => {
      const win = item.id.startsWith('vscode:') ? vscodeWindows.find(win => `vscode:${win.key}` === item.id)
        : item.id.startsWith('ext:') ? externalWindows.find(win => `ext:${win.id}` === item.id)
          : item.id.startsWith('plugin:') ? pluginWindows.find(win => `plugin:${win.key}` === item.id) : null
      return { id: item.id, name: item.label, active: item.active,
        rect: desktopUi.bounds(item.id),
        state: item.id === 'dsh' ? state : item.id === 'lanchat' ? lanChatState
          : item.id === 'browser' ? browserState : item.id === 'terminal' ? terminalState : win?.state || 'normal',
        ...(item.id.startsWith('vscode:') ? { editor: editorHandles.current.get(win.key)?.getState() || null } : {}),
      }
    }),
  })
  desktopApi.current = {
    getState: desktopState,
    async focusForUi(id, signal) {
      restoreWindow(id)
      await waitForDesktop(() => desktopApi.current.getState().activeWindow === id, signal)
    },
    async execute(command, signal) {
      signal.throwIfAborted()
      if (command.action === 'screenshot') return captureDesktopScreenshot({
        maxWidth: command.maxWidth, format: command.format, quality: command.quality,
      })
      if (command.action === 'layout') return { layout: desktopUi.layout(command) }
      if (UI_ACTIONS.includes(command.action)) return desktopUi.execute(command, signal)
      const known = desktopState()
      let id = command.windowId
      const focusEditor = async () => {
        if (id?.startsWith('vscode:'))
          await waitForDesktop(() => editorHandles.current.get(id.slice(7))?.focus(), signal)
      }
      if (command.action === 'open_app' || command.action === 'open_file') {
        const appId = command.action === 'open_file' ? 'vscode' : command.appId
        if (!known.apps.find(app => app.id === appId && app.installed))
          throw desktopError('应用尚未安装或已不可用，请在开始菜单中安装后重试。', 'WORLD_DESKTOP_APP')
        if (appId === 'vscode') {
          if (!command.session?.id || !command.session.cwd) throw desktopError('缺少调用会话的工作目录。', 'WORLD_DESKTOP_SESSION')
          const normalize = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '')
          const root = normalize(command.session.cwd)
          let win = command.windowId ? vscodeWindows.find(win => `vscode:${win.key}` === command.windowId)
            : vscodeWindows.find(win => win.session?.id === command.session.id && normalize(win.rootPath) === root)
          if (command.windowId && (!win || win.session?.id !== command.session.id || normalize(win.rootPath) !== root))
            throw desktopError('目标编辑器不属于调用会话的工作目录。', 'WORLD_DESKTOP_SESSION')
          id = win ? `vscode:${win.key}` : openVscode(command.session.cwd, command.session)
          if (win) restoreWindow(id)
          const handle = await waitForDesktop(() => editorHandles.current.get(id.slice(7)), signal)
          if (command.action === 'open_file') await handle.openFile(command, signal)
        } else if (appId === 'dsh') { id = 'dsh'; openWindow() }
        else if (appId === 'lanchat') { id = 'lanchat'; openLanChat() }
        else if (appId === 'browser') { id = 'browser'; openBrowser() }
        else if (appId === 'terminal') { id = 'terminal'; openTerminal() }
        else if (appId.startsWith('ext:')) { id = appId; openExternalApp(appId.slice(4)) }
        else if (appId.startsWith('plugin:')) { id = appId; openPlugin(appId.slice(7)) }
      } else {
        const win = known.windows.find(win => win.id === id)
        if (!win) throw desktopError('窗口不存在或已经关闭，请重新读取桌面状态。', 'WORLD_DESKTOP_WINDOW')
        if (command.action === 'focus_window') restoreWindow(id)
        else if (['minimize_window', 'maximize_window', 'restore_window'].includes(command.action)) {
          const target = command.action === 'minimize_window' ? 'min' : command.action === 'maximize_window' ? 'max' : 'normal'
          if (target === 'min' && win.state === 'min') return { windowId: id }
          if (id === 'dsh') {
            if (target === 'min') minimize()
            else { lastOpenState.current = target; setState(target) }
          } else if (id === 'lanchat') {
            if (target === 'min') minimizeLanChat()
            else setLanChatState(target)
          } else if (id === 'browser') {
            if (target === 'min') minimizeBrowser()
            else setBrowserState(target)
          } else if (id === 'terminal') {
            if (target === 'min') minimizeTerminal()
            else setTerminalState(target)
          } else if (id.startsWith('vscode:')) {
            if (target === 'min') minimizeVscode(id.slice(7))
            else setVscodeWindows(list => list.map(win => `vscode:${win.key}` === id ? { ...win, state: target } : win))
          } else if (id.startsWith('ext:')) {
            if (target === 'min') minimizeExternalApp(id.slice(4))
            else setExternalWindows(list => list.map(win => `ext:${win.id}` === id ? { ...win, state: target } : win))
          } else if (id.startsWith('plugin:')) {
            if (target === 'min') minimizePlugin(id.slice(7))
            else setPluginWindows(list => list.map(win => `plugin:${win.key}` === id ? { ...win, state: target } : win))
          }
          if (target !== 'min') setActiveWindow(id)
          await waitForDesktop(() => desktopApi.current.getState().windows.find(win => win.id === id && win.state === target), signal)
          if (target !== 'min') await focusEditor()
          return { windowId: id }
        } else throw desktopError('不支持的桌面操作。')
      }
      await waitForDesktop(() => {
        const current = desktopApi.current.getState()
        return current.activeWindow === id && current.windows.find(win => win.id === id && win.state !== 'min')
      }, signal)
      await focusEditor()
      return { windowId: id }
    },
  }
  React.useEffect(() => {
    if (!portal || !rpc?.call) return
    const client = startDesktopClient({ rpc, getState: () => desktopApi.current.getState(),
      execute: (command, signal) => control.run(command, signal, active => desktopApi.current.execute(command, active)),
      subscribe: control.subscribe,
      onActivity: activity => setAssistantActivity(activity),
      onDisconnect: () => {
        const wasControlling = control.getSnapshot().owner === 'assistant'
        setAssistantActivity(null)
        control.takeOver()
        if (wasControlling) showNotice('助手连接已断开，桌面已交还给你。')
      } })
    return () => client.dispose()
  }, [portal, rpc, control])

  // 这一块是助手的"住处"：用第一人称说话，名字和会话只作为落款。
  const assistantName = brainProfile?.name || '助手'
  const assistantSessionTitle = sessions?.list?.getSnapshot?.().byId?.[controlState.sessionId]?.title
  const transcriptEmpty = !(assistantActivity?.messages?.length || assistantActivity?.toolEvents?.length)
  const quietPhase = !assistantActivity || ['idle', 'paused'].includes(assistantActivity.phase)
  const busyPhase = ['starting', 'thinking', 'executing', 'responding'].includes(assistantActivity?.phase)
  // 空着的会话区不摆一块黑板：没有人说话的时候，屋子里得有一句人话。
  const welcomeLine = !transcriptEmpty ? ''
    : assistantActivity?.phase === 'paused' ? '停在这儿了。桌面还是我看着，你说继续我就接着做。'
    : quietPhase ? '这屋子现在归我看着。想让我做什么，直接说；也可以自己动手——我立刻让开。'
    : busyPhase ? '正在做事。你可以看着，也可以随时插一句。'
    : ''

  // 终端里的 `open <应用>`：只列桌面上真能打开的东西，打开的路径和图标双击走同一条
  const launcherApps = [
    { id: 'dsh', label: 'DeepSeek Harness' },
    ...(installedApps.has('vscode') ? [{ id: 'vscode', label: 'Visual Studio Code' }] : []),
    ...(installedApps.has('lanchat') ? [{ id: 'lanchat', label: '局域网聊天' }] : []),
    ...(installedApps.has('browser') ? [{ id: 'browser', label: '浏览器' }] : []),
    { id: 'settings', label: '设置' },
  ]
  const openLauncherApp = id => {
    if (id === 'dsh') return openWindow()
    if (id === 'vscode') return openVscode()
    if (id === 'lanchat') return openLanChat()
    if (id === 'browser') return openBrowser()
    if (id === 'terminal') return openTerminal()
    if (id === 'settings') return openSettingsPanel()
    return undefined
  }

  const allEntries = [
    { id: 'dsh', label: 'DeepSeek Harness', icon: DshMark, kind: 'app', open: openWindow },
    { id: 'settings', label: '设置', icon: SettingsGlyph, kind: 'app', open: openSettingsPanel },
    ...HOST_PANELS.map(page => ({ id: page.id, label: page.label, kind: 'app', note: page.note,
      icon: PluginsGlyph, open: () => openHostPage(page.id) })),
    ...(installedApps.has('vscode') ? [{ id: 'vscode', label: 'Visual Studio Code', icon: VscodeGlyph, kind: 'app', open: () => openVscode() }] : []),
    ...(installedApps.has('lanchat') ? [{ id: 'lanchat', label: '局域网聊天', icon: LanChatGlyph, kind: 'app', open: openLanChat }] : []),
    ...(installedApps.has('browser') ? [{ id: 'browser', label: '浏览器', icon: BrowserGlyph, kind: 'app',
      attrs: { 'data-world-browser-icon': true }, open: openBrowser }] : []),
    ...(installedApps.has('terminal') ? [{ id: 'terminal', label: '终端', icon: TerminalGlyph, kind: 'app',
      attrs: { 'data-world-terminal-icon': true }, open: openTerminal }] : []),
    ...JOURNAL_APPS.map(app => ({ id: `plugin:${app.key}`, label: app.label, icon: app.icon, kind: 'app',
      attrs: { 'data-world-journal-icon': app.key }, open: () => openPlugin(app.key) })),
    ...TASK_APPS.map(app => ({ id: `plugin:${app.key}`, label: app.label, icon: app.icon, kind: 'app',
      attrs: { 'data-world-task-icon': app.key }, open: () => openPlugin(app.key) })),
    ...externalApps.map(app => ({ id: app.id, label: app.name, kind: 'external', app,
      attrs: { 'data-world-external-icon': app.id },
      icon: () => h(ExternalAppGlyph, { app }), open: () => openExternalApp(app.id) })),
    ...fileLinks.map(link => ({ id: link.id, label: link.name, kind: link.type === 'directory' ? 'directory' : 'file',
      path: link.path, link, icon: () => h(FileLinkGlyph, { name: link.name, type: link.type }), open: () => openFileLink(link) })),
    ...holders.map(holder => ({ id: holder.id, label: holder.name, kind: 'holder', holder,
      icon: () => h(HolderGlyph), open: () => openHolder(holder) })),
  ]
  const entryById = id => allEntries.find(entry => entry.id === id)
  const contained = new Set(holders.flatMap(holder => holder.items))
  // 设置、日记、待办只在开始菜单里：桌面上留出位置给真正要用的东西。（垃圾箱还留在桌面。）
  const desktopEntries = allEntries.filter(entry => !contained.has(entry.id) && !DESKTOP_HIDDEN.has(entry.id))
  const menuEntry = contextMenu ? entryById(contextMenu.appId) : null
  const holderHasFiles = holder => holder.items.some(id => {
    const entry = entryById(id)
    return entry?.kind === 'file' || entry?.kind === 'directory'
  })
  // 开始菜单的搜索：应用、文件、收纳盒和整页插件都在同一张表里，按名字和用途匹配。
  const noteOf = id => id === 'settings' ? '原生设置面板'
    : ([...JOURNAL_APPS, ...TASK_APPS].find(app => `plugin:${app.key}` === id)?.description || '')
  const searchCatalog = [
    ...globalThis.__WORLD_MOBILE_ACCESS__ ? [] : [{ key: 'mobile', label: '手机连接', note: '扫码打开 world', hint: '应用',
      icon: () => h(MobileGlyph, { size: 22 }), open: () => { setStartOpen(false); setMobileOpen(true) } }],
    ...allEntries.map(entry => ({ key: entry.id, label: entry.label, note: entry.note || entry.path || entry.app?.description || noteOf(entry.id),
      hint: KIND_HINTS[entry.kind] || '应用', icon: entry.icon, open: entry.open })),
    ...pluginApps.map(app => ({ key: `page:${app.key}`, label: app.label, note: '', hint: '整页插件',
      icon: () => h(PluginGlyph, { icon: app.icon, size: 22 }), open: () => openPlugin(app.key) })),
  ]
  const startTerm = startQuery.trim().toLowerCase()
  const startResults = !startTerm ? [] : searchCatalog
    .filter(row => `${row.label} ${row.hint} ${row.note || ''} ${row.key}`.toLowerCase().includes(startTerm))
    .slice(0, 12)
  const startHitIndex = Math.min(startHit, Math.max(0, startResults.length - 1))
  const openStartResult = row => { if (!row) return; row.open(); setStartOpen(false) }
  // 菜单一屏放不下时得让人看得出来：Chromium 在 Windows 上用覆盖式滚动条，
  // 手指不动它就不出现（::-webkit-scrollbar 也管不到），所以改成内容两端渐隐。
  const startBodyRef = React.useRef(null)
  const startBodyKey = [startOpen, startTerm, installedApps.size, externalApps.length, pluginApps.length].join('|')
  React.useEffect(() => {
    const node = startBodyRef.current
    if (!node) return
    const sync = () => {
      node.classList.toggle('is-scrolled', node.scrollTop > 2)
      node.classList.toggle('is-more', node.scrollTop + node.clientHeight < node.scrollHeight - 2)
    }
    sync()
    node.addEventListener('scroll', sync, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => { node.removeEventListener('scroll', sync); observer.disconnect() }
  }, [startBodyKey])
  // 开始菜单里每一行整块可点：命中行里那颗按钮时交给按钮自己处理，不要触发两次。
  const openCard = (event, open) => { if (event.target.closest('button')) return; open() }
  // 键盘走列表：方向键在应用 / 插件里上下走，Enter 打主操作（未安装是「安装」，否则「打开」）。
  // 行本身不是按钮（里面已经有按钮了），所以给它 tabIndex=-1 只接受程序聚焦，Tab 仍然只落在真按钮上。
  const startPanelRef = React.useRef(null)
  const startRowSelector = '.world-app-card, .world-plugin-card'
  const stepStartRow = (host, delta) => {
    const rows = [...(host || startPanelRef.current)?.querySelectorAll(startRowSelector) || []]
    if (!rows.length) return false
    const current = document.activeElement?.closest?.(startRowSelector)
    const index = current ? rows.indexOf(current) : (delta > 0 ? -1 : rows.length)
    rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.focus()
    return true
  }
  const startRowKeyDown = event => {
    const row = event.target.closest?.(startRowSelector)
    if (!row) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      stepStartRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      // 主操作优先：没装的应用按 Enter 是「安装」，装好的就是「打开」。
      const primary = row.querySelector('.world-app-install') || row.querySelector('.world-app-open') || row
      event.preventDefault()
      primary.click()
    }
  }
  React.useEffect(() => {
    startPanelRef.current?.querySelectorAll('.world-app-card').forEach(row => {
      if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1')
    })
  }, [startBodyKey])

  const desktop = h(React.Fragment, null,
    h(AssistantPointer, { control, pointer: assistantPointer, name: brainProfile?.name || '助手' }),
    h('div', {
      className: 'world-wall', 'aria-hidden': true,
      'data-world-wallpaper': wallpaperConfig.preset,
      style: wallpaperStyle(wallpaperConfig),
      onClick: () => { setSelected(false); setStartOpen(false) },
      // 右键先给菜单：个性化（原来那一步）和刷新（重读桌面数据并重排图标）。
      onContextMenu: event => {
        setSelected(false)
        openContextMenu(event, null, '桌面', 'wall')
      },
    },
      h('div', { className: 'world-wall-scrim', 'aria-hidden': true }),
      h('div', { className: 'world-bloom' },
        h('i', { className: 'world-rib world-r1' }), h('i', { className: 'world-rib world-r2' }),
        h('i', { className: 'world-rib world-r3' }), h('i', { className: 'world-rib world-r4' }),
        h('i', { className: 'world-rib world-r5' }), h('i', { className: 'world-core' })),
      h('div', { className: 'world-floor-wrap' }, h('div', { className: 'world-floor' })),
      h('div', { className: 'world-vignette' })),
    h('div', {
      className: 'world-icons', ref: iconsRef,
      inert: phone && (phoneRecent || (activeWindow !== 'desktop' && taskbarWindows.some(item => item.id === activeWindow && !item.minimized))) ? true : undefined,
      onPointerDown: beginIconDrag,
      onClickCapture: event => { if (suppressIconClickRef.current) { event.preventDefault(); event.stopPropagation() } },
      onDoubleClickCapture: event => { if (suppressIconClickRef.current) { event.preventDefault(); event.stopPropagation() } },
    },
      h(DeskWalker, { phase: assistantActivity?.phase || 'idle' }),
      ...desktopEntries.map(entry => h('button', {
        key: entry.id, type: 'button',
        className: `world-desktop-icon${entry.id === 'dsh' && selected ? ' selected' : ''}`,
        'data-world-icon-id': entry.id, 'data-world-icon-kind': entry.kind,
        ...entry.attrs,
        'aria-label': entry.label, title: entry.label,
        onClick: phone ? () => { setPhoneRecent(false); entry.open() } : entry.id === 'dsh' ? () => setSelected(true) : undefined,
        onDoubleClick: phone ? undefined : entry.open,
        onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); entry.open() } },
        onContextMenu: event => openContextMenu(event, entry.id, entry.label, entry.kind),
      }, h('span', { className: 'world-glyph' }, h(entry.icon)),
      h('span', { className: 'world-icon-label' }, entry.label)))),
    h('section', {
      className: `world-window-frame${state === 'closed' ? ' is-closed' : ''}${state === 'min' ? ' is-min' : ''}${state === 'max' ? ' is-max' : ''}`,
      'aria-label': 'DeepSeek Harness 窗口', 'aria-hidden': state === 'closed' || state === 'min',
    },
    h('header', {
      className: 'world-titlebar', onPointerDown: beginDrag, onPointerMove: moveDrag,
      onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick: toggleFromTitlebar,
    },
      sidebarControl && h('button', {
        type: 'button', className: 'world-sidebar-toggle', 'data-world-sidebar-toggle': true,
        'aria-label': hostSidebar.collapsed ? '展开聊天列表' : '收起聊天列表', 'aria-expanded': !hostSidebar.collapsed,
        title: hostSidebar.collapsed ? '展开聊天列表' : '收起聊天列表', disabled: hostSidebar.blocked,
        onPointerDown: event => event.stopPropagation(), onDoubleClick: event => event.stopPropagation(),
        onClick: () => toggleSidebar(),
      }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('path', { d: 'M9 4v16' }))),
      h('div', { className: `world-title${sidebarControl ? ' has-sidebar-control' : ''}` }, h(DshMark, { size: 16 }), h('span', null, 'DeepSeek Harness')),
      h(WindowControls, { state, onMinimize: minimize, onToggleMaximize: toggleMaximize, onClose: closeWindow })),
    state === 'normal' ? ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => h('div', {
      key: edge, className: `world-resize-handle world-resize-${edge}`, 'aria-hidden': true,
      onPointerDown: beginResize(edge), onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
    })) : null,
    !rootReady && state !== 'closed' && state !== 'min'
      ? h('div', { className: 'world-root-warning', role: 'status' }, '未检测到宿主界面容器 #root')
      : null),
    h('div', {
      className: `world-start${startOpen ? ' open' : ''}`, 'aria-label': '开始菜单', 'aria-hidden': !startOpen,
      ref: startPanelRef, onKeyDown: startRowKeyDown,
      // 菜单里的右键不弹宿主默认菜单：这里的行没有桌面图标那套右键动作，弹出来只会是干扰。
      onContextMenu: event => event.preventDefault(),
    },
      h('div', { className: 'world-start-search' },
        h('svg', { className: 'world-start-search-glyph', width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true },
          h('circle', { cx: 7, cy: 7, r: 4.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M10.4 10.4 L14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
        h('input', {
          ref: startSearchRef, type: 'text', value: startQuery, spellCheck: false,
          className: 'world-start-search-input', 'data-world-start-search': true,
          placeholder: '搜索应用、文件、插件', 'aria-label': '搜索应用、文件、插件',
          tabIndex: startOpen ? undefined : -1,
          onChange: event => { setStartQuery(event.target.value); setStartHit(0) },
          onKeyDown: event => {
            // 有搜索结果时方向键在结果里走；没有结果（也就是没在搜）时，方向键把焦点送进下面的列表。
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); event.stopPropagation()
              const step = event.key === 'ArrowDown' ? 1 : -1
              if (!startResults.length) { stepStartRow(startPanelRef.current, step); return }
              setStartHit(step > 0
                ? Math.min(startHitIndex + 1, Math.max(0, startResults.length - 1))
                : Math.max(0, startHitIndex - 1))
            } else if (event.key === 'Enter') {
              event.preventDefault(); event.stopPropagation()
              openStartResult(startResults[startHitIndex])
            } else if (event.key === 'Escape') {
              // The first Escape clears the query; only the second one closes the menu (the global handler's job).
              event.preventDefault(); event.stopPropagation()
              if (startQuery) { setStartQuery(''); setStartHit(0) } else setStartOpen(false)
            }
          },
        }),
        startQuery
          ? h('button', {
            type: 'button', className: 'world-start-search-clear', 'aria-label': '清空搜索',
            onClick: () => { setStartQuery(''); setStartHit(0); startSearchRef.current?.focus() },
          }, '×')
          : null),
      h('div', { className: 'world-start-body', ref: startBodyRef },
        startTerm
          ? h('section', { className: 'world-start-group' },
            h('div', { className: 'world-start-group-title' }, '搜索结果',
              h('span', null, startResults.length ? `${startResults.length} 项` : '没有匹配')),
            startResults.length === 0
              ? h('div', { className: 'world-start-empty' }, `没有找到「${startQuery.trim()}」。`)
              : startResults.map((row, index) => h('button', {
                key: row.key, type: 'button',
                className: `world-search-result${index === startHitIndex ? ' on' : ''}`,
                'data-world-search-result': row.key,
                onClick: () => openStartResult(row),
                onMouseEnter: () => setStartHit(index),
              },
              h('span', { className: 'world-search-result-icon' }, h(row.icon)),
              h('span', { className: 'world-search-result-text' },
                h('strong', null, row.label),
                h('span', null, row.note || row.hint)))))
          : h(React.Fragment, null,
            h('section', { className: 'world-start-group' },
          h('div', { className: 'world-start-group-title' }, '应用',
            externalApps.length ? h('span', null, `${externalApps.length} 个外部应用`) : null),
          // 顺序按「先干什么、后干什么」排：日记/待办这些天天点的在最上面，「设置 / 插件管理」
          // 这种配置入口沉到最后。以前设置排第一行，每次开菜单第一眼看到的是配置项而不是要用的东西。
          ...JOURNAL_APPS.map(app => h('div', {
            key: app.key, className: 'world-app-card', 'data-world-app-card': app.key,
            onClick: event => openCard(event, () => openPlugin(app.key)),
          },
            h('span', { className: 'world-app-card-icon' }, h(app.icon, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, app.label), h('span', null, app.description)),
            h('button', { type: 'button', className: 'world-app-open', onClick: () => openPlugin(app.key) }, '打开'))),
          ...TASK_APPS.map(app => h('div', {
            key: app.key, className: 'world-app-card', 'data-world-app-card': app.key,
            onClick: event => openCard(event, () => openPlugin(app.key)),
          },
            h('span', { className: 'world-app-card-icon' }, h(app.icon, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, app.label), h('span', null, app.description)),
            h('button', { type: 'button', className: 'world-app-open', onClick: () => openPlugin(app.key) }, '打开'))),
          h('div', {
            className: 'world-app-card', 'data-world-app-card': 'vscode',
            onClick: event => openCard(event, () => { if (installedApps.has('vscode')) openVscode() }),
          },
            h('span', { className: 'world-app-card-icon' }, h(VscodeGlyph, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, 'Visual Studio Code'), h('span', null, '轻量代码编辑器')),
            installedApps.has('vscode')
              ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'world-app-open', onClick: () => openVscode() }, '打开'),
                h('button', { type: 'button', className: 'world-app-uninstall', onClick: uninstallVscode }, '卸载'))
              : h('button', { type: 'button', className: 'world-app-install', onClick: installVscode }, '安装')),
          h('div', {
            className: 'world-app-card', 'data-world-app-card': 'lanchat',
            onClick: event => openCard(event, () => { if (installedApps.has('lanchat')) openLanChat() }),
          },
            h('span', { className: 'world-app-card-icon' }, h(LanChatGlyph, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, '局域网聊天'), h('span', null, '发现局域网里的 dsh · 私聊群聊')),
            installedApps.has('lanchat')
              ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'world-app-open', onClick: openLanChat }, '打开'),
                h('button', { type: 'button', className: 'world-app-uninstall', onClick: uninstallLanChat }, '卸载'))
              : h('button', { type: 'button', className: 'world-app-install', onClick: installLanChat }, '安装')),
          h('div', {
            className: 'world-app-card', 'data-world-app-card': 'browser',
            onClick: event => openCard(event, () => { if (installedApps.has('browser')) openBrowser() }),
          },
            h('span', { className: 'world-app-card-icon' }, h(BrowserGlyph, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, '浏览器'), h('span', null, '内置网页窗口 · 多标签')),
            installedApps.has('browser')
              ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'world-app-open', 'data-world-browser-open': true, onClick: openBrowser }, '打开'),
                h('button', { type: 'button', className: 'world-app-uninstall', onClick: uninstallBrowser }, '卸载'))
              : h('button', { type: 'button', className: 'world-app-install', onClick: installBrowser }, '安装')),
          h('div', {
            className: 'world-app-card', 'data-world-app-card': 'terminal',
            onClick: event => openCard(event, () => { if (installedApps.has('terminal')) openTerminal() }),
          },
            h('span', { className: 'world-app-card-icon' }, h(TerminalGlyph, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, '终端'), h('span', null, '命令行窗口 · 在会话目录里跑命令')),
            installedApps.has('terminal')
              ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'world-app-open', 'data-world-terminal-open': true, onClick: openTerminal }, '打开'),
                h('button', { type: 'button', className: 'world-app-uninstall', onClick: uninstallTerminal }, '卸载'))
              : h('button', { type: 'button', className: 'world-app-install', onClick: installTerminal }, '安装')),
          !globalThis.__WORLD_MOBILE_ACCESS__ && h('div', {
            className: 'world-app-card', 'data-world-app-card': 'mobile',
            onClick: event => openCard(event, () => { setStartOpen(false); setMobileOpen(true) }),
          },
            h('span', { className: 'world-app-card-icon' }, h(MobileGlyph)),
            h('div', { className: 'world-app-card-info' }, h('strong', null, '手机连接'), h('span', null, '扫码打开 world')),
            h('button', { type: 'button', className: 'world-app-open', 'data-world-mobile-open': true,
              onClick: () => { setStartOpen(false); setMobileOpen(true) } }, '打开')),
          // 配置入口沉底：原生设置面板和注册了宿主页面的插件页面。
          h('div', {
            key: 'settings', className: 'world-app-card', 'data-world-app-card': 'settings',
            onClick: event => openCard(event, openSettingsPanel),
          },
            h('span', { className: 'world-app-card-icon' }, h(SettingsGlyph, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, '设置'), h('span', null, '原生设置面板 · 打开在 DSH 窗口里')),
            h('button', { type: 'button', className: 'world-app-open', 'data-world-settings-open': true, onClick: openSettingsPanel }, '打开')),
          ...HOST_PANELS.map(page => h('div', {
            key: page.id, className: 'world-app-card', 'data-world-app-card': page.id,
            onClick: event => openCard(event, () => openHostPage(page.id)),
          },
            h('span', { className: 'world-app-card-icon' }, h(PluginsGlyph, { size: 34 })),
            h('div', { className: 'world-app-card-info' }, h('strong', null, page.label), h('span', null, page.note)),
            h('button', { type: 'button', className: 'world-app-open', 'data-world-host-panel': page.id, onClick: () => openHostPage(page.id) }, '打开'))),
          h('div', { className: 'world-external-cards' },
            ...externalApps.map(app => h('div', {
              key: app.id, className: 'world-app-card', 'data-world-app-card': app.id,
              onClick: event => openCard(event, () => openExternalApp(app.id)),
            },
              h('span', { className: 'world-app-card-icon' }, h(ExternalAppGlyph, { app, size: 34 })),
              h('div', { className: 'world-app-card-info' }, h('strong', null, app.name), h('span', null, app.description || '外部应用包')),
              h('button', { type: 'button', className: 'world-app-open', onClick: () => openExternalApp(app.id) }, '打开'),
              h('button', { type: 'button', className: 'world-app-uninstall', onClick: () => uninstallExternalApp(app.id) }, '卸载'))))
          ),
        h('section', { className: 'world-start-group' },
          h('div', { className: 'world-start-group-title' }, '插件',
            pluginApps.length ? h('span', null, `${pluginApps.length} 个整页插件`) : null),
          pluginApps.length === 0
            ? h('div', { className: 'world-start-empty' }, '未检测到注册整页的插件')
            : pluginApps.map(app => {
              const win = pluginWindows.find(item => item.key === app.key)
              return h('button', {
                key: app.key, type: 'button', className: 'world-plugin-card',
                'data-world-plugin-card': app.key, 'aria-label': `${app.label} 插件`,
                onClick: () => openPlugin(app.key),
              },
              h('span', { className: 'world-plugin-card-icon' }, h(PluginGlyph, { icon: app.icon, size: 22 })),
              h('span', { className: 'world-plugin-card-info' },
                h('strong', null, app.label),
                h('span', null, win ? (win.state === 'min' ? '已最小化' : '运行中') : '整页插件')),
              h('span', { className: 'world-plugin-card-action' }, win && win.state !== 'min' ? '置顶' : '打开'))
            })))),
      // 底部状态栏：助手个性化原本挂在顶部标题行，跟着那颗 18px 的「应用」大标题一起
      // 和下面的分组标题撞名字；现在标题没了，个性化与键盘提示合成一条安静的页脚。
      h('div', { className: 'world-start-foot' },
        h('button', {
          type: 'button', className: 'world-start-personalize',
          'data-world-personalize': true, onClick: openPersonalization,
        },
        h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
          h('path', { d: 'M4 7h10M18 7h2M4 17h4M12 17h8' }),
          h('circle', { cx: 16, cy: 7, r: 2.2 }), h('circle', { cx: 10, cy: 17, r: 2.2 })),
        '助手个性化'),
        h('span', { className: 'world-start-hint' }, startTerm ? 'Enter 打开 · Esc 清空' : '方向键选择 · Enter 打开'))),
    h('div', { className: 'world-phone-status', 'aria-hidden': !phone }, h('span', null, 'world'),
      phone && h('div', { className: 'world-clock', ref: clockRef },
        h('div', { 'data-world-time': true }, clock?.time || ''), h('div', { className: 'world-date', 'data-world-date': true }, clock?.date || ''))),
    phone && phoneRecent && h('section', { className: 'world-phone-switcher', 'aria-label': '应用切换', ref: recentRef },
      h('header', null, h('strong', null, '运行中的应用'),
        h('button', { type: 'button', onClick: () => setPhoneRecent(false), 'aria-label': '收起应用切换' }, '完成')),
      h('div', { className: 'world-phone-running' },
        taskbarWindows.length ? taskbarWindows.map(item => h('button', {
          key: item.id, type: 'button', 'data-world-phone-window': item.id,
          onClick: () => restoreWindow(item.id),
        }, h('span', { className: 'world-phone-running-icon' }, item.glyph),
        h('span', null, h('strong', null, item.label), h('small', null, item.minimized ? '已最小化' : '运行中'))))
          : h('p', null, '还没有打开的应用'))),
    h('div', { className: 'world-taskbar' },
      phone && h('nav', { className: 'world-phone-nav', 'aria-label': '手机导航' },
        h('button', { type: 'button', className: 'world-start-button', 'aria-label': '全部应用', 'aria-expanded': startOpen,
          onClick: () => { setPhoneRecent(false); setStartOpen(open => !open) } }, h(PhoneGlyph, { kind: 'apps' })),
        h('button', { type: 'button', 'aria-label': '返回桌面', onClick: showPhoneHome }, h(PhoneGlyph, { kind: 'home' })),
        h('button', { type: 'button', 'aria-label': '切换应用', 'aria-expanded': phoneRecent,
          onClick: () => { setStartOpen(false); setPhoneRecent(open => !open) } }, h(PhoneGlyph, { kind: 'recent' }))),
      h('span', { className: 'world-version', 'data-world-version': WORLD_VERSION }, `world v${WORLD_VERSION}`),
      h('div', { className: 'world-taskbar-center' },
        h('button', {
          className: `world-start-button${startOpen ? ' on' : ''}`, type: 'button', title: '开始',
          'aria-label': '开始', 'aria-expanded': startOpen, onClick: () => setStartOpen(open => !open),
        }, h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', 'aria-hidden': true },
          h('rect', { x: 1, y: 1, width: 8, height: 8, rx: 1, fill: 'currentColor' }),
          h('rect', { x: 11, y: 1, width: 8, height: 8, rx: 1, fill: 'currentColor' }),
          h('rect', { x: 1, y: 11, width: 8, height: 8, rx: 1, fill: 'currentColor' }),
          h('rect', { x: 11, y: 11, width: 8, height: 8, rx: 1, fill: 'currentColor' }))),
        taskbarWindows.length > 0
          ? h('div', { className: 'world-taskbar-apps' }, taskbarWindows.map((item, index) =>
            h('button', {
              key: item.id, type: 'button',
              className: `world-taskbar-app${item.active ? ' on' : ''}${item.minimized ? ' is-min' : ''}`,
              'data-world-taskbar': item.id, 'aria-label': `${item.label}（窗口 ${index + 1}）`,
              title: item.minimized ? `${item.label} · 已最小化，点击还原` : `${item.label} · 点击最小化`,
              onClick: () => taskbarToggle(item.id),
            },
            h('span', { className: 'world-taskbar-app-icon' }, item.glyph),
            h('span', { className: 'world-taskbar-app-name' }, item.label))))
          : null),
      h('div', { className: 'world-taskbar-right' },
        h('button', {
          type: 'button', className: `world-control-button${controlState.owner === 'assistant' ? ' on' : ''}`,
          'data-world-control-button': true, 'aria-pressed': controlState.owner === 'assistant',
          'aria-label': controlState.owner === 'assistant' ? '换你来' : controlState.phase === 'granting' ? '取消交接' : '交给助手',
          title: controlState.owner === 'assistant' ? '换你来 · 现在这间屋子看着的是助手'
            : controlState.phase === 'granting' ? '正在交接 · 点击取消' : '交给助手 · 现在这间屋子归你',
          onClick: async () => {
            if (control.getSnapshot().owner === 'assistant' || control.getSnapshot().phase === 'granting') control.takeOver()
            else {
              try {
                const granted = await control.handoff(async () => {
                  const info = await brainCall('get', {})
                  if (info.setupRequired) {
                    if (control.getSnapshot().phase === 'granting') setBrainSetup({ sessionId: info.sessionId, initialSessionId: session?.id || '' })
                    return null
                  }
                  return brainCall('bind', { sessionId: session?.id || '' })
                })
                if (granted) showNotice('交给我了。你随时可以接手。')
              }
              catch (error) { showNotice(error.message) }
            }
          },
        }, h(ControlGlyph)),
        h('button', {
          type: 'button', className: `world-depth-toggle${depth ? ' on' : ''}`,
          'data-world-depth-toggle': depth ? 'on' : 'off', 'aria-pressed': depth,
          title: depth ? '关闭 3D 景深' : '开启 3D 景深', 'aria-label': '3D 景深',
          onClick: () => setDepth(value => !value),
        }, h(DepthGlyph, { size: 20 })),
        !phone && h('div', { className: 'world-clock', ref: clockRef },
          h('div', { 'data-world-time': true }, clock?.time || ''), h('div', { className: 'world-date', 'data-world-date': true }, clock?.date || '')))),
    ...(installedApps.has('vscode') ? vscodeWindows.map(win => {
      const isActive = activeWindow === `vscode:${win.key}`
      const holder = win.collectionId ? holders.find(item => item.id === win.collectionId) : null
      const collection = win.collectionId ? (holder ? { id: holder.id, name: holder.name,
        entries: holder.items.map(entryById)
          .filter(item => item && (item.kind === 'file' || item.kind === 'directory'))
          .map(item => ({ name: item.label, path: item.path, type: item.kind })) } : null) : null
      if (win.collectionId && !collection) return null
      return h(VscodeWindow, {
        key: win.key,
        windowKey: win.key,
        session: win.session, remote, rpc, getDirectoryPicker,
        rootPath: win.rootPath, collection, openRequest: win.openRequest,
        rect: win.rect, isActive, state: win.state || 'normal',
        // VSCode 这一类在最前时，激活的那个压在最上面；其余情况统一压到 dsh 之上、外部应用之下
        zIndex: activeWindow.startsWith('vscode:') ? (isActive ? 5 : 4) : 3,
        onClose: () => closeVscode(win.key),
        onMinimize: () => minimizeVscode(win.key),
        onToggleMaximize: () => toggleMaximizeVscode(win.key),
        onDirtyChange: dirty => setVscodeWindowDirty(win.key, dirty),
        onRootChange: rootPath => updateVscodeRoot(win.key, rootPath),
        onOpenInNewWindow: rootPath => openVscode(rootPath),
        onFocusFolder: rootPath => Boolean(focusVscodeFolder(rootPath, win.key)),
        ...(collection ? {} : { onDesktopRegister: registerDesktopEditor }),
        onDragStart: beginVscodeDrag(win.key),
        onDragMove: moveVscode, onDragEnd: endVscodeDrag,
        onResizeStart: beginVscodeResize(win.key),
        onActivate: () => setActiveWindow(`vscode:${win.key}`),
      })
    }).filter(Boolean) : []),
    lanChatOpen && installedApps.has('lanchat') && h(LanChatWindow, {
      rect: lanChatRect, state: lanChatState, rpc,
      onClose: closeLanChat, onMinimize: minimizeLanChat, onToggleMaximize: toggleMaximizeLanChat,
      onDragStart: beginLanChatDrag, onDragMove: moveLanChat, onDragEnd: endLanChatDrag,
      onResizeStart: beginLanChatResize, onActivate: () => setActiveWindow('lanchat'),
    }),
    browserOpen && installedApps.has('browser') && h(BrowserWindow, {
      rect: browserRect, state: browserState, active: activeWindow === 'browser',
      // 原生 guest 不参与 DOM 合成：开始菜单/其它应用在前台时隐藏它，避免盖住上层窗口
      suspended: startOpen || phoneRecent || (activeWindow !== 'browser' && (phone || activeWindow !== 'dsh')),
      onClose: closeBrowser, onMinimize: minimizeBrowser, onToggleMaximize: toggleMaximizeBrowser,
      onDragStart: beginBrowserDrag, onDragMove: moveBrowser, onDragEnd: endBrowserDrag,
      onResizeStart: beginBrowserResize, onActivate: () => setActiveWindow('browser'),
      onTakeOver: () => control.takeOver(),
    }),
    terminalOpen && installedApps.has('terminal') && h(TerminalWindow, {
      rect: terminalRect, state: terminalState, rpc, session, active: activeWindow === 'terminal',
      apps: launcherApps, onOpenApp: openLauncherApp,
      onClose: closeTerminal, onMinimize: minimizeTerminal, onToggleMaximize: toggleMaximizeTerminal,
      onDragStart: beginTerminalDrag, onDragMove: moveTerminal, onDragEnd: endTerminalDrag,
      onResizeStart: beginTerminalResize, onActivate: () => setActiveWindow('terminal'),
    }),
    ...pluginWindows.map(win => {
      const holder = win.key.startsWith('holder:') ? holders.find(item => item.id === win.key) : null
      if (win.key.startsWith('holder:') && !holder) return null
      const app = windowApps.find(item => item.key === win.key)
        || { key: win.key, label: win.key, icon: null }
      const id = `plugin:${win.key}`
      return h(PluginWindow, {
        key: win.key, app, win, active: activeWindow === id, renderSlot,
        ...(JOURNAL_APPS.some(item => item.key === win.key) ? { children: h(JournalPage, { client: journalClient,
          trash: win.key === 'world-trash', visible: win.state !== 'min' }) } : {}),
        ...(TASK_APPS.some(item => item.key === win.key) ? { children: h(TasksPage, { rpc,
          visible: win.state !== 'min', onDirtyChange: value => { taskDirtyRef.current = value } }) } : {}),
        ...(holder ? { children: h(HolderPage, {
          holder,
          items: holder.items.map(entryById).filter(Boolean),
          onOpen: item => item.open(),
          onRemove: item => removeHolderItem(holder, item.id),
          onRename: () => setRename({ id: holder.id, name: holder.name }),
          onOpenInVscode: () => openVscodeCollection(holder),
          onDissolve: () => dissolveHolder(holder),
        }) } : {}),
        onActivate: () => focusPlugin(win.key),
        onMinimize: () => minimizePlugin(win.key),
        onToggleMaximize: () => toggleMaximizePlugin(win.key),
        onClose: () => closePlugin(win.key),
        onDragStart: beginPluginDrag(win.key),
        onDragMove: movePluginDrag, onDragEnd: endPluginDrag,
        onResizeStart: beginPluginResize(win.key),
      })
    }),
    ...externalWindows.map(win => {
      const app = externalApps.find(item => item.id === win.id)
      if (!app) return null
      const id = `ext:${win.id}`
      return h(ExternalAppWindow, {
        key: win.id, app, rect: win.rect, state: win.state, active: activeWindow === id,
        onActivate: () => setActiveWindow(id),
        onClose: () => closeExternalApp(win.id),
        onMinimize: () => minimizeExternalApp(win.id),
        onToggleMaximize: () => toggleMaximizeExternalApp(win.id),
        onDragStart: beginExternalDrag(win.id),
        onDragMove: moveExternalDrag, onDragEnd: endExternalDrag,
        onResizeStart: beginExternalResize(win.id),
      })
    }),
    personalization && h(WorkbenchSetup, {
      key: 'personalization', editing: true, loading: personalization.loading, loadError: personalization.error,
      initialProfile: personalization.info?.profile,
      onCancel: closePersonalization,
      onSave: async profile => {
        await brainCall('update_profile', { profile, expectedRevision: personalization.info.revision,
          expectedSessionId: personalization.info.sessionId })
        closePersonalization()
        showNotice('助手个性化已保存')
      },
    }),
    brainSetup && h(WorkbenchSetup, {
      key: 'onboarding',
      sessionId: brainSetup.sessionId,
      onCancel: () => { control.takeOver(); setBrainSetup(null) },
      onSave: async background => {
        const granted = await control.handoff(() => brainCall('configure', { sessionId: brainSetup.initialSessionId, background }))
        if (granted) setBrainSetup(null)
      },
    }),
    mobileOpen && h(MobileConnect, { rpc, onClose: () => setMobileOpen(false) }),
    wallpaperOpen && h(WallpaperPanel, {
      value: wallpaper, mode: depth ? 'depth' : 'flat',
      onChange: setWallpaper, onClose: () => setWallpaperOpen(false),
    }),
    controlState.owner === 'assistant' && h('aside', {
      className: 'world-control-overlay', 'aria-label': '助手在场', 'data-world-control-overlay': true,
    }, h('div', {
      className: `world-control-card is-${assistantActivity?.phase || 'syncing'}${busyPhase ? ' is-working' : ''}${assistantCollapsed ? ' is-collapsed' : ''}`,
      ref: assistantCardRef, 'data-world-control-ui': true, 'data-world-assistant-phase': assistantActivity?.phase || 'syncing',
      onPointerDownCapture: () => { assistantPanelInteractionRef.current = true },
      onPointerOverCapture: () => { assistantPanelInteractionRef.current = true },
      onPointerLeave: event => {
        if (!event.relatedTarget?.closest?.('[data-world-control-ui]')) assistantPanelInteractionRef.current = false
      },
      onFocusCapture: () => { assistantPanelInteractionRef.current = true } },
      h('header', { className: 'world-control-header' },
        h('span', { className: 'world-control-avatar', 'aria-hidden': true },
          h('i', { className: 'world-presence-orbit', 'data-world-presence-orbit': true }),
          h('i', { className: 'world-presence-ping', 'data-world-presence-ping': true })),
        h('div', { className: 'world-control-copy' },
          h('strong', { title: '我在 · 你随时可以接手' }, '我在'),
          h('span', { className: 'world-control-session', title: `会话 ${assistantSessionTitle || controlState.sessionId || '未绑定'}` },
            assistantSessionTitle ? `${assistantName} · ${assistantSessionTitle}` : `${assistantName} · 桌面交给我了`)),
        h('div', { className: 'world-workbench-setup-actions' },
          h('button', {
            type: 'button', 'data-world-assistant-pause': paused ? 'paused' : 'running',
            className: paused ? 'is-paused' : undefined, 'aria-pressed': paused, disabled: pauseBusy,
            title: paused ? '继续 · 我接着照料这间屋子'
              : '先停一下 · 这一轮会跑完，之后我不再自己开新的；桌面还是我的',
            onClick: togglePause,
          }, paused ? '继续' : '暂停'),
          h('button', { type: 'button', 'data-world-assistant-toggle': true,
            'aria-expanded': !assistantCollapsed, 'aria-controls': 'world-assistant-conversation',
            'aria-label': assistantCollapsed ? '展开助手面板' : '收起助手面板',
            onClick: () => setAssistantCollapsed(value => !value) }, assistantCollapsed ? '展开' : '收起'),
          h('button', { type: 'button', onClick: () => control.takeOver(), 'data-world-takeover': true,
            title: '你接手桌面，我停手' }, '换你来'))),
      h('div', { className: 'world-control-copy world-control-activity' }, h(AssistantActivity, { activity: assistantActivity, control: controlState })),
      h('div', { id: 'world-assistant-conversation', className: `world-assistant-conversation${transcriptEmpty ? ' is-empty' : ''}`,
        role: 'region', 'aria-label': '固定助手对话' },
        transcriptEmpty && welcomeLine && h('p', { className: 'world-control-welcome' }, welcomeLine),
        h(AssistantConversation, { sessionId: controlState.sessionId, sessions, SessionProvider, renderSlot, conversationSeat })),
      h('span', { className: 'world-control-hint' }, paused
        ? '停在这儿了 · 你说继续，我就接着做'
        : '你随时动手，我就让开'))),
    rename && h(RenameDialog, { label: '重命名收纳盒', value: rename.name, onCancel: () => setRename(null),
      onSave: name => { const holder = holders.find(item => item.id === rename.id); if (holder) renameHolderTo(holder, name) } }),
    dropActive && h('div', { className: 'world-drop-hint', 'aria-hidden': true },
      h('div', { className: 'world-drop-card' },
        h('strong', null, '松开以登记文件'),
        h('span', null, '.worldapp 应用包会安装；其它文件只记录绝对路径，不复制文件'))),
    contextMenu && h('div', {
      className: `world-context-menu${contextMenu.kind === 'wall' ? ' is-desktop' : ''}`,
      style: { left: contextMenu.x, top: contextMenu.y },
      onPointerDown: event => event.stopPropagation(), onContextMenu: event => event.preventDefault(),
    },
      contextMenu.kind !== 'wall' && h('div', { className: 'world-context-title' }, contextMenu.label),
      contextMenu.kind === 'wall'
        ? h(React.Fragment, null,
          h('button', { type: 'button', 'data-role': 'personalize',
            onClick: () => { setContextMenu(null); setWallpaperOpen(true) } }, '个性化'),
          h('button', { type: 'button', 'data-role': 'refresh', onClick: refreshDesktop }, '刷新'))
        : h(React.Fragment, null,
      h('button', { type: 'button', 'data-role': 'open', onClick: () => menuOpen(contextMenu.appId) }, '打开'),
      menuEntry?.kind === 'holder' && h('button', { type: 'button', 'data-role': 'rename',
        onClick: () => { setContextMenu(null); setRename({ id: menuEntry.id, name: menuEntry.label }) } }, '重命名'),
      menuEntry?.kind === 'holder' && h('button', { type: 'button', 'data-role': 'vscode-folder',
        disabled: !holderHasFiles(menuEntry.holder), title: holderHasFiles(menuEntry.holder) ? '在 VSCode 树中显示收纳盒里的文件' : '收纳盒里还没有文件',
        onClick: () => { setContextMenu(null); openVscodeCollection(menuEntry.holder) } }, '在 VSCode 中作为文件夹打开'),
      (menuEntry?.kind === 'file' || menuEntry?.kind === 'directory') && h('button', { type: 'button', className: 'is-danger', 'data-role': 'delete-link',
        onClick: () => deleteFileLink(menuEntry.link) }, '删除快捷方式'),
      menuEntry?.kind === 'holder' && h('button', { type: 'button', className: 'is-danger', 'data-role': 'dissolve',
        onClick: () => { setContextMenu(null); dissolveHolder(menuEntry.holder) } }, '解散收纳盒'),
      h('button', { type: 'button', 'data-role': 'reposition', onClick: () => resetIconPosition(contextMenu.appId) }, '还原位置'),
      h('button', { type: 'button', 'data-role': 'rearrange', onClick: resetAllIconPositions }, '重排全部图标'),
      menuEntry && (menuEntry.kind === 'external' || ['vscode', 'lanchat', 'browser', 'terminal'].includes(menuEntry.id))
        ? h('button', { type: 'button', className: 'is-danger', 'data-role': 'uninstall', onClick: () => menuUninstall(contextMenu.appId) }, '卸载')
        : menuEntry?.kind === 'app'
          ? h('div', { className: 'world-context-note', 'data-role': 'protected' }, menuEntry.id === 'dsh' ? 'DSH 主应用不可卸载' : '内置应用不可卸载')
          : null)),
    notice && h('div', { className: 'world-toast', role: 'status' }, notice))
  return portal ? createPortal(desktop, portal) : null
}

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-world'
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-world: styles')

  const catalog = createPluginCatalog(ctx)
  const conversationSeat = createConversationSeat({ suspend: ready => suspendMainConversation(ctx.slots, ready) })
  ctx.effect(() => () => conversationSeat.dispose(), 'dsh-world: conversation seat')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'world', order: 100,
    children: {
      [PLUGIN_SLOT]: { kind: 'keyed', scope: 'root' },
      [ASSISTANT_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
    },
    // directoryPicker 只在桌面宿主里存在；延迟取值，网页端打开文件夹对话框时再如实报错。
    inject: () => ({ sessions: ctx.sessions, remote: ctx.remote, rpc: ctx.connection.rpc, catalog, conversationSeat,
      // 原生设置面板只能由 `sidebar.settings` 席位的 store 驱动；拿不到就返回 false 让桌面降级提示。
      openSettings: () => openNativeSettings(ctx.slots),
      // 只能在 DSH 窗口里打开的宿主页面（插件管理），按「设置」的模式处理。
      openPanel: id => openHostPanel(ctx.layout, id),
      toggleSidebar: typeof ctx.layout?.toggleSidebar === 'function' ? () => ctx.layout.toggleSidebar() : undefined,
      getDirectoryPicker: () => typeof ctx.get === 'function' ? ctx.get('remote.directoryPicker') : undefined }),
  }, DesktopLayer))
  ctx.slots.inject(ASSISTANT_CONVERSATION_SLOT, () => ctx.slots.register({
    name: ASSISTANT_CONVERSATION_SLOT,
  }, AssistantConversationContent))
  ctx.slots.inject(PLUGIN_SLOT, () => catalog.start())
}
