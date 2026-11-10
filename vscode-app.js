import React from 'react'
import { highlight, languageLabel, languageOf } from './highlight.js'
import { desktopError, waitForDesktop } from './desktop-client.js'

const h = React.createElement
const EMPTY_FILES = []
const EMPTY_TOKENS = []
const LINE_HEIGHT = 20
const OVERSCAN = 8
const SIDEBAR_KEY = 'dsh.world.vscode.sidebar'
const SIDEBAR_MIN = 168
const SIDEBAR_MAX = 460
const SIDEBAR_DEFAULT = 220
const SIDE_VIEWS = ['files', 'search', 'git']
const SIDE_TITLES = { files: '资源管理器', search: '搜索', git: '源代码管理' }
const SEARCH_DEBOUNCE = 260

/** Sidebar layout survives reloads; a locked-down page without storage must still work. */
function readSidebar() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDEBAR_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function saveSidebar(patch) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ ...readSidebar(), ...patch }))
  } catch { /* storage disabled: keep the layout in memory only */ }
}

function ExplorerIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M5.4 2.4h5.3l3.1 3.1v10.1H5.4z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
    h('path', { d: 'M10.5 2.4v3.2h3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
    h('path', { d: 'M7.7 8.6h4.2M7.7 11.2h2.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
}

/** 活动栏用的分支图标：比文件树里的更粗，18px 下才看得出三个节点。 */
function SourceControlIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
    h('circle', { cx: 6, cy: 4.4, r: 2.2, stroke: 'currentColor', strokeWidth: 1.5 }),
    h('circle', { cx: 6, cy: 15.6, r: 2.2, stroke: 'currentColor', strokeWidth: 1.5 }),
    h('circle', { cx: 14, cy: 7.6, r: 2.2, stroke: 'currentColor', strokeWidth: 1.5 }),
    h('path', { d: 'M6 6.6v6.8M14 9.8c0 3.1-3 3.4-5.6 4.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
}

function SearchIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
    h('circle', { cx: 8, cy: 8, r: 5, stroke: 'currentColor', strokeWidth: 1.4 }),
    h('path', { d: 'm11.8 11.8 3.6 3.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
}

function SidebarIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
    h('rect', { x: 2.4, y: 3.4, width: 13.2, height: 11.2, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M7.1 3.4v11.2', stroke: 'currentColor', strokeWidth: 1.2 }))
}

function CollapseIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M3.4 10.6 8 6l4.6 4.6M3.4 5.4 8 .8l4.6 4.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function ExpandIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M3.4 5.4 8 10l4.6-4.6M3.4 10.6 8 15.2l4.6-4.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function ClearIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
}

/** Count lines without materialising an array of every line (large files). */
function countLines(text) {
  let count = 1
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++
  return count
}

/**
 * 用原生 insertText 改写 textarea。
 * 直接给 value 赋值会清空浏览器的撤销栈（Ctrl+Z 就回不到刚才的输入），
 * 所以优先走 execCommand；只有在它被禁用时才退化成 setRangeText + 手工派发 input。
 */
function insertText(node, text) {
  node.focus({ preventScroll: true })
  try {
    if (document.execCommand('insertText', false, text)) return true
  } catch { /* execCommand unavailable: fall through */ }
  node.setRangeText(text, node.selectionStart, node.selectionEnd, 'end')
  node.dispatchEvent(new Event('input', { bubbles: true }))
  return false
}

/** 选中多行时 Tab 缩进整块、Shift+Tab 反缩进；单行就是插入两个空格。 */
function indentSelection(node, outdent) {
  const value = node.value
  const start = node.selectionStart
  const end = node.selectionEnd
  const blockStart = value.lastIndexOf('\n', start - 1) + 1
  const newline = value.indexOf('\n', end)
  const blockEnd = newline < 0 ? value.length : newline
  const lines = value.slice(blockStart, blockEnd).split('\n')
  if (!outdent && lines.length === 1) { insertText(node, '  '); return }
  const removed = lines.map(line => outdent ? (/^ {1,2}/u.exec(line)?.[0].length ?? 0) : 0)
  const next = lines.map((line, index) => outdent ? line.slice(removed[index]) : `  ${line}`)
  // 全部顶格再反缩进：什么都不做，别把光标推走
  if (next.every((line, index) => line === lines[index])) return
  const offsets = [0]
  for (let index = 1; index < lines.length; index++) offsets.push(offsets[index - 1] + lines[index - 1].length + 1)
  /** 旧坐标 → 新坐标：先补上前面几行的增减，再补本行内的位移。 */
  const shiftTo = position => {
    const local = Math.max(0, Math.min(value.length, position) - blockStart)
    let index = 0
    while (index + 1 < lines.length && offsets[index + 1] <= local) index++
    const column = local - offsets[index]
    let delta = 0
    for (let before = 0; before < index; before++) delta += outdent ? -removed[before] : 2
    return blockStart + offsets[index] + delta + column + (outdent ? -Math.min(column, removed[index]) : 2)
  }
  const nextStart = shiftTo(start)
  const nextEnd = shiftTo(end)
  node.setSelectionRange(blockStart, blockEnd)
  insertText(node, next.join('\n'))
  node.setSelectionRange(nextStart, nextEnd)
}

/** Enter 继承当前行的缩进；行尾是 { ( [ 或 : 时再多缩两格。 */
function autoIndent(node) {
  const value = node.value
  const start = node.selectionStart
  if (start !== node.selectionEnd) { insertText(node, '\n'); return }
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const line = value.slice(lineStart, start)
  const indent = /^[ \t]*/u.exec(line)[0]
  const block = /[{[(]\s*$/u.test(line) || (/:\s*$/u.test(line) && !/^\s*(?:case\b|default\s*:)/u.test(line))
  insertText(node, `\n${indent}${block ? '  ' : ''}`)
}

export function VscodeGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true },
    h('path', { fill: '#007acc', d: 'M36 4 19 7v34l17 3 7-4V8z' }),
    h('path', { fill: '#1f9cf0', d: 'm5 15 5-4 9 7V7l17-3v40l-17-3V30l-9 7-5-4 9-9z' }),
    h('path', { fill: '#fff', d: 'm28 15 5-2v22l-5-2v-5l-7 5-4-2 8-7-8-7 4-2 7 5z' }))
}

function unwrap(result) {
  if (result?.ok === false) throw Object.assign(new Error(result.error?.message || 'Workspace request failed'), { code: result.error?.code })
  return result?.ok === true && Object.hasOwn(result, 'value') ? result.value : result
}

function joinPath(parent, name) {
  if (!parent) return name
  const base = parent === '/' || /^[a-zA-Z]:\/$/u.test(parent) ? parent : parent.replace(/\/+$/u, '')
  return `${base}${base.endsWith('/') ? '' : '/'}${name}`
}

/** Windows paths arrive with backslashes; the editor only ever joins with '/'. */
function normalizePath(path) {
  const text = String(path || '').replace(/\\/gu, '/')
  if (text === '/' || /^[a-zA-Z]:\/$/u.test(text)) return text
  return text.replace(/\/+$/u, '')
}

function baseName(path) {
  const text = normalizePath(path)
  return text.split('/').at(-1) || text || '工作区'
}
function isDirty(tab) {
  if (!tab?.document) return false
  const source = tab.document.source
  return tab.draft.length !== source.length || tab.draft !== source
}

function FolderIcon({ open }) {
  return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: open ? 'M1.5 5.5V4h4l1.5 1.5H14v1.5H1.5zM1.5 7h12.5l-1.2 6H2.7L1.5 7z' : 'M1.5 4h4l1.5 1.5H14v8H1.5V4z',
      fill: 'currentColor', opacity: open ? .95 : .8,
    }))
}

function FileIcon() {
  return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M4 1.5h5l3 3v10H4v-13z', fill: 'currentColor', opacity: .22 }),
    h('path', { d: 'M4 1.5h5l3 3v10H4v-13z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }),
    h('path', { d: 'M9 1.5v3h3', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' }))
}

/** Chevron sits before the folder icon and turns when the node opens, like VSCode's tree. */
function Twist({ open }) {
  return h('svg', {
    className: `world-vscode-twist${open ? ' is-open' : ''}`,
    width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true,
  }, h('path', {
    d: 'M4.4 2.6 7.8 6l-3.4 3.4', stroke: 'currentColor', strokeWidth: 1.3,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

function TwistSpacer() {
  return h('span', { className: 'world-vscode-twist', 'aria-hidden': true })
}

function entryIconClass(name) {
  const ext = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  if (ext === 'js' || ext === 'mjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') return 'is-js'
  if (ext === 'json') return 'is-json'
  if (ext === 'md' || ext === 'txt') return 'is-md'
  return 'is-file'
}

function dirName(path) {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}

/** 复制给用户看的绝对路径：Windows 盘符 / UNC 路径用反斜杠。 */
function nativePath(path) {
  const text = normalizePath(path)
  if (/^[a-zA-Z]:\//u.test(text)) return text.replaceAll('/', '\\')
  if (text.startsWith('//')) return `\\\\${text.slice(2).replaceAll('/', '\\')}`
  return text
}

/** 桌面外壳不一定给剪贴板权限，失败时回退到隐藏 textarea + execCommand。 */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch { return false }
}

/** 欢迎页的快捷键小条：键帽 + 说明。 */
function keyHint(keys, label) {
  return h('span', null, keys.map(key => h('kbd', { key }, key)), label)
}

function BranchIcon({ size = 13 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('circle', { cx: 4.6, cy: 3.6, r: 1.7, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('circle', { cx: 4.6, cy: 12.4, r: 1.7, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('circle', { cx: 11.4, cy: 5.6, r: 1.7, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M4.6 5.3v5.4M11.4 7.3c0 2.4-2.2 2.6-4 3.3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
}

function RefreshIcon({ spinning }) {
  return h('svg', {
    className: `world-vscode-git-spin${spinning ? ' is-spinning' : ''}`,
    width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
  },
  h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
  h('path', { d: 'M13.2 2.4v2.9h-2.9', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function CheckIcon() {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M3.4 8.4 6.4 11.4 12.6 4.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function TransferIcon({ up }) {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: up ? 'M8 12.4V4.2M4.6 7.4 8 4l3.4 3.4' : 'M8 3.6v8.2M4.6 8.6 8 12l3.4-3.4',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function StageIcon({ undo }) {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M8 3.4v9.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: undo ? 0 : 1 }),
    h('path', { d: 'M3.4 8h9.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
}

/** One letter per row, like VSCode's SCM list: index letter for staged, worktree letter otherwise. */
function fileState(file, staged) {
  if (file.conflicted) return '!'
  if (staged) return /[MADRC]/u.test(file.index) ? file.index : 'M'
  if (file.untracked) return 'U'
  return file.worktree === 'D' ? 'D' : 'M'
}

function stateClass(letter) {
  if (letter === 'D' || letter === '!') return 'is-danger'
  if (letter === 'A' || letter === 'U') return 'is-added'
  if (letter === 'R' || letter === 'C') return 'is-moved'
  return 'is-modified'
}

function TreeNode({ parent, entry, depth, expanded, tree, selected, onToggle, onOpen, onPin, onMenu }) {
  const full = entry.path ? normalizePath(entry.path) : joinPath(parent, entry.name)
  const isDir = entry.type === 'directory'
  const open = expanded.has(full)
  const children = isDir ? (tree.get(full) || EMPTY_FILES) : EMPTY_FILES
  return h(React.Fragment, { key: full },
    h('button', {
      type: 'button',
      className: `world-vscode-file${isDir ? ' is-dir' : ''}${open ? ' is-open' : ''}${selected === full ? ' selected' : ''}`,
      style: { paddingLeft: 8 + depth * 14 },
      title: isDir ? full : `${full} · 双击锁定标签`,
      'aria-expanded': isDir ? open : undefined,
      onClick: () => isDir ? onToggle(full) : onOpen(full, false),
      onDoubleClick: () => { if (!isDir) onPin(full) },
      onContextMenu: event => onMenu?.(event, full),
    },
    isDir ? h(Twist, { open }) : h(TwistSpacer),
    h('span', { className: `world-vscode-file-icon ${isDir ? 'is-dir' : entryIconClass(entry.name)}` },
      isDir ? h(FolderIcon, { open }) : h(FileIcon)),
    h('span', { className: 'world-vscode-file-name' }, entry.name)),
    isDir && open && children.map(child => h(TreeNode, {
      key: child.name, parent: full, entry: child, depth: depth + 1,
      expanded, tree, selected, onToggle, onOpen, onPin, onMenu,
    })),
    isDir && open && children.length === 0
      ? h('div', { className: 'world-vscode-tree-note', style: { paddingLeft: 26 + depth * 14 } }, '空目录')
      : null)
}

export function VscodeWindow({
  session, remote, rpc, rect, rootPath: rootProp, windowKey, zIndex = 5, isActive = true,
  state = 'normal', onClose, onMinimize, onToggleMaximize, collection = null, openRequest = null,
  onDirtyChange, onRootChange, onOpenInNewWindow, onFocusFolder, onDesktopRegister,
  onDragStart, onDragMove, onDragEnd, onResizeStart, onActivate, getDirectoryPicker,
}) {
  const minimized = state === 'min'
  const maximized = state === 'max'
  const collectionMode = Boolean(collection)
  const collectionKey = collectionMode ? `collection:${collection.id}` : ''
  const collectionEntries = collectionMode
    ? (collection.entries || []).map(item => ({ name: item.name, type: item.type === 'directory' ? 'directory' : 'file', path: normalizePath(item.path) }))
    : []
  const collectionSignature = collectionMode ? JSON.stringify(collectionEntries.map(item => [item.name, item.path, item.type])) : ''
  const [stored] = React.useState(readSidebar)
  const [tree, setTree] = React.useState(() => new Map())
  const [expanded, setExpanded] = React.useState(() => new Set(session?.cwd ? [session.cwd] : []))
  const [busyDir, setBusyDir] = React.useState('')
  const [busyFile, setBusyFile] = React.useState('')
  const [tabs, setTabs] = React.useState([])
  const [activeId, setActiveId] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [scrollTop, setScrollTop] = React.useState(0)
  const [scrollLeft, setScrollLeft] = React.useState(0)
  const [caretLine, setCaretLine] = React.useState(0)
  const [caretColumn, setCaretColumn] = React.useState(0)
  const [editing, setEditing] = React.useState(false)
  const [viewportHeight, setViewportHeight] = React.useState(400)
  const [sideView, setSideView] = React.useState(() => SIDE_VIEWS.includes(stored.view) ? stored.view : 'files')
  const [sidebarOpen, setSidebarOpen] = React.useState(() => stored.open !== false)
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    const width = Number(stored.width)
    return Number.isFinite(width) && width >= SIDEBAR_MIN && width <= SIDEBAR_MAX ? Math.round(width) : SIDEBAR_DEFAULT
  })
  const [searchText, setSearchText] = React.useState('')
  const [searchFlags, setSearchFlags] = React.useState({ caseSensitive: false, regex: false })
  const [searchResult, setSearchResult] = React.useState(null)
  const [searchBusy, setSearchBusy] = React.useState(false)
  const [searchError, setSearchError] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(() => new Set())
  const [reveal, setReveal] = React.useState(null)
  const [git, setGit] = React.useState(null)
  const [gitOp, setGitOp] = React.useState('')
  const [gitMsg, setGitMsg] = React.useState(null)
  const [commitText, setCommitText] = React.useState('')
  const [picker, setPicker] = React.useState(null)
  const [pickerDraft, setPickerDraft] = React.useState('')
  const [fileMenu, setFileMenu] = React.useState(null)
  const fileMenuRef = React.useRef(null)
  const mounted = React.useRef(true)
  const shellRef = React.useRef(null)
  const textareaRef = React.useRef(null)
  const searchInputRef = React.useRef(null)
  /** 最后一次按下鼠标落在哪个窗口：多开时每个窗口都监听 window，靠它认领自己的键。 */
  const pointerOwnerRef = React.useRef(null)
  const activeRef = React.useRef(isActive)
  activeRef.current = isActive
  const collectionRef = React.useRef(collectionMode)
  collectionRef.current = collectionMode
  // 快捷键监听只挂一次，读不到最新的 minimized，所以用 ref 兜住
  const minimizedRef = React.useRef(minimized)
  minimizedRef.current = minimized
  const scrollTopRef = React.useRef(0)
  const scrollFrame = React.useRef(0)
  const controllers = React.useRef(new Set())
  const pending = React.useRef(new Map())
  const nextTabId = React.useRef(0)
  const activeTabRef = React.useRef(null)
  const tabsRef = React.useRef(tabs)
  const activeIdRef = React.useRef(activeId)
  const treeRef = React.useRef(tree)
  const gitRef = React.useRef(git)
  const gitOpRef = React.useRef(gitOp)
  const sideViewRef = React.useRef(sideView)
  const sidebarOpenRef = React.useRef(sidebarOpen)
  const sidebarWidthRef = React.useRef(sidebarWidth)
  const resizeRef = React.useRef(null)
  const searchSeq = React.useRef(0)
  const searchAbort = React.useRef(null)
  const revealSeq = React.useRef(0)
  const revealedSeq = React.useRef(0)
  const pickerAbort = React.useRef(null)
  /** 对话框开着时键盘归它：Escape 关闭、Tab 不跑出卡片、其它快捷键让路。 */
  const pickerOpenRef = React.useRef(false)
  const pickerCardRef = React.useRef(null)
  const desktopHandle = React.useRef(null)
  pickerOpenRef.current = Boolean(picker)
  tabsRef.current = tabs
  activeIdRef.current = activeId
  treeRef.current = tree
  gitRef.current = git
  gitOpRef.current = gitOp
  sideViewRef.current = sideView
  sidebarOpenRef.current = sidebarOpen
  sidebarWidthRef.current = sidebarWidth
  const rootPath = collectionMode ? '' : normalizePath(rootProp || session?.cwd || '')
  const displayName = collectionMode ? collection.name : baseName(rootPath)
  const treeRoot = collectionMode ? collectionKey : rootPath
  const collectionRootFor = filePath => {
    if (!collectionMode) return rootPath
    const target = normalizePath(filePath)
    const match = collectionEntries.find(item => target === item.path || target.startsWith(`${item.path}/`))
    if (!match) return rootPath
    if (match.type === 'directory') return match.path
    const index = match.path.lastIndexOf('/')
    if (index < 0) return match.path
    const dir = match.path.slice(0, index)
    return /^[a-zA-Z]:$/u.test(dir) ? `${dir}/` : dir
  }
  const active = tabs.find(tab => tab.id === activeId) || null
  const dirty = tabs.some(isDirty)
  const activeDirty = isDirty(active)
  const language = languageOf(active?.path)
  const extension = active?.path.includes('.') ? active.path.split('.').at(-1).toUpperCase() : 'TEXT'

  React.useEffect(() => {
    mounted.current = true
    const alive = controllers.current
    return () => {
      mounted.current = false
      window.clearTimeout(noticeTimer.current)
      for (const controller of alive) controller.abort()
      alive.clear()
    }
  }, [])

  React.useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  React.useLayoutEffect(() => {
    const node = textareaRef.current
    if (!node) return
    const update = () => setViewportHeight(node.clientHeight || 400)
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update)
      observer.observe(node)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [active?.id, Boolean(active?.document)])

  React.useEffect(() => {
    scrollTopRef.current = 0
    setScrollTop(0)
    setScrollLeft(0)
    setCaretLine(0)
    setCaretColumn(0)
    if (textareaRef.current) {
      textareaRef.current.scrollTop = 0
      textareaRef.current.scrollLeft = 0
    }
  }, [active?.id, active?.path])

  /** 记住最后一次按下鼠标落在哪个窗口：快捷键只在自己身上生效，不抢宿主和别的窗口的键。 */
  React.useEffect(() => {
    const onPointerDown = event => {
      const owner = event.target?.closest?.('.world-vscode-window')
      pointerOwnerRef.current = owner?.dataset.worldVscodeKey || ''
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  React.useEffect(() => () => {
    if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current)
  }, [])

  React.useEffect(() => {
    const node = activeTabRef.current
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const onEditorScroll = event => {
    const node = event.currentTarget
    scrollTopRef.current = node.scrollTop
    if (scrollFrame.current) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0
      setScrollTop(scrollTopRef.current)
      setScrollLeft(textareaRef.current?.scrollLeft ?? 0)
    })
  }

  /** 只数光标前的换行符，不切分整段文本：5 万行的文件里每次点一下也不会卡。 */
  const syncCaret = node => {
    if (!node) return
    const value = node.value
    let line = 0
    let lineStart = 0
    const end = node.selectionStart
    for (let index = 0; index < end; index++) {
      if (value.charCodeAt(index) === 10) { line++; lineStart = index + 1 }
    }
    setCaretLine(current => current === line ? current : line)
    const column = end - lineStart
    setCaretColumn(current => current === column ? current : column)
  }

  /** 目录列表与「打开文件夹」对话框共用宿主的一个入口，工作区外的文件夹也能读。 */
  const loadDir = (dirPath, rootOverride) => {
    const controller = new AbortController()
    controllers.current.add(controller)
    setBusyDir(dirPath)
    setError('')
    const root = rootOverride || (collectionMode ? collectionRootFor(dirPath) : rootPath)
    return Promise.resolve(rpc.call('/api', 'world-vscode-source/list', {
      sessionId: session.id, path: dirPath, root,
    }, controller.signal)).then(unwrap).then(value => {
      if (!mounted.current || controller.signal.aborted) return EMPTY_FILES
      const list = Array.isArray(value?.entries)
        ? value.entries.filter(item => item && typeof item.name === 'string') : EMPTY_FILES
      setTree(current => new Map(current).set(dirPath, list))
      if (value?.truncated) setNotice('目录条目过多，列表已截断。')
      return list
    }).catch(cause => {
      if (mounted.current && !controller.signal.aborted) {
        setTree(current => new Map(current).set(dirPath, EMPTY_FILES))
        setError(String(cause?.message || cause))
      }
      return EMPTY_FILES
    }).finally(() => {
      controllers.current.delete(controller)
      if (mounted.current) setBusyDir(current => current === dirPath ? '' : current)
    })
  }

  React.useEffect(() => {
    if (collectionMode) {
      setTree(new Map([[treeRoot, collectionEntries]]))
      setExpanded(new Set([treeRoot]))
      setSideView('files')
      setError('')
      return
    }
    if (!session?.id || !rootPath) {
      setTree(new Map())
      setExpanded(new Set())
      setError(rootPath ? '' : '还没有打开文件夹。')
      return
    }
    setTree(new Map())
    setExpanded(new Set([rootPath]))
    setError('')
    void loadDir(rootPath)
  }, [session?.id, rootPath, collectionMode, treeRoot, collectionSignature])

  const toggleDir = dirPath => {
    if (expanded.has(dirPath)) {
      setExpanded(current => { const next = new Set(current); next.delete(dirPath); return next })
      return
    }
    setExpanded(current => new Set(current).add(dirPath))
    if (!tree.has(dirPath)) void loadDir(dirPath)
  }

  /** 重新读取当前展开的目录，保住展开状态。 */
  const refreshTree = async () => {
    const open = [...expanded].filter(dir => dir !== collectionKey)
    setTree(current => collectionMode ? new Map(current) : new Map())
    await Promise.all(open.map(dir => loadDir(dir)))
  }

  const loadFile = (id, path, preserveDraft = false, signal, rootOverride) => {
    if (signal?.aborted) return Promise.resolve({ error: signal.reason })
    for (const [key, entry] of pending.current) {
      if (entry.id === id) { entry.controller.abort(); pending.current.delete(key) }
    }
    const controller = new AbortController()
    controllers.current.add(controller)
    pending.current.set(path, { id, controller })
    const cancel = () => {
      controller.abort(signal.reason)
      if (pending.current.get(path)?.controller === controller) pending.current.delete(path)
      if (mounted.current) {
        setTabs(list => list.filter(tab => tab.id !== id || tab.document))
        setBusyFile(current => current === path ? '' : current)
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    setBusyFile(path)
    setError('')
    const root = rootOverride || (collectionMode ? collectionRootFor(path) : rootPath)
    const task = Promise.resolve(rpc.call('/api', 'world-vscode-source/open', { sessionId: session.id, root, path }, controller.signal))
      .then(unwrap)
      .then(value => {
        if (!mounted.current || controller.signal.aborted) return
        if (preserveDraft && isDirty(tabsRef.current.find(tab => tab.id === id)))
          throw desktopError('读取期间文件产生了未保存修改，已保留草稿。', 'WORLD_DESKTOP_DIRTY')
        setTabs(list => list.map(tab => tab.id === id && tab.path === path
          ? { ...tab, document: value, draft: value.source,
            reload: preserveDraft && value.source !== tab.draft ? (tab.reload || 0) + 1 : tab.reload } : tab))
        setNotice('')
      })
      .catch(cause => {
        if (mounted.current && !controller.signal.aborted) {
          setError(String(cause?.message || cause))
          setTabs(list => list.filter(tab => tab.id !== id || tab.document))
        }
        return { error: cause }
      })
      .finally(() => {
        signal?.removeEventListener('abort', cancel)
        controllers.current.delete(controller)
        if (pending.current.get(path)?.controller === controller) pending.current.delete(path)
        if (mounted.current) setBusyFile(current => current === path ? '' : current)
      })
    pending.current.get(path).task = task
    return task
  }

  /** Single click reuses one preview tab; double click pins it so the next click opens another tab. */
  const openFile = (filePath, pin = false, signal, rootOverride) => {
    const list = tabsRef.current
    const existing = list.find(tab => tab.path === filePath)
    const inFlight = pending.current.get(filePath)
    const root = rootOverride || (collectionMode ? collectionRootFor(filePath) : rootPath)
    if (existing || inFlight) {
      const id = existing?.id || inFlight.id
      if (pin) setTabs(current => current.map(tab => tab.id === id ? { ...tab, pinned: true } : tab))
      setActiveId(id)
      return { id, task: inFlight?.task || Promise.resolve() }
    }
    const preview = pin ? null : list.find(tab => !tab.pinned)
    if (preview) {
      if (isDirty(preview) && !window.confirm(`${baseName(preview.path)} 有未保存修改，放弃并打开 ${baseName(filePath)}？`)) return
      setTabs(current => current.map(tab => tab.id === preview.id
        ? { ...tab, path: filePath, root, document: null, draft: '' } : tab))
      setActiveId(preview.id)
      return { id: preview.id, task: loadFile(preview.id, filePath, false, signal, root) }
    }
    const id = `tab-${++nextTabId.current}`
    setTabs(current => [...current, { id, path: filePath, root, pinned: pin, document: null, draft: '' }])
    setActiveId(id)
    return { id, task: loadFile(id, filePath, false, signal, root) }
  }

  const pinTab = id => setTabs(list => list.map(tab => tab.id === id ? { ...tab, pinned: true } : tab))

  // 桌面文件链接：窗口打开后自动把这个文件放进标签（同一窗口再次打开走 nonce 递增）。
  React.useEffect(() => {
    if (!openRequest?.path || !session?.id) return
    const path = normalizePath(openRequest.path)
    openFile(path, true, undefined, collectionMode ? collectionRootFor(path) : rootPath)
  }, [openRequest?.nonce])

  const closeTab = id => {
    const list = tabsRef.current
    const tab = list.find(item => item.id === id)
    if (isDirty(tab) && !window.confirm(`${baseName(tab.path)} 有未保存修改，仍要关闭标签吗？`)) return
    const index = list.findIndex(item => item.id === id)
    const remaining = list.filter(item => item.id !== id)
    setTabs(remaining)
    if (id === activeIdRef.current) setActiveId(remaining[Math.min(index, remaining.length - 1)]?.id || '')
    for (const [path, entry] of pending.current) {
      if (entry.id === id) { entry.controller.abort(); pending.current.delete(path) }
    }
  }

  /**
   * 状态栏那句提示只亮一下：以前「已保存」会一直挂在状态栏上，
   * 直到用户碰了别的文件才消失，看着像「还有没保存的东西」。
   */
  const noticeTimer = React.useRef(0)
  const flashNotice = text => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => { if (mounted.current) setNotice('') }, 1800)
  }

  const saveFile = async () => {
    const tab = tabsRef.current.find(item => item.id === activeIdRef.current)
    if (!isDirty(tab) || saving) return
    setSaving(true)
    setError('')
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-source/save', {
        sessionId: session.id, root: tab.root || rootPath, path: tab.path, version: tab.document.version, source: tab.draft,
      }))
      setTabs(list => list.map(item => item.id === tab.id ? { ...item, document: value, draft: value.source } : item))
      flashNotice('已保存')
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setSaving(false)
    }
  }

  /** 折叠时把焦点交还编辑器：侧栏里的输入框会被卸载，否则快捷键从此接不到事件。 */
  const toggleSidebar = () => {
    const next = !sidebarOpenRef.current
    setSidebarOpen(next)
    if (!next && window.document.activeElement?.closest?.('.world-vscode-sidebar')) {
      textareaRef.current?.focus({ preventScroll: true })
    }
  }
  const toggleSidebarRef = React.useRef(toggleSidebar)
  toggleSidebarRef.current = toggleSidebar

  const saveRef = React.useRef(saveFile)
  saveRef.current = saveFile

  /** 切换侧栏视图；需要时顺手把焦点送进搜索框。 */
  const showView = (view, focusSearch) => {
    setSideView(view)
    setSidebarOpen(true)
    if (!focusSearch) return
    window.requestAnimationFrame(() => {
      const node = searchInputRef.current
      if (!node) return
      node.focus()
      node.select()
    })
  }
  const showViewRef = React.useRef(showView)
  showViewRef.current = showView

  /** 目录选择器：进入子目录、回上一级，然后在当前窗口或新窗口打开。 */
  const browseTo = path => {
    if (!session?.id) {
      setPicker(current => current ? { ...current, busy: false, error: '还没有可用的会话。' } : current)
      return
    }
    pickerAbort.current?.abort()
    const controller = new AbortController()
    pickerAbort.current = controller
    setPicker(current => current ? { ...current, path, busy: true, error: '' } : current)
    setPickerDraft(path)
    return Promise.resolve(rpc.call('/api', 'world-vscode-source/list', {
      sessionId: session.id, path, root: rootPath,
    }, controller.signal)).then(unwrap).then(value => {
      if (!mounted.current || controller.signal.aborted) return
      const nextPath = normalizePath(value.path)
      setPicker(current => current ? {
        ...current,
        path: nextPath,
        parent: normalizePath(value.parent),
        folders: (value.entries || []).filter(item => item.type === 'directory'),
        busy: false, error: '', truncated: Boolean(value.truncated),
      } : current)
      setPickerDraft(nextPath)
    }).catch(cause => {
      if (!mounted.current || controller.signal.aborted) return
      setPicker(current => current ? { ...current, busy: false, error: String(cause?.message || cause) } : current)
    })
  }

  /** 系统「选择文件夹」对话框：桌面宿主提供原生 picker，网页端没有就如实报错。 */
  const browseNative = async () => {
    const pickerApi = getDirectoryPicker?.()
    if (typeof pickerApi?.pick !== 'function') {
      setPicker(current => current ? { ...current, error: '当前环境没有系统文件夹选择器。' } : current)
      return
    }
    try {
      const result = await pickerApi.pick()
      if (result?.ok === false) throw new Error(result.error?.message || '选择文件夹失败。')
      const picked = result?.ok === true ? result.value : result
      if (typeof picked === 'string' && picked) await browseTo(normalizePath(picked))
    } catch (cause) {
      if (mounted.current) setPicker(current => current ? { ...current, error: String(cause?.message || cause) } : current)
    }
  }

  /** 文件树右键菜单：定位到系统资源管理器 / 复制两种路径。 */
  const openFileMenu = (event, path) => {
    event.preventDefault()
    event.stopPropagation()
    const width = 200, height = 164
    setFileMenu({
      path,
      x: Math.min(Math.max(8, event.clientX), Math.max(8, (window.innerWidth || 0) - width)),
      y: Math.min(Math.max(8, event.clientY), Math.max(8, (window.innerHeight || 0) - height)),
    })
  }

  React.useEffect(() => {
    if (!fileMenu) return undefined
    const close = event => {
      if (fileMenuRef.current?.contains(event.target)) return
      setFileMenu(null)
    }
    const key = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setFileMenu(null)
    }
    const blur = () => setFileMenu(null)
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', blur)
    }
  }, [fileMenu])

  React.useEffect(() => {
    if (minimized) setFileMenu(null)
  }, [minimized])

  const relativeToRoot = path => rootPath && path.startsWith(`${rootPath}/`)
    ? path.slice(rootPath.length + 1)
    : path === rootPath ? '.' : path

  const revealInExplorer = async path => {
    setFileMenu(null)
    if (!session?.id) { setError('先打开一个会话再显示文件。'); return }
    setError('')
    try {
      await unwrap(await rpc.call('/api', 'world-vscode-source/reveal', {
        sessionId: session.id, root: collectionMode ? collectionRootFor(path) : rootPath, path,
      }))
      flashNotice('已在资源管理器中显示')
    } catch (cause) {
      setError(String(cause?.message || cause))
    }
  }

  const copyFilePath = async (path, relative) => {
    setFileMenu(null)
    const copied = await writeClipboard(relative && !collectionMode ? relativeToRoot(path) : nativePath(path))
    if (copied) flashNotice(relative && !collectionMode ? '已复制相对路径' : '已复制绝对路径')
    else setError('复制失败：当前环境不允许访问剪贴板。')
  }

  const openPicker = () => {
    const start = rootPath || normalizePath(session?.cwd || '')
    setPicker({ path: start, parent: '', folders: [], busy: true, error: '', truncated: false })
    setPickerDraft(start)
    void browseTo(start)
  }
  const openPickerRef = React.useRef(openPicker)
  openPickerRef.current = openPicker

  const closePicker = () => {
    pickerAbort.current?.abort()
    pickerAbort.current = null
    setPicker(null)
  }

  /** 换文件夹会关掉现有标签：未保存的修改必须先问过。 */
  const applyFolder = destination => {
    const next = normalizePath(picker?.path || '')
    if (!next) return
    if (next === rootPath) { closePicker(); return }
    // 这个文件夹已经在别的窗口打开：只把它拿到前台，当前窗口原样保留
    if (onFocusFolder?.(next)) { closePicker(); return }
    if (destination === 'new') {
      closePicker()
      onOpenInNewWindow?.(next)
      return
    }
    if (dirty && !window.confirm('当前窗口还有未保存的修改，切换文件夹会关闭这些标签。继续吗？')) return
    closePicker()
    setTabs([])
    setActiveId('')
    setReveal(null)
    setSearchText('')
    setSearchResult(null)
    setSearchError('')
    setSearchBusy(false)
    setSearchOpen(new Set())
    setGit(null)
    setGitMsg(null)
    setCommitText('')
    setNotice('')
    onRootChange?.(next)
  }

  /**
   * 这个按键算不算本窗口的？
   * 多开时每个窗口都在 window 上挂着监听，只按「焦点在某个编辑器窗口里」判断，
   * Ctrl+S 会被所有窗口一起吃掉（一起保存、一起折叠侧栏）。所以要先认出归属：
   * 焦点 / 事件所在的那个窗口 → 必须是自己；焦点不在任何窗口时，退到鼠标最后落点；
   * 还没点过任何地方（刚打开窗口）才跟着活动窗口走。
   */
  const ownsKey = event => {
    // 最小化的窗口不该再吃按键：它看不见，Ctrl+S 存的是用户不知道的那个窗口
    if (minimizedRef.current) return false
    const owner = event.target?.closest?.('.world-vscode-window')
      || window.document.activeElement?.closest?.('.world-vscode-window')
    if (owner) return owner.dataset.worldVscodeKey === windowKey
    const last = pointerOwnerRef.current
    if (last === null) return activeRef.current
    return last === windowKey
  }

  /**
   * 点窗口任意位置就激活它，并把键盘焦点接过来。
   * 标题栏和空白处本身不可聚焦，只激活不接焦点的话，DOM 焦点还留在上一个窗口里，
   * 后续 Ctrl+S / Ctrl+B 会发给那个窗口——多开时这就是「按键跑到另一个窗口」。
   */
  const activate = event => {
    onActivate?.(event)
    if (event.target?.closest?.('input, textarea, [contenteditable]')) return
    const shell = shellRef.current
    if (!shell || shell.contains(window.document.activeElement)) return
    const target = textareaRef.current || shell
    target.focus({ preventScroll: true })
  }

  /** 最小化时把「打开文件夹」收起来：否则它跟着窗口一起消失，键盘却还被它的模态接管着。 */
  React.useEffect(() => {
    if (minimized) closePicker()
    // closePicker 每次渲染都是新函数，但这里只关心「是不是刚被最小化」
  }, [minimized]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 从任务栏还原后把键盘交回窗口：不然还得先点一下窗口，Ctrl+S 才算数。 */
  const wasMinimized = React.useRef(minimized)
  React.useEffect(() => {
    const cameBack = wasMinimized.current && !minimized
    wasMinimized.current = minimized
    if (!cameBack) return
    const shell = shellRef.current
    if (!shell || shell.contains(window.document.activeElement)) return
    ;(textareaRef.current || shell).focus({ preventScroll: true })
  }, [minimized])

  /** 对话框是模态的：Tab 在卡片里循环、Escape 关闭，其余快捷键一律让路。 */
  React.useEffect(() => {
    if (!picker) return undefined
    const onKeyDown = event => {
      const card = pickerCardRef.current
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePicker()
        return
      }
      if (event.key !== 'Tab' || !card) return
      const focusables = [...card.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
        .filter(node => node.offsetParent !== null)
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables.at(-1)
      const current = window.document.activeElement
      if (!card.contains(current)) { event.preventDefault(); first.focus(); return }
      if (event.shiftKey && current === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [picker])

  React.useEffect(() => {
    const onKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      // 对话框开着时不接管编辑器快捷键，免得在「打开文件夹」里按 Ctrl+S 悄悄存了盘
      if (pickerOpenRef.current) return
      if (!ownsKey(event)) return
      const key = event.key.toLowerCase()
      if (event.shiftKey) {
        if (key === 'e') { event.preventDefault(); showViewRef.current('files') }
        else if (key === 'f' && !collectionRef.current) { event.preventDefault(); showViewRef.current('search', true) }
        else if (key === 'g' && !collectionRef.current) { event.preventDefault(); showViewRef.current('git') }
        else if (key === 'o' && !collectionRef.current) { event.preventDefault(); openPickerRef.current() }
        return
      }
      if (key === 's' && activeIdRef.current) {
        event.preventDefault()
        void saveRef.current()
      } else if (key === 'b') {
        // 与 VSCode 一致：Ctrl+B 收起 / 展开侧栏
        event.preventDefault()
        toggleSidebarRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const callGit = (operation, payload = {}, signal) => Promise
    .resolve(rpc.call('/api', `world-vscode-git/${operation}`, { sessionId: session.id, root: rootPath, ...payload }, signal))
    .then(unwrap)

  /** 打开窗口时静默拉一次状态，拿到徽标数；面板里的刷新才会显示错误。 */
  const refreshGit = async ({ silent = false } = {}) => {
    if (!session?.id) return
    const idle = !gitOpRef.current
    if (idle) setGitOp('status')
    try {
      const value = await callGit('status')
      if (!mounted.current) return
      setGit(value)
    } catch (cause) {
      if (mounted.current && !silent) setGitMsg({ kind: 'error', text: String(cause?.message || cause) })
    } finally {
      if (mounted.current && idle) setGitOp('')
    }
  }
  const refreshGitRef = React.useRef(refreshGit)
  refreshGitRef.current = refreshGit

  React.useEffect(() => {
    if (!session?.id || collectionMode) { setGit(null); return }
    void refreshGitRef.current({ silent: true })
  }, [session?.id, rootPath, collectionMode])

  const runGit = async (operation, payload, done) => {
    if (gitOpRef.current) return
    setGitOp(operation)
    setGitMsg(null)
    try {
      const value = await callGit(operation, payload)
      if (!mounted.current) return
      if (value?.status) setGit(value.status)
      if (operation === 'commit') setCommitText('')
      setGitMsg({ kind: 'ok', text: value?.output || done })
    } catch (cause) {
      if (!mounted.current) return
      setGitMsg({ kind: 'error', text: String(cause?.message || cause) })
      // 失败后状态可能已经变了（比如 pull 留下冲突），重新读一次真实状态。
      window.setTimeout(() => { void refreshGitRef.current({ silent: true }) }, 0)
    } finally {
      if (mounted.current) setGitOp('')
    }
  }

  /**
   * 展开文件所在的所有上级目录，让树里能看见它。
   * Git 面板与搜索给的是工作区相对路径，文件树用的是以 cwd 开头的绝对路径，
   * 这里统一按 rootPath 归一，避免同一个文件被打开成两个标签。
   */
  const revealDir = async filePath => {
    const relative = filePath.startsWith(`${rootPath}/`) ? filePath.slice(rootPath.length + 1) : filePath
    const segments = relative.split('/')
    let prefix = rootPath
    for (let index = 0; index < segments.length - 1; index++) {
      prefix = joinPath(prefix, segments[index])
      if (!treeRef.current.has(prefix)) await loadDir(prefix)
      if (!mounted.current) return
      setExpanded(current => current.has(prefix) ? current : new Set(current).add(prefix))
    }
  }

  /** 工作区相对路径 → 文件树里使用的绝对路径。 */
  const absolutePath = relative => joinPath(rootPath, relative)

  const openGitFile = file => {
    if (file.index === 'D' || file.worktree === 'D') {
      // 已删除的文件在磁盘上不存在，别让编辑器去撞「不是普通文件」
      setGitMsg({ kind: 'ok', text: `${file.path} 已删除，没有可编辑的内容。` })
      return
    }
    if (!file.open) {
      setGitMsg({ kind: 'error', text: `${file.path} 在当前文件夹之外，无法在编辑器中打开。` })
      return
    }
    const target = absolutePath(file.open)
    openFile(target, true)
    void revealDir(target)
  }

  /**
   * 侧栏搜索：输入停顿后才发请求，每次新输入都取消上一次，结果永远不会乱序覆盖。
   * 空关键词不发请求，只把面板清干净。
   */
  const performSearch = (text, flags) => {
    const query = text.trim()
    searchAbort.current?.abort()
    if (!query || !session?.id) {
      searchSeq.current++
      setSearchResult(null)
      setSearchError('')
      setSearchBusy(false)
      return
    }
    const controller = new AbortController()
    searchAbort.current = controller
    const seq = ++searchSeq.current
    setSearchBusy(true)
    setSearchError('')
    Promise.resolve(rpc.call('/api', 'world-vscode-search/find', {
      sessionId: session.id, root: rootPath, query, regex: flags.regex, caseSensitive: flags.caseSensitive,
    }, controller.signal)).then(unwrap).then(value => {
      if (!mounted.current || seq !== searchSeq.current) return
      setSearchResult(value)
      setSearchOpen(new Set((value?.files || []).slice(0, 6).map(file => file.path)))
    }).catch(cause => {
      if (!mounted.current || seq !== searchSeq.current || controller.signal.aborted) return
      setSearchResult(null)
      setSearchError(String(cause?.message || cause))
    }).finally(() => {
      if (mounted.current && seq === searchSeq.current) setSearchBusy(false)
    })
  }
  const searchRef = React.useRef(performSearch)
  searchRef.current = performSearch

  React.useEffect(() => {
    if (sideViewRef.current !== 'search' || !session?.id) return undefined
    const timer = window.setTimeout(() => searchRef.current(searchText, searchFlags), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [searchText, searchFlags, session?.id])

  React.useEffect(() => () => { searchAbort.current?.abort() }, [])

  React.useEffect(() => { saveSidebar({ open: sidebarOpen }) }, [sidebarOpen])
  React.useEffect(() => { saveSidebar({ view: sideView }) }, [sideView])

  /** 点击搜索结果：确保文件已打开，然后把光标落到那一行。 */
  const revealHit = (filePath, match) => {
    const target = absolutePath(filePath)
    const existing = tabsRef.current.find(tab => tab.path === target)
    if (existing) setActiveId(existing.id)
    else openFile(target, true)
    setReveal({ path: target, line: match.line, column: match.column, nonce: ++revealSeq.current })
  }

  React.useEffect(() => {
    if (!reveal || !active?.document || active.path !== reveal.path) return
    if (revealedSeq.current === reveal.nonce) return
    const node = textareaRef.current
    if (!node) return
    revealedSeq.current = reveal.nonce
    const value = node.value
    let lineStart = 0
    let actualLine = 1
    for (let line = 1; line < reveal.line; line++) {
      const next = value.indexOf('\n', lineStart)
      if (next < 0) { lineStart = value.length; break }
      lineStart = next + 1
      actualLine++
    }
    const newline = value.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? value.length : newline
    const caret = lineStart + Math.min(Math.max(0, reveal.column), Math.max(0, lineEnd - lineStart))
    node.focus({ preventScroll: true })
    node.setSelectionRange(caret, caret)
    const top = Math.max(0, (actualLine - 1) * LINE_HEIGHT - (node.clientHeight - LINE_HEIGHT) / 2)
    node.scrollTop = top
    scrollTopRef.current = node.scrollTop
    setScrollTop(node.scrollTop)
    syncCaret(node)
  }, [reveal, active?.id, active?.document, active?.path])

  // Explicit app commands share the editor's normal loading and reveal paths; no draft text leaves the window.
  desktopHandle.current = {
    focus() {
      const shell = shellRef.current
      if (!shell || minimizedRef.current) return false
      const current = window.document.activeElement
      if (pickerOpenRef.current) {
        const card = pickerCardRef.current
        if (!card) return false
        if (!card.contains(current)) card.querySelector('input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true })
        if (!card.contains(window.document.activeElement)) return false
      } else if (!shell.contains(current)) {
        const target = textareaRef.current || shell
        target.focus({ preventScroll: true })
      }
      // Programmatic activation has no pointer event to update shortcut ownership.
      pointerOwnerRef.current = windowKey
      return shell.contains(window.document.activeElement)
    },
    getState: () => ({
      sessionId: session?.id || '', rootPath, activePath: active?.path || '', dirty,
      loading: Boolean(busyFile), saving,
      caret: active?.document ? { line: caretLine + 1, column: caretColumn + 1 } : null,
      files: tabs.map(tab => ({ path: tab.path, dirty: isDirty(tab), pinned: tab.pinned,
        active: tab.id === activeId, loading: !tab.document })),
    }),
    async openFile(command, signal) {
      signal?.throwIfAborted()
      if (pickerOpenRef.current) throw desktopError('编辑器正在选择文件夹，请先完成或关闭对话框。', 'WORLD_DESKTOP_BUSY')
      const path = normalizePath(command.path)
      const existing = tabsRef.current.find(tab => tab.path === path)
      if (command.refresh && isDirty(existing)) throw desktopError('文件有未保存修改，不能重新读取并覆盖草稿。', 'WORLD_DESKTOP_DIRTY')
      const opened = openFile(path, true, signal)
      if (!opened) throw desktopError('文件未打开。')
      let loaded = await opened.task
      signal?.throwIfAborted()
      if (loaded?.error) throw loaded.error
      if (command.refresh && existing?.document) {
        loaded = await loadFile(opened.id, path, true, signal)
        if (loaded?.error) throw loaded.error
      }
      await waitForDesktop(() => tabsRef.current.find(tab => tab.id === opened.id && tab.document), signal)
      const nonce = ++revealSeq.current
      setReveal({ path, line: command.line, column: command.column - 1, nonce })
      await waitForDesktop(() => revealedSeq.current === nonce && desktopHandle.current.getState().activePath === path, signal)
      return { path, refreshed: command.refresh === true }
    },
  }
  React.useEffect(() => onDesktopRegister?.(windowKey, {
    focus: () => desktopHandle.current.focus(),
    getState: () => desktopHandle.current.getState(),
    openFile: (command, signal) => desktopHandle.current.openFile(command, signal),
  }), [windowKey, onDesktopRegister])

  const rootEntries = tree.get(treeRoot) || EMPTY_FILES
  const lineCount = React.useMemo(() => countLines(active?.draft || ''), [active?.draft])
  // 行号槽宽度跟着位数走：5 位行号还能塞进 52px，6 位就会被裁掉
  const gutterWidth = Math.max(46, 20 + String(lineCount).length * 8)
  const firstLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN)
  const visibleCount = Math.max(0, Math.min(lineCount - firstLine, Math.ceil(viewportHeight / LINE_HEIGHT) + OVERSCAN * 2))
  const gutterRows = []
  for (let index = 0; index < visibleCount; index++) gutterRows.push(firstLine + index + 1)
  const gutterOffset = firstLine * LINE_HEIGHT - scrollTop

  // 高亮全文只算一次，按可见窗口取行；超大文件 highlight() 自己退回纯文本。
  const highlighted = React.useMemo(() => {
    if (!active?.document || !language) return null
    const result = highlight(active.draft || '', language)
    return result.plain ? null : result
  }, [active?.document, active?.draft, language])
  const highlightRows = highlighted
    ? Array.from({ length: visibleCount }, (_, offset) => {
      const index = firstLine + offset
      const tokens = highlighted.lines[index] ?? EMPTY_TOKENS
      return h('div', { key: index, className: 'world-vscode-hl-line' },
        tokens.map((token, order) => token.type === 'punc'
          ? token.text
          : h('span', { key: order, className: `world-vscode-tok-${token.type}` }, token.text)))
    })
    : null

  const changedFiles = git?.files || EMPTY_FILES
  const stagedFiles = changedFiles.filter(file => file.staged)
  const unstagedFiles = changedFiles.filter(file => file.unstaged || file.untracked)
  const canCommit = Boolean(git?.repo && stagedFiles.length && commitText.trim() && !gitOp)
  const canPull = Boolean(git?.repo && git.upstream && !gitOp)
  const canPush = Boolean(git?.repo && (git.upstream || git.remotes?.includes('origin')) && !gitOp)

  const activityButton = (id, icon, label, badge, hint) => h('button', {
    type: 'button',
    className: `world-vscode-activity-btn${sideView === id && sidebarOpen ? ' is-active' : ''}`,
    title: hint ? `${label} (${hint})` : label, 'aria-label': label, 'aria-pressed': sideView === id && sidebarOpen,
    onClick: () => {
      // 再点当前图标＝收起侧栏，和 VSCode 活动栏一致
      if (sideView === id) { toggleSidebar(); return }
      setSideView(id)
      setSidebarOpen(true)
    },
  },
  h('span', { className: 'world-vscode-activity-icon' }, icon),
  badge ? h('i', { className: 'world-vscode-activity-badge' }, badge > 99 ? '99+' : String(badge)) : null)

  const toggleSearchFile = path => setSearchOpen(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const searchAllOpen = Boolean(searchResult?.files.length)
    && searchResult.files.every(file => searchOpen.has(file.path))
  const toggleAllSearchFiles = () => {
    if (!searchResult?.files.length) return
    setSearchOpen(searchAllOpen ? new Set() : new Set(searchResult.files.map(file => file.path)))
  }

  /** 命中的字符区间画成 <mark>，其余原样输出。 */
  const markedText = match => {
    const parts = []
    let cursor = 0
    for (const [start, end] of match.ranges) {
      if (start > cursor) parts.push(match.text.slice(cursor, start))
      parts.push(h('mark', { key: `m${start}` }, match.text.slice(start, end)))
      cursor = end
    }
    if (cursor < match.text.length) parts.push(match.text.slice(cursor))
    return parts
  }

  const searchPanel = () => {
    const result = searchResult
    const query = searchText.trim()
    const summary = searchError ? ''
      : searchBusy ? '搜索中…'
        : !query ? `在 ${baseName(rootPath)} 中搜索`
          : result ? (result.total ? `${result.total} 个结果 · ${result.fileCount} 个文件` : '0 个结果')
            : ''
    return h('div', { className: 'world-vscode-search' },
      h('div', { className: 'world-vscode-search-box' },
        h('span', { className: 'world-vscode-search-glyph' }, h(SearchIcon, { size: 14 })),
        h('input', {
          ref: searchInputRef,
          className: 'world-vscode-search-input', value: searchText, spellCheck: false,
          placeholder: '搜索工作区', 'aria-label': '搜索工作区中的文本',
          onChange: event => setSearchText(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              performSearch(searchText, searchFlags)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setSearchText('')
            } else if (event.altKey && event.key.toLowerCase() === 'c') {
              event.preventDefault()
              setSearchFlags(flags => ({ ...flags, caseSensitive: !flags.caseSensitive }))
            } else if (event.altKey && event.key.toLowerCase() === 'r') {
              event.preventDefault()
              setSearchFlags(flags => ({ ...flags, regex: !flags.regex }))
            }
          },
        }),
        h('button', {
          type: 'button', className: `world-vscode-search-flag${searchFlags.caseSensitive ? ' is-on' : ''}`,
          title: '区分大小写 (Alt+C)', 'aria-label': '区分大小写', 'aria-pressed': searchFlags.caseSensitive,
          onClick: () => setSearchFlags(flags => ({ ...flags, caseSensitive: !flags.caseSensitive })),
        }, 'Aa'),
        h('button', {
          type: 'button', className: `world-vscode-search-flag${searchFlags.regex ? ' is-on' : ''}`,
          title: '使用正则表达式 (Alt+R)', 'aria-label': '使用正则表达式', 'aria-pressed': searchFlags.regex,
          onClick: () => setSearchFlags(flags => ({ ...flags, regex: !flags.regex })),
        }, '.*')),
      h('div', { className: 'world-vscode-search-summary', role: 'status' },
        searchBusy ? h('i', { className: 'world-vscode-search-spin' }) : null,
        h('span', null, summary),
        result?.truncated ? h('span', { className: 'world-vscode-search-note' }, '结果过多，已截断') : null),
      searchError ? h('div', { className: 'world-vscode-error' }, searchError) : null,
      h('div', { className: 'world-vscode-search-list' },
        !result
          ? !searchError && h('div', { className: 'world-vscode-search-hint' },
            h(SearchIcon, { size: 28 }),
            h('span', null, query ? '按 Enter 立即搜索' : '输入关键词，停顿后自动搜索工作区中的文件名与内容。'))
          : result.files.length === 0
            ? h('div', { className: 'world-vscode-search-empty' },
              h(SearchIcon, { size: 28 }),
              h('span', null, `没有与 “${query}” 匹配的内容。`),
              h('small', null, '试试更短的词，或关掉区分大小写。'))
            : result.files.map(file => {
              const open = searchOpen.has(file.path)
              return h('div', { key: file.path, className: 'world-vscode-search-file' },
                h('button', {
                  type: 'button', className: `world-vscode-search-file-head${open ? ' is-open' : ''}`,
                  title: file.path, 'aria-expanded': open,
                  onClick: () => toggleSearchFile(file.path),
                },
                h(Twist, { open }),
                h('span', { className: `world-vscode-file-icon ${entryIconClass(baseName(file.path))}` }, h(FileIcon)),
                h('span', { className: 'world-vscode-search-name' }, baseName(file.path)),
                dirName(file.path) ? h('span', { className: 'world-vscode-search-dir' }, dirName(file.path)) : null,
                h('i', { className: 'world-vscode-search-count' }, file.matches.length)),
                open ? file.matches.map(match => h('button', {
                  key: `${match.line}:${match.column}`, type: 'button', className: 'world-vscode-search-hit',
                  title: `${file.path}:${match.line}`, onClick: () => revealHit(file.path, match),
                },
                h('span', { className: 'world-vscode-search-line' }, match.line),
                h('span', { className: 'world-vscode-search-text' },
                  match.prefix ? '…' : null, markedText(match), match.suffix ? '…' : null))) : null)
            })))
  }

  /** 一条更改：单击在编辑器里打开，右侧按钮暂存 / 取消暂存（悬停才出现，避免和状态字母抢位置）。 */
  const gitRow = (file, staged) => {
    const letter = fileState(file, staged)
    return h('div', {
      key: `${staged ? 's' : 'w'}:${file.path}`,
      className: 'world-vscode-git-file', role: 'button', tabIndex: 0,
      title: file.from ? `${file.from} → ${file.path}` : file.path,
      onClick: () => openGitFile(file),
      onKeyDown: event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openGitFile(file)
      },
    },
    h('span', { className: `world-vscode-tab-icon ${entryIconClass(baseName(file.path))}` }, h(FileIcon)),
    h('span', { className: 'world-vscode-git-name' }, baseName(file.path)),
    dirName(file.path) ? h('span', { className: 'world-vscode-git-dir' }, dirName(file.path)) : null,
    h('span', { className: `world-vscode-git-state ${stateClass(letter)}` }, letter),
    h('button', {
      type: 'button', className: 'world-vscode-git-act',
      title: staged ? '取消暂存' : '暂存更改', 'aria-label': `${staged ? '取消暂存' : '暂存'} ${file.path}`,
      disabled: Boolean(gitOp),
      onClick: event => {
        event.stopPropagation()
        void runGit(staged ? 'unstage' : 'stage', { paths: [file.path] }, staged ? '已取消暂存' : '已暂存')
      },
    }, h(StageIcon, { undo: staged })))
  }

  const gitGroup = (title, list, staged) => h('div', { className: 'world-vscode-git-group' },
    h('div', { className: 'world-vscode-git-group-head' },
      h('span', { className: 'world-vscode-git-group-title' }, title),
      h('i', { className: 'world-vscode-git-count' }, list.length),
      h('button', {
        type: 'button', className: 'world-vscode-git-group-act',
        title: staged ? '全部取消暂存' : '全部暂存', 'aria-label': staged ? '全部取消暂存' : '全部暂存',
        disabled: Boolean(gitOp),
        onClick: () => void runGit(staged ? 'unstage' : 'stage', { paths: list.map(file => file.path) },
          staged ? '已取消暂存' : '已暂存'),
      }, h(StageIcon, { undo: staged }))),
    list.map(file => gitRow(file, staged)))

  const gitPanel = () => h('div', { className: 'world-vscode-git' },
    h('div', { className: 'world-vscode-git-branch' },
      h('span', { className: 'world-vscode-git-branch-icon' }, h(BranchIcon)),
      h('span', { className: 'world-vscode-git-branch-name', title: git?.root || '' },
        !git ? '读取中…' : git.repo ? (git.branch || 'HEAD') : '未检测到仓库'),
      git?.ahead ? h('span', { className: 'world-vscode-git-track is-ahead', title: `领先上游 ${git.ahead} 个提交` }, `↑${git.ahead}`) : null,
      git?.behind ? h('span', { className: 'world-vscode-git-track is-behind', title: `落后上游 ${git.behind} 个提交` }, `↓${git.behind}`) : null,
      h('button', {
        type: 'button', className: 'world-vscode-git-refresh', title: '刷新 Git 状态',
        'aria-label': '刷新 Git 状态', disabled: Boolean(gitOp), onClick: () => void refreshGit(),
      }, h(RefreshIcon, { spinning: gitOp === 'status' }))),
    git?.repo ? h(React.Fragment, null,
      h('div', { className: 'world-vscode-git-compose' },
        h('textarea', {
          className: 'world-vscode-git-message', rows: 2, spellCheck: false,
          placeholder: '提交信息（Ctrl+Enter 提交）', value: commitText, 'aria-label': '提交信息',
          onChange: event => setCommitText(event.target.value),
          onKeyDown: event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              if (canCommit) void runGit('commit', { message: commitText }, '已提交')
            }
          },
        }),
        h('button', {
          type: 'button', className: 'world-vscode-git-primary', disabled: !canCommit,
          title: stagedFiles.length ? '提交已暂存的更改 (Ctrl+Enter)' : '先暂存要提交的文件',
          onClick: () => void runGit('commit', { message: commitText }, '已提交'),
        }, h(CheckIcon), h('span', null, gitOp === 'commit' ? '提交中…' : '提交'))),
      h('div', { className: 'world-vscode-git-actions' },
        h('button', {
          type: 'button', disabled: !canPull,
          title: git.upstream ? `从 ${git.upstream} 拉取` : '当前分支没有上游分支',
          onClick: () => void runGit('pull', {}, '已拉取'),
        }, h(TransferIcon, { up: false }), h('span', null, gitOp === 'pull' ? '拉取中…' : '拉取')),
        h('button', {
          type: 'button', disabled: !canPush,
          title: git.upstream ? `推送到 ${git.upstream}` : '推送到 origin',
          onClick: () => void runGit('push', {}, '已推送'),
        }, h(TransferIcon, { up: true }), h('span', null, gitOp === 'push' ? '推送中…' : '推送'))))
      : null,
    gitMsg ? h('div', {
      className: `world-vscode-git-msg${gitMsg.kind === 'error' ? ' is-error' : ''}`, title: gitMsg.text,
      role: gitMsg.kind === 'error' ? 'alert' : 'status',
    }, gitMsg.text) : null,
    git?.repo && !git.identity?.ok && stagedFiles.length
      ? h('div', { className: 'world-vscode-git-note' }, '未配置 Git 身份，提交前请先设置 user.name 与 user.email。')
      : null,
    h('div', { className: 'world-vscode-git-list' },
      !git ? h('div', { className: 'world-vscode-git-empty' }, '正在读取 Git 状态…')
        : !git.repo ? h('div', { className: 'world-vscode-git-empty' },
          h('span', null, '这个文件夹不在 Git 仓库中。'),
          h('small', null, '在终端里 git init，或换一个有仓库的工作目录。'))
          : changedFiles.length === 0 ? h('div', { className: 'world-vscode-git-empty is-clean' }, h(CheckIcon), '工作区没有更改')
            : h(React.Fragment, null,
              stagedFiles.length ? gitGroup('已暂存', stagedFiles, true) : null,
              unstagedFiles.length ? gitGroup('更改', unstagedFiles, false) : null,
              git.truncated ? h('div', { className: 'world-vscode-git-note' }, `更改过多，只显示前 ${changedFiles.length} 个。`) : null)))

  /** 模态目录选择器：只列子目录，路径与「上一级」在顶部。 */
  const pickerDialog = () => {
    const current = picker
    const disabled = !current?.path || Boolean(current?.busy) || Boolean(current?.error)
    return h('div', {
      className: 'world-vscode-picker', role: 'dialog', 'aria-modal': true, 'aria-label': '打开文件夹',
      // 点空白处＝取消（和系统「打开文件夹」一致）；键盘由上面的 window 监听统一处理
      onPointerDown: event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) closePicker()
      },
    },
    h('div', { className: 'world-vscode-picker-card', ref: pickerCardRef },
      h('header', { className: 'world-vscode-picker-head' },
        h('span', { className: 'world-vscode-picker-title' }, '打开文件夹'),
        h('button', {
          type: 'button', className: 'world-vscode-picker-close', title: '关闭', 'aria-label': '关闭打开文件夹',
          onClick: closePicker,
        }, '×')),
      h('div', { className: 'world-vscode-picker-path' },
        h('button', {
          type: 'button', className: 'world-vscode-picker-up', title: '上一级文件夹', 'aria-label': '上一级文件夹',
          disabled: !current?.parent || Boolean(current?.busy),
          onClick: () => { if (current?.parent) void browseTo(current.parent) },
        }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M12.4 8H4M7.4 4.6 4 8l3.4 3.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
        h('input', {
          className: 'world-vscode-picker-input', value: pickerDraft, spellCheck: false, autoFocus: true,
          'aria-label': '文件夹路径', title: '可直接输入或粘贴路径，按 Enter 跳转',
          onChange: event => setPickerDraft(event.target.value),
          onKeyDown: event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            const next = pickerDraft.trim()
            if (next) void browseTo(next)
          },
        }),
        h('button', {
          type: 'button', className: 'world-vscode-picker-browse', title: '用系统对话框选择文件夹',
          'aria-label': '浏览系统文件夹', disabled: Boolean(current?.busy),
          onClick: () => void browseNative(),
        }, '浏览…')),
      h('div', { className: 'world-vscode-picker-list' },
        current?.busy && h('div', { className: 'world-vscode-picker-note' }, '正在读取…'),
        current?.error && h('div', { className: 'world-vscode-error' }, current.error),
        !current?.busy && !current?.error && !current?.folders?.length
          ? h('div', { className: 'world-vscode-picker-note' }, '这个文件夹里没有子文件夹')
          : null,
        !current?.busy && current?.folders?.map(item => h('button', {
          key: item.name, type: 'button', className: 'world-vscode-picker-row',
          title: item.name, onClick: () => void browseTo(joinPath(current.path, item.name)),
        }, h(FolderIcon, { open: false }), h('span', null, item.name))),
        current?.truncated ? h('div', { className: 'world-vscode-picker-note' }, '子文件夹过多，只显示前 2000 个。') : null),
      h('footer', { className: 'world-vscode-picker-foot' },
        h('span', { className: 'world-vscode-picker-hint' }, '打开后资源管理器、搜索和 Git 都以这个文件夹为根。'),
        h('div', { className: 'world-vscode-picker-actions' },
          h('button', { type: 'button', onClick: closePicker }, '取消'),
          h('button', { type: 'button', disabled, onClick: () => applyFolder('new') }, '在新窗口打开'),
          h('button', {
            type: 'button', className: 'is-primary', disabled,
            onClick: () => applyFolder('this'),
          }, '打开')))))
  }

  return h('section', {
    className: `world-vscode-window${isActive ? ' is-active' : ''}${maximized ? ' is-max' : ''}${minimized ? ' is-min' : ''}`,
    'data-world-vscode-key': windowKey,
    ref: shellRef,
    // 窗口自己也能拿焦点：没有打开文件时，点标题栏激活后键盘也有落点
    tabIndex: -1,
    onPointerDown: activate,
    style: {
      // 最大化不吃 rect：还原时 rect 原样还在，不用另存一份
      '--vscode-x': maximized ? '0vw' : `${rect.x}vw`,
      '--vscode-y': maximized ? '0vh' : `${rect.y}vh`,
      '--vscode-w': maximized ? '100vw' : `${rect.w}vw`,
      '--vscode-h': maximized
        ? 'calc(100vh - var(--world-desktop-top) - var(--world-taskbar-height))'
        : `${rect.h}vh`,
      zIndex,
    },
    // 多开时两个窗口的无障碍名字不能一样，否则分不清读的是哪个文件夹
    'aria-label': displayName ? `Visual Studio Code — ${displayName}` : 'Visual Studio Code',
  },
  h('header', {
    className: 'world-vscode-titlebar',
    onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    // 双击标题栏 = 最大化 / 还原，和桌面其它窗口一致；点按钮不触发
    onDoubleClick: event => { if (!event.target.closest('button')) onToggleMaximize?.() },
  },
    h('div', { className: 'world-vscode-title' }, h(VscodeGlyph, { size: 16 }),
      h('span', null, active ? `${baseName(active.path)} — ${displayName}` : `Visual Studio Code — ${displayName}`)),
    h('div', { className: 'world-vscode-title-actions' },
      !collectionMode && h('button', {
        type: 'button', className: 'world-vscode-title-btn', title: '打开文件夹 (Ctrl+Shift+O)',
        'aria-label': '打开文件夹', onClick: openPicker,
      }, h(FolderIcon, { open: true }))),
    h('div', { className: 'world-vscode-controls world-vscode-caps' },
      h('button', { type: 'button', title: '最小化', 'aria-label': '最小化 Visual Studio Code', onClick: onMinimize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
      h('button', {
        type: 'button', title: maximized ? '还原' : '最大化',
        'aria-label': maximized ? '还原 Visual Studio Code' : '最大化 Visual Studio Code',
        onClick: onToggleMaximize,
      }, maximized
        ? h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('rect', { x: 0.5, y: 2.5, width: 7, height: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }),
          h('path', { d: 'M2.5 2.5V.5h7v7h-2', fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))
        : h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))),
      h('button', {
        type: 'button', className: 'world-vscode-close', title: '关闭',
        'aria-label': '关闭 Visual Studio Code', onClick: onClose,
      }, h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
        h('path', { d: 'M0 0l10 10M10 0L0 10', stroke: 'currentColor', strokeWidth: 1 }))))),
  h('div', { className: 'world-vscode-body' },
    h('nav', { className: 'world-vscode-activity', 'aria-label': '活动栏' },
      activityButton('files', h(ExplorerIcon, { size: 20 }), '资源管理器', 0, 'Ctrl+Shift+E'),
      !collectionMode && activityButton('search', h(SearchIcon, { size: 20 }), '搜索', 0, 'Ctrl+Shift+F'),
      !collectionMode && activityButton('git', h(SourceControlIcon, { size: 20 }), '源代码管理', changedFiles.length, 'Ctrl+Shift+G'),
      h('div', { className: 'world-vscode-activity-gap' }),
      h('button', {
        type: 'button', className: `world-vscode-activity-btn is-collapse${sidebarOpen ? '' : ' is-off'}`,
        title: sidebarOpen ? '收起侧栏 (Ctrl+B)' : '展开侧栏 (Ctrl+B)',
        'aria-label': sidebarOpen ? '收起侧栏' : '展开侧栏',
        onClick: toggleSidebar,
      }, h('span', { className: 'world-vscode-activity-icon' }, h(SidebarIcon)))),
    sidebarOpen
      ? h('aside', { className: 'world-vscode-sidebar', style: { width: `${sidebarWidth}px` } },
        h('header', { className: 'world-vscode-sidebar-head' },
          h('span', { className: 'world-vscode-sidebar-title' }, SIDE_TITLES[sideView]),
          h('div', { className: 'world-vscode-sidebar-actions' },
            sideView === 'files' ? h(React.Fragment, null,
              !collectionMode && h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '打开文件夹', 'aria-label': '打开文件夹',
                onClick: openPicker,
              }, h(FolderIcon, { open: true })),
              h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '刷新目录', 'aria-label': '刷新目录',
                onClick: () => void refreshTree(),
              }, h(RefreshIcon, { spinning: Boolean(busyDir) })),
              h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '全部折叠', 'aria-label': '全部折叠',
                onClick: () => setExpanded(new Set([treeRoot])),
              }, h(CollapseIcon))) : null,
            sideView === 'search' && searchResult?.files.length ? h('button', {
              type: 'button', className: 'world-vscode-sidebar-act',
              title: searchAllOpen ? '全部折叠' : '全部展开', 'aria-label': searchAllOpen ? '全部折叠' : '全部展开',
              onClick: toggleAllSearchFiles,
            }, searchAllOpen ? h(CollapseIcon) : h(ExpandIcon)) : null,
            sideView === 'search' && (searchText || searchResult) ? h('button', {
              type: 'button', className: 'world-vscode-sidebar-act', title: '清空搜索', 'aria-label': '清空搜索',
              onClick: () => {
                searchAbort.current?.abort()
                searchSeq.current++
                setSearchText('')
                setSearchResult(null)
                setSearchError('')
                setSearchBusy(false)
              },
            }, h(ClearIcon)) : null)),
        sideView === 'git' ? gitPanel()
          : sideView === 'search' ? searchPanel()
            : h('div', { className: 'world-vscode-explorer-list' },
              h('button', {
                type: 'button', className: `world-vscode-root${expanded.has(treeRoot) ? ' is-open' : ''}`,
                'aria-expanded': expanded.has(treeRoot), title: collectionMode ? displayName : rootPath,
                onClick: () => toggleDir(treeRoot),
                onContextMenu: collectionMode ? undefined : event => openFileMenu(event, rootPath),
              }, h(Twist, { open: expanded.has(treeRoot) }), h(FolderIcon, { open: expanded.has(treeRoot) }),
              h('span', { className: 'world-vscode-root-name' }, displayName.toUpperCase())),
              expanded.has(treeRoot) && rootEntries.map(entry => h(TreeNode, {
                key: entry.path || entry.name, parent: treeRoot, entry, depth: 1, expanded, tree, selected: active?.path,
                onToggle: toggleDir, onOpen: openFile, onPin: path => openFile(path, true), onMenu: openFileMenu,
              })),
              busyDir && h('div', { className: 'world-vscode-file-note' }, '正在读取目录…'),
              busyFile && h('div', { className: 'world-vscode-file-note' }, '正在打开文件…'),
              error && h('div', { className: 'world-vscode-error' }, error),
              rootEntries.length === 0 && !busyDir && !error && h('div', { className: 'world-vscode-file-note' }, '此目录为空')),
        h('div', {
          className: 'world-vscode-sidebar-resize', role: 'separator', 'aria-label': '调整侧栏宽度', title: '拖动调整宽度，双击复位',
          onPointerDown: event => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.setPointerCapture(event.pointerId)
            resizeRef.current = { x: event.clientX, width: sidebarWidth }
          },
          onPointerMove: event => {
            const grab = resizeRef.current
            if (!grab) return
            const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(grab.width + event.clientX - grab.x)))
            sidebarWidthRef.current = next
            setSidebarWidth(next)
          },
          onPointerUp: event => {
            if (!resizeRef.current) return
            resizeRef.current = null
            try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
            saveSidebar({ width: sidebarWidthRef.current })
          },
          onPointerCancel: () => { resizeRef.current = null },
          onDoubleClick: () => { setSidebarWidth(SIDEBAR_DEFAULT); saveSidebar({ width: SIDEBAR_DEFAULT }) },
        }))
      : null,
    h('main', { className: 'world-vscode-editor' },
      h('div', { className: 'world-vscode-tabs', role: 'tablist', 'aria-label': '已打开的编辑器' },
        tabs.map(tab => h('div', {
          key: tab.id,
          ref: tab.id === activeId ? activeTabRef : null,
          role: 'tab',
          'aria-selected': tab.id === activeId,
          tabIndex: tab.id === activeId ? 0 : -1,
          className: `world-vscode-tab${tab.id === activeId ? ' active' : ''}${tab.pinned ? ' is-pinned' : ' preview'}${isDirty(tab) ? ' is-dirty' : ''}`,
          title: tab.pinned ? tab.path : `${tab.path} · 预览标签（在文件树双击可锁定）`,
          onClick: () => setActiveId(tab.id),
          onDoubleClick: () => pinTab(tab.id),
          onAuxClick: event => {
            if (event.button !== 1) return
            event.preventDefault()
            closeTab(tab.id)
          },
          onKeyDown: event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setActiveId(tab.id)
          },
        },
        h('span', { className: `world-vscode-tab-icon ${entryIconClass(baseName(tab.path))}` }, h(FileIcon)),
        h('span', { className: 'world-vscode-tab-name' }, baseName(tab.path)),
        isDirty(tab) ? h('i', { className: 'world-vscode-tab-dirty', title: '未保存' }, '●') : null,
        h('button', {
          type: 'button', className: 'world-vscode-tab-close', tabIndex: -1,
          'aria-label': `关闭标签 ${baseName(tab.path)}`, title: '关闭标签',
          onClick: event => { event.stopPropagation(); closeTab(tab.id) },
        }, '×')))),
      active?.document
        ? h('div', { className: 'world-vscode-editor-content', style: { '--vscode-gutter': `${gutterWidth}px` } },
          h('div', {
            // 焦点在侧栏时底色淡一点：位置还在，但不和编辑器抢注意力
            className: `world-vscode-active-line${editing ? '' : ' is-dim'}`, 'aria-hidden': true,
            style: { transform: `translateY(${caretLine * LINE_HEIGHT - scrollTop}px)` },
          }),
          h('div', { className: 'world-vscode-gutter', 'aria-hidden': true },
            h('div', {
              className: 'world-vscode-gutter-rows',
              style: { transform: `translateY(${gutterOffset}px)` },
            }, gutterRows.map(number => h('div', {
              key: number,
              className: `world-vscode-gutter-row${number === caretLine + 1 ? ' is-active' : ''}`,
            }, number)))),
          highlightRows
            ? h('div', { className: 'world-vscode-highlight', 'aria-hidden': true },
              h('div', {
                className: 'world-vscode-highlight-rows',
                style: { transform: `translate(${-scrollLeft}px, ${gutterOffset}px)` },
              }, highlightRows))
            : null,
          h('textarea', {
            key: `${active.id}:${active.path}:${active.reload || 0}`, ref: textareaRef,
            className: `world-vscode-textarea${highlightRows ? ' is-highlight' : ''}`,
            'aria-label': `编辑 ${baseName(active.path)}`,
            spellCheck: false, wrap: 'off', defaultValue: active.draft,
            onScroll: onEditorScroll,
            onSelect: event => syncCaret(event.currentTarget),
            onFocus: event => { setEditing(true); syncCaret(event.currentTarget) },
            onBlur: () => setEditing(false),
            onClick: event => syncCaret(event.currentTarget),
            onChange: event => {
              const value = event.target.value
              // 一旦改动就锁定标签，避免下一次点文件时被预览标签顶掉、还弹一次确认
              setTabs(list => list.map(tab => tab.id === active.id ? { ...tab, draft: value, pinned: true } : tab))
              // 打字后光标也动了：不跟一下，状态栏的行列会停在打字前
              syncCaret(event.target)
              setNotice('')
            },
            onKeyDown: event => {
              const input = event.currentTarget
              if (event.key === 'Tab') {
                event.preventDefault()
                indentSelection(input, event.shiftKey)
                syncCaret(input)
                setNotice('')
              } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault()
                autoIndent(input)
                syncCaret(input)
                setNotice('')
              }
            },
          }))
        : active
          // 文件还在路上：给一个明确的等待态，不要闪一下欢迎页
          ? h('div', { className: 'world-vscode-loading' },
            h('i', { className: 'world-vscode-loading-spin' }),
            h('span', null, `正在打开 ${baseName(active.path)}…`))
          : h('div', { className: 'world-vscode-welcome' },
            h(VscodeGlyph, { size: 72 }),
            h('strong', null, collectionMode ? displayName : 'Visual Studio Code'),
            h('span', null, collectionMode ? '收纳盒里的文件来自原始绝对路径。单击预览，双击锁定标签。'
              : rootPath ? '从资源管理器单击文件预览，双击锁定标签。' : '打开一个文件夹，开始浏览和编辑。'),
            !collectionMode && rootPath ? h('code', { className: 'world-vscode-welcome-path', title: rootPath }, rootPath) : null,
            !collectionMode && h('button', { type: 'button', className: 'world-vscode-welcome-open', onClick: openPicker },
              h(FolderIcon, { open: true }), h('span', null, rootPath ? '打开其他文件夹' : '打开文件夹')),
            (rootPath || collectionMode) ? h('div', { className: 'world-vscode-welcome-keys' },
              keyHint(['Ctrl', 'S'], '保存'),
              keyHint(['Ctrl', 'B'], '侧栏'),
              !collectionMode && keyHint(['Ctrl', 'Shift', 'F'], '搜索'),
              !collectionMode && keyHint(['Ctrl', 'Shift', 'O'], '打开文件夹'),
              keyHint(['Tab'], '缩进'),
              keyHint(['Shift', 'Tab'], '反缩进')) : null)),
  ),
  h('footer', { className: 'world-vscode-statusbar' },
    h('button', {
      type: 'button', className: 'world-vscode-status-root',
      title: collectionMode ? `收纳盒：${displayName}` : rootPath ? `当前文件夹：${rootPath} · 点击更换` : '打开一个文件夹',
      onClick: collectionMode ? undefined : openPicker,
    }, `◆ ${collectionMode ? displayName : rootPath ? baseName(rootPath) : '打开文件夹'}`),
    git?.repo
      ? h('button', {
        type: 'button', className: 'world-vscode-status-branch',
        title: `Git：${git.branch || 'HEAD'}${git.ahead ? ` · 领先 ${git.ahead}` : ''}${git.behind ? ` · 落后 ${git.behind}` : ''}`,
        onClick: () => showView('git'),
      }, h(BranchIcon), h('span', null, git.branch || 'HEAD'),
      git.ahead ? h('i', { className: 'is-ahead' }, `↑${git.ahead}`) : null,
      git.behind ? h('i', { className: 'is-behind' }, `↓${git.behind}`) : null)
      : null,
    error
      ? h('span', { className: 'world-vscode-status-error' }, error)
      : h('span', { className: `world-vscode-status-msg${notice || saving || activeDirty ? ' is-active' : ''}` },
        notice || (saving ? '正在保存…' : activeDirty ? '未保存' : '')),
    // 文件还在读的时候别报「1 行 / LF」：那些数还没意义
    active?.document ? h('span', { className: 'world-vscode-status-pos', title: '光标位置' }, `行 ${caretLine + 1}, 列 ${caretColumn + 1}`) : null,
    active?.document ? h('span', { className: 'world-vscode-status-meta', title: `换行符 ${active.document.eol || 'LF'}` },
      active.document.eol || 'LF') : null,
    active?.document ? h('span', { className: 'world-vscode-status-meta', title: '文件编码' },
      active.document.bom ? 'UTF-8 BOM' : 'UTF-8') : null,
    active?.document ? h('span', { className: 'world-vscode-status-meta', title: '语言模式' },
      language ? languageLabel(language) : extension) : null,
    active?.document ? h('span', { className: 'world-vscode-status-meta', title: '文件行数' }, `${lineCount} 行`) : null,
    active?.document ? h('button', { type: 'button', disabled: !activeDirty || saving, title: '保存 (Ctrl+S)', onClick: () => void saveFile() },
      saving ? '保存中…' : '保存') : null),
  minimized || maximized ? null : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => h('div', { key: edge, className: `world-vscode-resize world-vscode-resize-${edge}`,
    onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd })),
  picker ? pickerDialog() : null,
  // 菜单留在窗口里：portal 到 body 会被 world 的 inert 逻辑锁住（host 窗口关闭时），
  // 也会被窗口的 stacking context 压在下面；fixed 定位本身不受 overflow 裁剪。
  fileMenu ? h('div', {
    ref: fileMenuRef, className: 'world-context-menu world-vscode-menu', role: 'menu',
    style: { left: fileMenu.x, top: fileMenu.y },
    onPointerDown: event => event.stopPropagation(),
    onContextMenu: event => event.preventDefault(),
  },
  h('div', { className: 'world-context-title', title: fileMenu.path }, baseName(fileMenu.path)),
  h('button', {
    type: 'button', role: 'menuitem', autoFocus: true,
    onClick: () => void revealInExplorer(fileMenu.path),
  }, 'Reveal in Explorer'),
  !collectionMode && h('button', {
    type: 'button', role: 'menuitem',
    onClick: () => void copyFilePath(fileMenu.path, true),
  }, '复制相对路径'),
  h('button', {
    type: 'button', role: 'menuitem',
    onClick: () => void copyFilePath(fileMenu.path, false),
  }, '复制绝对路径')) : null)
}
