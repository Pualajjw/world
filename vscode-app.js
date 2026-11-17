import React from 'react'
import { highlight, languageLabel, languageOf } from './highlight.js'
import { desktopError, waitForDesktop } from './desktop-client.js'
import { worldConfirm } from './world-confirm.js'
import { isPhoneViewport } from './responsive.js'
import { PinGlyph, pinLabel } from './window-pin.js'
import { AssistantConversation, observeConversationPortals } from './assistant-conversation.js'
import { NativeDocument, isDocumentPreviewPath } from './native-document.js'
import { QuickOpen } from './vscode-quick-open.js'

const h = React.createElement
const EMPTY_FILES = []
const EMPTY_TOKENS = []
const LINE_HEIGHT = 20
/** 手机上正文放大一号：13px/20px 在 360px 宽里读起来费眼，22px 行高也让点行号更容易。 */
const LINE_HEIGHT_PHONE = 22
const FONT_SIZE_PHONE = 14
const OVERSCAN = 8
/**
 * 折行后的行号得逐行量高度才画得准。几千个 div 排一遍是毫秒级，但再往上就是给编辑器添堵了：
 * 超过这个行数就不装行号，退回到「只有正文」——大文件里读代码本来也不靠行号。
 */
const WRAP_MEASURE_LIMIT = 4000
const SIDEBAR_KEY = 'dsh.world.vscode.sidebar'
/** 打开过的文件夹：跨窗口共用的最近列表，最多记 8 个。 */
const FOLDERS_KEY = 'dsh.world.vscode.folders'
const FOLDERS_LIMIT = 8
const SIDEBAR_MIN = 168
const SIDEBAR_MAX = 460
const SIDEBAR_DEFAULT = 220
const SIDE_VIEWS = ['files', 'search', 'git']
const SIDE_TITLES = { files: '资源管理器', search: '搜索', git: '源代码管理' }
const SEARCH_DEBOUNCE = 260
/** 超大 patch 一次性画完会拖垮窗口，超出部分只给一句提示（完整补丁本就被宿主截到 256KB）。 */
const DIFF_RENDER_LIMIT = 1500

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

/** 最近打开的文件夹放在 localStorage 里；存储不可用时退回模块内的缓存。 */
let folderCache = null

function readFolders() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FOLDERS_KEY) || '[]')
    folderCache = Array.isArray(parsed)
      ? parsed.filter(path => typeof path === 'string' && path).slice(0, FOLDERS_LIMIT)
      : []
    return folderCache
  } catch { return folderCache }
}

function saveFolders(list) {
  folderCache = list
  try { window.localStorage.setItem(FOLDERS_KEY, JSON.stringify(list)) }
  catch { /* storage disabled: keep the cache in memory only */ }
}

/** 新 VSCode 窗口默认打开的文件夹：最近打开列表的第一条。 */
export function lastOpenedFolder() {
  const list = readFolders()
  return Array.isArray(list) && list.length ? list[0] : ''
}

/**
 * 手机布局（窗口铺满整屏、只有拇指）：编辑器要按「一次看几行、点得到几像素」重排。
 * 视口跨过断点时跟着变，所以不是一次性的 useState。
 */
function usePhoneLayout() {
  const [phone, setPhone] = React.useState(isPhoneViewport)
  React.useEffect(() => {
    const sync = () => setPhone(isPhoneViewport())
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  return phone
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

/** 搜索框左侧的替换开关：右列收起、下列展开。 */
function ReplaceToggleIcon({ open, size = 11 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: open ? 'M2.6 4.4 6 7.8l3.4-3.4' : 'M4.4 2.6 7.8 6l-3.4 3.4',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))
}

/** 替换：一对方向相反的箭头。 */
function ReplaceIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M2.5 5.6h9.4M9.6 3.4l2.3 2.2-2.3 2.2M13.5 10.4H4.1M6.4 8.2l-2.3 2.2 2.3 2.2',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))
}

/** 运行批处理：一颗实心三角形。 */
function RunIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M4.6 2.9v10.2L13 8 4.6 2.9z', fill: 'currentColor' }))
}

/** 标题栏的对话入口：一个带输入线的气泡。 */
function ChatIcon({ size = 15 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M2.6 3.4h12.8v8.2H7.3l-3.5 2.7v-2.7H2.6V3.4z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
    h('path', { d: 'M5.4 7h7.2M5.4 9.4h4.6', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }))
}

function SidebarIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
    h('rect', { x: 2.4, y: 3.4, width: 13.2, height: 11.2, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M7.1 3.4v11.2', stroke: 'currentColor', strokeWidth: 1.2 }))
}

/** 手机状态栏的「视图」入口：三条横线，比 SidebarIcon 更不容易和「打开侧栏」混淆。 */
function MenuIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M3 5h12M3 9h12M3 13h12', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
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
 * 折行后滚动位置落在第几逻辑行：tops 是每行顶边的前缀和（单调递增），二分即可。
 * 滚动条能拖到几万个像素，线性找会卡；这里 O(log n)。
 */
function lineAtTop(tops, top) {
  let low = 0
  let high = tops.length - 2
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (tops[mid] <= top) low = mid
    else high = mid - 1
  }
  return low
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
  if (!tab?.document || tab.document.readOnly) return false
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
  if (ext === 'pbt' || ext === 'exe' || ext === 'pbl' || ext === 'pbd') return 'is-pb'
  return 'is-file'
}

/** PowerBuilder 的两个工程入口：`.pbt` 工程文件和编译出来的 `.exe`。 */
const PROJECT_EXTENSIONS = new Set(['pbt', 'exe'])
function isProjectEntry(name) {
  const ext = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  return PROJECT_EXTENSIONS.has(ext)
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

/** 只有 Windows 批处理能被 cmd 直接执行。 */
function isBatchPath(path) {
  return /\.(bat|cmd)$/iu.test(String(path || ''))
}

/** 批处理输出可能带颜色控制码；输出面板只显示纯文本。 */
function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
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

/**
 * 侧栏报错条：原文必须能被选中，也要能一键复制。
 * 反编译失败时那行 pypower 文案是唯一的定位线索，而整套 vscode 外壳都禁掉了选中。
 */
function ErrorNote({ text, onDismiss, onCopied }) {
  return h('div', { className: 'world-vscode-error' },
    h('div', { className: 'world-vscode-error-head' },
      h('span', null, '出错了'),
      h('span', { className: 'world-vscode-error-actions' },
        h('button', {
          type: 'button', className: 'world-vscode-error-action', title: '复制错误原文',
          onClick: async () => { onCopied?.(await writeClipboard(String(text))) },
        }, '复制'),
        onDismiss ? h('button', {
          type: 'button', className: 'world-vscode-error-action', title: '关闭', onClick: onDismiss,
        }, '×') : null)),
    h('div', { className: 'world-vscode-error-text' }, String(text)))
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

/** 更改列表按仓库相对路径折成目录树：目录折叠、目录级批量暂存都挂在树上。 */
function buildGitTree(files) {
  const root = { dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index]
      if (!name) continue
      let child = node.dirs.get(name)
      if (!child) {
        child = { name, dirs: new Map(), files: [] }
        node.dirs.set(name, child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

function gitTreePaths(node) {
  const paths = node.files.map(file => file.path)
  for (const child of node.dirs.values()) paths.push(...gitTreePaths(child))
  return paths
}

/**
 * 把 git 的 unified patch 拆成可画的行走：hunk 头记下新旧起始行号，
 * 之后按前缀推进。`diff --git` / `index` / `---` / `+++` 是文件头元信息，
 * 顶部标签已经给过文件名和重命名，正文里不再重复这四行；模式变化 /
 * 二进制提示保留成 meta 行。
 */
function diffLines(patch) {
  const rows = []
  let oldLine = 0
  let newLine = 0
  for (const text of String(patch || '').replace(/\r/gu, '').split('\n')) {
    if (/^(diff --git |index |--- |\+\+\+ )/u.test(text)) continue
    if (/^(new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |Binary files |GIT binary patch)/u.test(text)) {
      rows.push({ kind: 'meta', text })
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ kind: 'hunk', text })
      continue
    }
    if (text.startsWith('\\')) { rows.push({ kind: 'meta', text }); continue }
    if (text.startsWith('+')) { rows.push({ kind: 'add', old: '', new: newLine++, text: text.slice(1) }); continue }
    if (text.startsWith('-')) { rows.push({ kind: 'del', old: oldLine++, new: '', text: text.slice(1) }); continue }
    if (text.startsWith(' ')) { rows.push({ kind: 'ctx', old: oldLine++, new: newLine++, text: text.slice(1) }); continue }
    // patch 末尾的换行会 split 出一个空串，不画
    if (text) rows.push({ kind: 'ctx', old: oldLine++, new: newLine++, text })
  }
  return rows
}

function TreeNode({ parent, entry, depth, expanded, tree, selected, onToggle, onOpen, onPin, onMenu, onOpenProject }) {
  const full = entry.path ? normalizePath(entry.path) : joinPath(parent, entry.name)
  const isDir = entry.type === 'directory'
  const project = !isDir && isProjectEntry(entry.name)
  const open = expanded.has(full)
  const children = isDir ? (tree.get(full) || EMPTY_FILES) : EMPTY_FILES
  return h(React.Fragment, { key: full },
    h('button', {
      type: 'button',
      className: `world-vscode-file${isDir ? ' is-dir' : ''}${open ? ' is-open' : ''}${project ? ' is-project' : ''}${selected === full ? ' selected' : ''}`,
      style: { paddingLeft: 8 + depth * 14 },
      title: isDir ? full : project ? `${full} · 点击作为 PowerBuilder 工程打开` : `${full} · 双击锁定标签`,
      'aria-expanded': isDir ? open : undefined,
      onClick: () => isDir ? onToggle(full) : project ? onOpenProject?.(full) : onOpen(full, false),
      onDoubleClick: () => { if (!isDir && !project) onPin(full) },
      onContextMenu: event => onMenu?.(event, full),
    },
    isDir ? h(Twist, { open }) : h(TwistSpacer),
    h('span', { className: `world-vscode-file-icon ${isDir ? 'is-dir' : entryIconClass(entry.name)}` },
      isDir ? h(FolderIcon, { open }) : h(FileIcon)),
    h('span', { className: 'world-vscode-file-name' }, entry.name)),
    isDir && open && children.map(child => h(TreeNode, {
      key: child.name, parent: full, entry: child, depth: depth + 1,
      expanded, tree, selected, onToggle, onOpen, onPin, onMenu, onOpenProject,
    })),
    isDir && open && children.length === 0
      ? h('div', { className: 'world-vscode-tree-note', style: { paddingLeft: 26 + depth * 14 } }, '空目录')
      : null)
}

const NO_SESSION_SUBSCRIBE = () => () => {}
const EMPTY_SESSION_LIST = { ids: [], byId: {} }
const emptySessionSnapshot = () => EMPTY_SESSION_LIST

/** Windows 路径不区分大小写；其它平台按原样比较。 */
function sameFolder(a, b) {
  const left = normalizePath(a)
  const right = normalizePath(b)
  if (!left || !right) return false
  return /^[a-zA-Z]:\//u.test(left) || /^[a-zA-Z]:\//u.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** 属于这个文件夹的历史会话，最新的在前；子代理会话不参与。 */
function sessionsForFolder(state, rootPath) {
  const byId = state?.byId || {}
  const ids = Array.isArray(state?.ids) ? state.ids : Object.keys(byId)
  return ids.map(id => byId[id])
    .filter(row => row && row.origin !== 'subagent' && sameFolder(row.cwd, rootPath))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
}

function sessionLabel(row) {
  return row?.title || row?.displayTitle || baseName(row?.cwd || '') || '未命名会话'
}

function sessionTime(time) {
  const value = Number(time)
  if (!value) return ''
  try {
    return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

/**
 * 编辑器里的原生对话标签：复用 DSH 的 native conversation（历史、流式、工具、输入、审批）。
 * 会话按 VSCode 当前根目录筛选，可新建或从该目录的历史会话里选。
 * 挂载时 AssistantConversation 会 retain 会话并占用唯一的对话座位，卸载即释放。
 */
function VscodeChat({ active, sessionId, boundSessionId, rootPath, rpc, sessions, SessionProvider, renderSlot, conversationSeat, onSelectSession }) {
  const chatRef = React.useRef(null)
  const headRef = React.useRef(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const listState = React.useSyncExternalStore(
    sessions?.list?.subscribe || NO_SESSION_SUBSCRIBE,
    sessions?.list?.getSnapshot || emptySessionSnapshot,
  )
  React.useLayoutEffect(() => {
    if (!chatRef.current) return
    return observeConversationPortals(chatRef.current)
  }, [active])
  React.useEffect(() => {
    if (!menuOpen) return
    const close = event => { if (!headRef.current?.contains(event.target)) setMenuOpen(false) }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [menuOpen])

  const rows = sessionsForFolder(listState, rootPath)
  const selectedRow = sessionId ? listState?.byId?.[sessionId] : null
  const mismatch = Boolean(selectedRow?.cwd && !sameFolder(selectedRow.cwd, rootPath))
  const listReady = !listState || listState.phase === undefined || listState.phase === 'ready'
  const title = selectedRow && !mismatch
    ? sessionLabel(selectedRow)
    : sessionId && !selectedRow ? '正在打开会话…' : listReady ? '选择会话' : '正在读取会话…'

  // 列表晚于标签打开时才就绪：没有选中会话就自动挑这个文件夹里最合适的一条
  React.useEffect(() => {
    if (sessionId || !rows.length) return
    const next = rows.find(row => row.id === boundSessionId)
      || rows.find(row => !row.blank)
      || rows[0]
    if (next) onSelectSession?.(next.id)
  }, [sessionId, boundSessionId, rows, onSelectSession])

  // 原生模型菜单挂在 body 上；菜单关闭后主动刷新一次投影，让触发器的模型名
  // 跟上宿主刚写入的 modelSelection（旧宿主不会把这条投影推给非主会话）。
  React.useEffect(() => {
    if (!sessionId || typeof sessions?.refreshProjections !== 'function') return
    const menuOpen = () => Boolean(document.querySelector(
      '[data-world-assistant-dialog] [role="menu"], [data-world-assistant-dialog][role="menu"], '
      + '[data-world-assistant-dialog] [role="listbox"], [data-world-assistant-dialog][role="listbox"]'))
    const timers = new Set()
    const refresh = () => {
      Promise.resolve(sessions.refreshProjections(sessionId)).catch(() => {})
    }
    let open = menuOpen()
    const observer = new MutationObserver(() => {
      const next = menuOpen()
      if (open && !next) {
        // 选择请求可能还在路上：落盘前刷一次会读到旧值，稍后再兜一次
        for (const delay of [200, 800]) {
          const timer = setTimeout(() => { timers.delete(timer); if (!open) refresh() }, delay)
          timers.add(timer)
        }
      }
      open = next
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const timer of timers) clearTimeout(timer)
    }
  }, [sessionId, sessions])

  const choose = id => {
    setMenuOpen(false)
    setError('')
    onSelectSession?.(id)
  }

  const create = async () => {
    if (busy) return
    if (!sessions?.create) { setError('当前宿主不支持新建会话。'); return }
    setBusy(true)
    setError('')
    try {
      // 先让宿主把当前文件夹解析成 DSH workspace；空会话 Hero 才会显示这个目录。
      // 旧宿主没有这个接口时退回 cwd。
      let workspaceId = ''
      try {
        const resolved = unwrap(await rpc.call('/api', 'world-vscode-sessions/resolve', { root: rootPath }))
        workspaceId = resolved?.workspaceId || ''
      } catch { /* older host: fall back to cwd */ }
      const id = await sessions.create(workspaceId ? { workspaceId } : { cwd: rootPath })
      if (id) choose(id)
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy(false)
    }
  }

  const body = !active
    ? h('div', { className: 'world-vscode-chat-message' }, '切回这个窗口后继续对话。')
    : sessionId && !mismatch
      ? h(AssistantConversation, { sessionId, sessions, SessionProvider, renderSlot, conversationSeat })
      : h('div', { className: 'world-vscode-chat-empty' },
        h(ChatIcon, { size: 28 }),
        h('strong', null, mismatch ? '当前会话不属于这个文件夹'
          : listReady ? '这个文件夹还没有对话' : '正在读取会话…'),
        h('span', null, mismatch ? `会话目录与 ${baseName(rootPath)} 不一致，换一个会话或新建。`
          : `只会显示和新建「${baseName(rootPath)}」里的会话。`),
        h('div', { className: 'world-vscode-chat-empty-actions' },
          h('button', {
            type: 'button', className: 'is-primary', disabled: busy || !sessions?.create,
            onClick: () => void create(),
          }, busy ? '新建中…' : '新建会话'),
          rows.length ? h('button', {
            type: 'button', onClick: () => setMenuOpen(true),
          }, '选择历史会话') : null),
        error ? h('div', { className: 'world-vscode-chat-error' }, error) : null)

  const menu = menuOpen ? h('div', { className: 'world-vscode-chat-menu', role: 'menu', 'aria-label': '历史会话' },
    h('div', { className: 'world-vscode-chat-menu-head' }, `${baseName(rootPath)} 的会话（${rows.length}）`),
    rows.length
      ? rows.map(row => h('button', {
        key: row.id, type: 'button', role: 'menuitemradio', 'aria-checked': row.id === sessionId,
        className: `world-vscode-chat-option${row.id === sessionId ? ' is-current' : ''}`,
        title: row.cwd || rootPath,
        onClick: () => choose(row.id),
      },
      h('span', { className: 'world-vscode-chat-option-name' }, sessionLabel(row)),
      h('span', { className: 'world-vscode-chat-option-meta' },
        [row.running ? '运行中' : '', sessionTime(row.updatedAt)].filter(Boolean).join(' · '))))
      : h('div', { className: 'world-vscode-chat-menu-note' }, '这个文件夹还没有会话，点「新建会话」。'))
    : null

  if (!sessions || !SessionProvider || !renderSlot || !conversationSeat) {
    return h('div', { className: 'world-vscode-chat' },
      h('div', { className: 'world-vscode-chat-message' }, '当前宿主不支持内嵌原生对话。'))
  }
  return h('div', { className: 'world-vscode-chat', ref: chatRef },
    h('div', { className: 'world-vscode-chat-head', ref: headRef },
      h('div', { className: 'world-vscode-chat-bar' },
        h('button', {
          type: 'button', className: 'world-vscode-chat-session',
          'aria-haspopup': 'menu', 'aria-expanded': menuOpen, title: '切换这个文件夹的历史会话',
          onClick: () => { setMenuOpen(open => !open); setError('') },
        },
        h(ChatIcon, { size: 13 }),
        h('span', { className: 'world-vscode-chat-session-name' }, title),
        h('span', { className: 'world-vscode-chat-folder', title: rootPath }, baseName(rootPath)),
        h('span', { className: 'world-vscode-chat-caret', 'aria-hidden': true }, '▾')),
        h('button', {
          type: 'button', className: 'world-vscode-chat-new', disabled: busy || !sessions?.create,
          title: sessions?.create ? '在这个文件夹新建会话' : '当前宿主不支持新建会话',
          onClick: () => void create(),
        }, busy ? '新建中…' : '新建会话')),
      menu),
    h('div', { className: 'world-vscode-chat-body' }, body))
}

export function VscodeWindow({
  session, remote, rpc, rect, rootPath: rootProp, windowKey, zIndex = 5, isActive = true,
  pinned = false, onTogglePin,
  state = 'normal', onClose, onMinimize, onToggleMaximize, collection = null, openRequest = null,
  onDirtyChange, onRootChange, onOpenInNewWindow, onFocusFolder, onDesktopRegister,
  onDragStart, onDragMove, onDragEnd, onResizeStart, onActivate, getDirectoryPicker,
  sessions, SessionProvider, renderSlot, conversationSeat, immersive = false,
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
  const [recentFolders, setRecentFolders] = React.useState(() => readFolders() || [])
  /** 手机上窗口铺满整屏，侧栏是盖在正文上的抽屉：默认收起，展开状态也不写回桌面偏好。 */
  const phone = usePhoneLayout()
  const [desktopSidebarOpen, setDesktopSidebarOpen] = React.useState(() => stored.open !== false)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  /**
   * 手机没有一直露在外面的活动栏：那几个图标（资源管理器 / 搜索 / 源代码管理 / 侧栏开关）
   * 28px 一列要吃掉 40px 正文宽度，而拇指根本够不到屏幕最左侧。全部收进状态栏左端的
   * 「视图」按钮，点开从底部弹出一张菜单。
   */
  const [phoneMenuOpen, setPhoneMenuOpen] = React.useState(false)
  const sidebarOpen = phone ? drawerOpen : desktopSidebarOpen
  const setSidebarOpen = value => { if (phone) setDrawerOpen(value); else setDesktopSidebarOpen(value) }
  const lineHeight = phone ? LINE_HEIGHT_PHONE : LINE_HEIGHT
  /**
   * 自动换行：手机上默认开。手机屏只有 360px，`white-space: pre` 意味着每读一屏都要左右拖。
   * 换行后逻辑行与视觉行不再一一对应，所以行号槽、当前行底纹、语法高亮层一律让位——那三块
   * 都是按「第 n 行 = n × 行高」绝对定位的，留着只会错位。纯文本 textarea 自己就能折行。
   */
  const [wrap, setWrap] = React.useState(isPhoneViewport)
  React.useEffect(() => { setWrap(phone) }, [phone])
  // 视口从手机变回桌面时那条菜单没人渲染了，状态别留着——否则再缩回手机，一进编辑器就顶着一张菜单
  React.useEffect(() => { if (!phone) setPhoneMenuOpen(false) }, [phone])
  const [tree, setTree] = React.useState(() => new Map())
  const [expanded, setExpanded] = React.useState(() => new Set(session?.cwd ? [session.cwd] : []))
  const [busyDir, setBusyDir] = React.useState('')
  const [busyFile, setBusyFile] = React.useState('')
  const [tabs, setTabs] = React.useState([])
  const [activeId, setActiveId] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [scrollTop, setScrollTop] = React.useState(0)
  const [scrollLeft, setScrollLeft] = React.useState(0)
  const [caretLine, setCaretLine] = React.useState(0)
  const [caretColumn, setCaretColumn] = React.useState(0)
  const [editing, setEditing] = React.useState(false)
  const [viewportHeight, setViewportHeight] = React.useState(400)
  const [viewportWidth, setViewportWidth] = React.useState(320)
  /**
   * 折行时每逻辑行的顶边（px 前缀和，长度 = 行数 + 1）。量不到就是 null——那一帧宁可不画行号，
   * 也不要按 n × 行高 猜：猜错就是整列数字错位，比没有行号更难用。
   */
  const [wrapTops, setWrapTops] = React.useState(null)
  /** 镜像层量出来的正文宽度（已扣掉滚动条与右内边距）：折行高亮层照抄它才能同点断行。 */
  const [wrapWidth, setWrapWidth] = React.useState(0)
  /** 输入法组字期间不能把 textarea 的文字透明化：候选串只在 textarea 里，透明了就看不见。 */
  const [composing, setComposing] = React.useState(false)
  const [sideView, setSideView] = React.useState(() => SIDE_VIEWS.includes(stored.view) ? stored.view : 'files')
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
  const [replaceText, setReplaceText] = React.useState('')
  const [replaceOpen, setReplaceOpen] = React.useState(false)
  const [replacing, setReplacing] = React.useState(false)
  const [searchNotice, setSearchNotice] = React.useState('')
  const [reveal, setReveal] = React.useState(null)
  const [git, setGit] = React.useState(null)
  const [gitOp, setGitOp] = React.useState('')
  const [gitMsg, setGitMsg] = React.useState(null)
  const [gitHistory, setGitHistory] = React.useState(null)
  const [historyOpen, setHistoryOpen] = React.useState(true)
  const [historyDetails, setHistoryDetails] = React.useState(() => new Set())
  const historyRequest = React.useRef(0)
  /** 折叠着的 Git 目录（键 = 分组 + 仓库相对目录）；默认全展开，换仓库时清空。 */
  const [gitClosed, setGitClosed] = React.useState(() => new Set())
  const [commitText, setCommitText] = React.useState('')
  const [picker, setPicker] = React.useState(null)
  const [quickOpen, setQuickOpen] = React.useState(false)
  const [pickerDraft, setPickerDraft] = React.useState('')
  /** 别的插件留下的可打开目录：IMA 虚拟工作区、PowerBuilder 工程工作区。 */
  const [pluginRoots, setPluginRoots] = React.useState(null)
  const [openingProject, setOpeningProject] = React.useState('')
  const [fileMenu, setFileMenu] = React.useState(null)
  const fileMenuRef = React.useRef(null)
  /** 批处理运行面板：jobId 来自宿主终端服务，offset 是已经读到的字节位置。 */
  const [batchRun, setBatchRun] = React.useState(null)
  const [batchStarting, setBatchStarting] = React.useState(false)
  const batchStartingRef = React.useRef(false)
  /** 收起后进程继续跑，编辑器回到原文件；状态栏留一个入口重新展开输出。 */
  const [batchCollapsed, setBatchCollapsed] = React.useState(false)
  const batchTimer = React.useRef(0)
  const batchJobRef = React.useRef('')
  const batchOutputRef = React.useRef(null)
  const mounted = React.useRef(true)
  const shellRef = React.useRef(null)
  const textareaRef = React.useRef(null)
  /** 不可见的排版镜像层：只在折行时挂载，用来量每行折成几行。 */
  const measureRef = React.useRef(null)
  /** 折行时的高亮层：宽度要和镜像层一模一样，否则断行点不同、颜色就会错位。 */
  const highlightRef = React.useRef(null)
  const wrapTopsRef = React.useRef(null)
  const wrapMeasureKey = React.useRef('')
  /** 折行量出来之前的 reveal 只能按行高估：记下目标行，等量到了再校正一次滚动。 */
  const wrapRevealLine = React.useRef(0)
  const searchInputRef = React.useRef(null)
  const replaceInputRef = React.useRef(null)
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
  /** 每个 Diff 标签的请求序号：同一文件连点几次只认最后一次结果。 */
  const diffSeq = React.useRef(new Map())
  /** 每个文件夹上次选中的对话会话；关掉对话标签再打开时还回到那一条。 */
  const chatPicks = React.useRef(new Map())
  const revealSeq = React.useRef(0)
  const revealedSeq = React.useRef(0)
  const pickerAbort = React.useRef(null)
  /** 对话框开着时键盘归它：Escape 关闭、Tab 不跑出卡片、其它快捷键让路。 */
  const pickerOpenRef = React.useRef(false)
  const pickerCardRef = React.useRef(null)
  const desktopHandle = React.useRef(null)
  pickerOpenRef.current = Boolean(picker || quickOpen)
  tabsRef.current = tabs
  activeIdRef.current = activeId
  treeRef.current = tree
  gitRef.current = git
  gitOpRef.current = gitOp
  sideViewRef.current = sideView
  sidebarOpenRef.current = sidebarOpen
  sidebarWidthRef.current = sidebarWidth
  const rootPath = collectionMode ? '' : normalizePath(rootProp ?? session?.cwd ?? '')
  const gitScope = JSON.stringify([session?.id, rootPath, collectionMode])
  const gitScopeRef = React.useRef(gitScope)
  gitScopeRef.current = gitScope
  // 每次换根都写进最近列表：不管来自对话框、插件位置、工程解析还是别的窗口命令。
  React.useEffect(() => {
    if (!rootPath || collectionMode) return
    setRecentFolders(current => {
      const next = [rootPath, ...current.filter(path => path !== rootPath)].slice(0, FOLDERS_LIMIT)
      if (next.length === current.length && next.every((path, index) => path === current[index])) return current
      saveFolders(next)
      return next
    })
  }, [rootPath, collectionMode])
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
    const update = () => {
      setViewportHeight(node.clientHeight || 400)
      // 折行宽度会随抽屉 / 旋转变化：宽度也记一份，行号测量才知道什么时候该重量
      setViewportWidth(node.clientWidth || 320)
    }
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update)
      observer.observe(node)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [active?.id, Boolean(active?.document)])

  /**
   * 折行以后「第 n 行 = n × 行高」不再成立：一行折成几行只有排版引擎知道。
   * 所以拿一个不可见的镜像层（同字体、同宽度、同 pre-wrap）把每逻辑行单独排一遍，读回高度做前缀和。
   * 行号槽与当前行底纹都按这个前缀和绝对定位；折行关掉时走老路，一个 div 都不建。
   */
  React.useLayoutEffect(() => {
    const drop = () => {
      if (!wrapTopsRef.current) return
      wrapTopsRef.current = null
      wrapMeasureKey.current = ''
      setWrapTops(null)
    }
    if (!wrap) { drop(); return }
    const node = textareaRef.current
    const layer = measureRef.current
    if (!node || !layer) return
    const value = active?.draft || ''
    const count = countLines(value)
    if (count > WRAP_MEASURE_LIMIT) { drop(); return }
    const style = window.getComputedStyle(node)
    const width = node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
    if (!width) return
    // 高亮层用同一份宽度：少 1px 就可能提前一个字折行，颜色整片错位
    setWrapWidth(current => current === width ? current : width)
    const key = `${width}|${lineHeight}|${count}|${value.length}|${value}`
    if (key === wrapMeasureKey.current) return
    wrapMeasureKey.current = key
    layer.style.width = `${width}px`
    const cells = []
    const fragment = document.createDocumentFragment()
    for (const line of value.split('\n')) {
      const cell = document.createElement('div')
      // 空行在 pre-wrap 里没有内容就没有高度：塞一个零宽字符，让它照样占一行
      cell.textContent = line || '\u200b'
      fragment.appendChild(cell)
      cells.push(cell)
    }
    layer.replaceChildren(fragment)
    const tops = new Int32Array(cells.length + 1)
    let rows = 0
    for (let index = 0; index < cells.length; index++) {
      // 折行只会在行高处切：高度 ÷ 行高就是这一行占了几行视觉行
      rows += Math.max(1, Math.round(cells[index].offsetHeight / lineHeight))
      tops[index + 1] = rows * lineHeight
    }
    wrapTopsRef.current = tops
    setWrapTops(tops)
    // reveal 之前按行高估的那个位置，现在能算准了，补一次
    const line = wrapRevealLine.current
    if (line && tops.length === count + 1) {
      wrapRevealLine.current = 0
      node.scrollTop = Math.max(0, tops[line - 1] - (node.clientHeight - lineHeight) / 2)
      scrollTopRef.current = node.scrollTop
      setScrollTop(node.scrollTop)
    }
  }, [wrap, active?.draft, active?.id, lineHeight, viewportWidth])

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
      setError('')
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
  const openFile = async (filePath, pin = false, signal, rootOverride) => {
    // 手机上侧栏是抽屉：点文件就是在「选它」，选完该把正文让出来
    if (phone) setDrawerOpen(false)
    const list = tabsRef.current
    // Diff 标签与源码标签共用 path，但打开源码时必须跳过它
    const existing = list.find(tab => tab.path === filePath && tab.kind !== 'diff')
    const inFlight = pending.current.get(filePath)
    const root = rootOverride || (collectionMode ? collectionRootFor(filePath) : rootPath)
    const kind = isDocumentPreviewPath(filePath) ? 'document' : undefined
    if (existing || inFlight) {
      const id = existing?.id || inFlight.id
      if (pin) setTabs(current => current.map(tab => tab.id === id ? { ...tab, pinned: true } : tab))
      setActiveId(id)
      return { id, task: inFlight?.task || Promise.resolve() }
    }
    const preview = pin ? null : list.find(tab => !tab.pinned && tab.kind !== 'diff')
    if (preview) {
      if (isDirty(preview) && !await worldConfirm({
        title: '放弃未保存的修改',
        message: `预览标签「${baseName(preview.path)}」还有未保存的修改，打开 ${baseName(filePath)} 会把它顶掉。`,
        confirmLabel: '放弃并打开',
        danger: true,
      })) return
      setTabs(current => current.map(tab => tab.id === preview.id
        ? { ...tab, path: filePath, root, kind, document: null, draft: '' } : tab))
      setActiveId(preview.id)
      if (kind) {
        for (const [path, entry] of pending.current) if (entry.id === preview.id) { entry.controller.abort(); pending.current.delete(path) }
        setBusyFile('')
      }
      return { id: preview.id, task: kind ? Promise.resolve() : loadFile(preview.id, filePath, false, signal, root) }
    }
    const id = `tab-${++nextTabId.current}`
    setTabs(current => [...current, { id, path: filePath, root, kind, pinned: pin, document: null, draft: '' }])
    setActiveId(id)
    return { id, task: kind ? Promise.resolve() : loadFile(id, filePath, false, signal, root) }
  }

  const pinTab = id => setTabs(list => list.map(tab => tab.id === id ? { ...tab, pinned: true } : tab))

  // 桌面文件链接：窗口打开后自动把这个文件放进标签（同一窗口再次打开走 nonce 递增）。
  React.useEffect(() => {
    if (!openRequest?.path || !session?.id) return
    const path = normalizePath(openRequest.path)
    openFile(path, true, undefined, collectionMode ? collectionRootFor(path) : rootPath)
  }, [openRequest?.nonce])

  const closeTab = async id => {
    const tab = tabsRef.current.find(item => item.id === id)
    if (isDirty(tab) && !await worldConfirm({
      title: '关闭标签',
      message: `「${baseName(tab.path)}」还有未保存的修改，关闭后就没了。`,
      confirmLabel: '仍然关闭',
      danger: true,
    })) return
    const list = tabsRef.current
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
    // 快捷键和按钮可能在 React 提交状态前接连触发，同步占住同一条保存事务。
    if (!isDirty(tab) || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-source/save', {
        sessionId: session.id, root: tab.root || rootPath, path: tab.path, version: tab.document.version, source: tab.draft,
      }))
      // 保存的是发起请求时的草稿；等待期间的新输入仍未落盘，只更新它的磁盘版本。
      setTabs(list => list.map(item => item.id === tab.id && item.path === tab.path
        ? { ...item, document: value, draft: item.draft === tab.draft ? value.source : item.draft } : item))
      const current = tabsRef.current.find(item => item.id === tab.id && item.path === tab.path)
      if (current?.draft === tab.draft && activeIdRef.current === tab.id) flashNotice('已保存')
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      savingRef.current = false
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
    const width = 200, height = 200
    setFileMenu({
      path,
      x: Math.min(Math.max(8, event.clientX), Math.max(8, (window.innerWidth || 0) - width)),
      y: Math.min(Math.max(8, event.clientY), Math.max(8, (window.innerHeight || 0) - height)),
    })
  }

  const stopBatchPolling = () => { window.clearTimeout(batchTimer.current); batchTimer.current = 0 }

  const pollBatchJob = async (jobId, offset) => {
    try {
      const value = unwrap(await rpc.call('/api', 'world-terminal/poll', { jobId, offset }))
      if (!mounted.current) return
      setBatchRun(run => run && run.jobId === jobId ? {
        ...run,
        text: (run.text + stripAnsi(value.chunk)).slice(-200_000),
        offset: value.offset,
        running: Boolean(value.running),
        exitCode: value.exitCode,
        cancelled: Boolean(value.cancelled),
        durationMs: Number(value.durationMs) || 0,
        error: value.error || '',
      } : run)
      if (value.running) batchTimer.current = window.setTimeout(() => void pollBatchJob(jobId, value.offset), 220)
    } catch (cause) {
      if (!mounted.current) return
      setBatchRun(run => run && run.jobId === jobId
        ? { ...run, running: false, error: String(cause?.message || cause) } : run)
    }
  }

  const cancelBatch = async () => {
    const jobId = batchJobRef.current
    if (!jobId) return
    try { await rpc.call('/api', 'world-terminal/cancel', { jobId }) } catch { /* 已经结束 */ }
  }

  /** 收起输出但不打断进程：把批处理文件重新打开，正文立刻可见；状态栏保留回收入的入口。 */
  const collapseBatchPanel = async () => {
    if (!batchRun) return
    const file = normalizePath(batchRun.path)
    if (!tabsRef.current.some(tab => tab.path === file)) await openFile(file, true)
    setBatchCollapsed(true)
  }

  /** 用宿主的终端服务跑一个 .bat / .cmd：输出按字节偏移轮询，不为每个脚本新开接口。 */
  const runBatch = async path => {
    const file = normalizePath(path)
    if (!isBatchPath(file)) { setError('只能运行 .bat 或 .cmd 文件。'); return }
    if (!session?.id) { setError('先打开一个会话再运行批处理。'); return }
    // 锁住整个启动事务，包括取消旧任务的等待；React state 只负责显示。
    if (batchStartingRef.current) return
    batchStartingRef.current = true
    setBatchStarting(true)
    const directory = dirName(file) || rootPath
    try {
      if (batchRun?.running) await cancelBatch()
      stopBatchPolling()
      const value = unwrap(await rpc.call('/api', 'world-terminal/run', {
        sessionId: session.id, cwd: directory,
        // 反斜杠 + 引号：路径里有空格也能被 cmd 当成一个文件，而不是两个参数
        line: `call "${nativePath(file)}"`,
      }))
      batchJobRef.current = value.jobId
      setBatchCollapsed(false)
      setBatchRun({ path: file, text: '', offset: 0, jobId: value.jobId,
        running: true, exitCode: null, cancelled: false, durationMs: 0, error: '' })
      window.setTimeout(() => void pollBatchJob(value.jobId, 0), 120)
    } catch (cause) {
      batchJobRef.current = ''
      setBatchCollapsed(false)
      setBatchRun({ path: file, text: '', offset: 0, jobId: '',
        running: false, exitCode: null, cancelled: false, durationMs: 0, error: String(cause?.message || cause) })
    } finally {
      batchStartingRef.current = false
      if (mounted.current) setBatchStarting(false)
    }
  }

  const closeBatchPanel = async () => {
    if (batchRun?.running && !await worldConfirm({
      title: '停止运行',
      message: `「${baseName(batchRun.path)}」还在运行，关闭面板会先停止它。`,
      confirmLabel: '停止并关闭',
      danger: true,
    })) return
    if (batchRun?.running) await cancelBatch()
    stopBatchPolling()
    batchJobRef.current = ''
    setBatchCollapsed(false)
    setBatchRun(null)
  }

  React.useEffect(() => {
    const node = batchOutputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [batchRun?.text, batchRun?.running])

  React.useEffect(() => () => { window.clearTimeout(batchTimer.current) }, [])

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
    if (!minimized) return
    setFileMenu(null)
    setPhoneMenuOpen(false)
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
    setQuickOpen(false)
    setPhoneMenuOpen(false)
    // 别的窗口可能刚开过文件夹：每次打开对话框都重新读一次共享列表；
    // 存储被禁时 readFolders() 返回 null，别把内存里的记录擦掉
    const stored = readFolders()
    if (stored?.length) setRecentFolders(stored)
    const start = rootPath || normalizePath(session?.cwd || '')
    setPicker({ path: start, parent: '', folders: [], busy: true, error: '', truncated: false })
    setPickerDraft(start)
    void browseTo(start)
    // 列表可能刚在别处装好/授权，打开对话框时顺手重扫一次
    void scanRootsRef.current?.()
  }
  const openPickerRef = React.useRef(openPicker)
  openPickerRef.current = openPicker

  const closePicker = () => {
    pickerAbort.current?.abort()
    pickerAbort.current = null
    setPicker(null)
  }

  /** 换文件夹会关掉现有标签：未保存的修改必须先问过。 */
  const switchRoot = async (next, destination = 'this') => {
    if (!next) return
    if (destination === 'new') { onOpenInNewWindow?.(next); return }
    if (next === rootPath) return
    // 这个文件夹已经在别的窗口打开：只把它拿到前台，当前窗口原样保留
    if (onFocusFolder?.(next)) return
    if (dirty && !await worldConfirm({
      title: '切换文件夹',
      message: '当前窗口还有未保存的修改，切换文件夹会关掉这些标签。',
      confirmLabel: '仍然切换',
      danger: true,
    })) return
    // Another window may have opened this folder while the confirmation was visible.
    if (onFocusFolder?.(next)) return
    setTabs([])
    setActiveId('')
    setReveal(null)
    setSearchText('')
    setSearchResult(null)
    setSearchError('')
    setSearchBusy(false)
    setSearchOpen(new Set())
    setReplaceText('')
    setReplaceOpen(false)
    setReplacing(false)
    setSearchNotice('')
    setGit(null)
    setGitMsg(null)
    setCommitText('')
    setNotice('')
    onRootChange?.(next)
  }
  const switchRootRef = React.useRef(switchRoot)
  switchRootRef.current = switchRoot
  const openQuick = () => {
    if (collectionMode || !rootPath) return
    closePicker(); setPhoneMenuOpen(false); setQuickOpen(true)
  }
  const openQuickRef = React.useRef(openQuick)
  openQuickRef.current = openQuick
  React.useEffect(() => { setQuickOpen(false) }, [rootPath, session?.id, minimized])

  const applyFolder = destination => {
    const next = normalizePath(picker?.path || '')
    if (!next) return
    closePicker()
    switchRoot(next, destination)
  }

  /** 插件提供的可打开位置：IMA 是一个整体，PB 是逐个工程。 */
  const scanPluginRoots = React.useCallback(async signal => {
    if (!session?.id) return
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-roots/scan', {}, signal))
      if (!mounted.current || signal?.aborted) return
      setPluginRoots(value && typeof value === 'object' ? value : null)
    } catch {
      // 旧宿主没有这个服务，或者 IMA 没授权：这一栏不出现就好，不在侧栏里报警
      if (mounted.current && !signal?.aborted) setPluginRoots(null)
    }
  }, [rpc, session?.id])
  const scanRootsRef = React.useRef(scanPluginRoots)
  scanRootsRef.current = scanPluginRoots

  React.useEffect(() => {
    const controller = new AbortController()
    void scanPluginRoots(controller.signal)
    return () => controller.abort()
  }, [scanPluginRoots])

  /**
   * 树里的 `.pbt` / `.exe`：先交给 PB 插件解析成工程工作区，再切过去。
   * pbnpm-pbd 认 PBT 和 EXE，pbnpm 只认 PBT——按顺序问，谁先成功就用谁的结果。
   */
  const openProject = async path => {
    if (openingProject) return
    setOpeningProject(path)
    setError('')
    setNotice('')
    let failure = null
    for (const endpoint of ['pbnpm-pbd-project/open', 'pbnpm-project/open']) {
      try {
        const value = unwrap(await rpc.call('/api', endpoint, { path }))
        if (!value?.path) continue
        setOpeningProject('')
        flashNotice(`已打开工程 ${baseName(value.pbtPath || path)}`)
        void scanRootsRef.current?.()
        switchRootRef.current?.(normalizePath(value.path))
        return
      } catch (cause) {
        failure = cause
      }
    }
    setOpeningProject('')
    const reason = failure ? String(failure.message || failure) : '没有安装 pbnpm / pbnpm-pbd 插件'
    setError(`${baseName(path)} 不是能打开的 PowerBuilder 工程：${reason}`)
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
   * 后续 Ctrl+S / Ctrl+Shift+B 会发给那个窗口——多开时这就是「按键跑到另一个窗口」。
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
      // 宿主也在 window 上监听快捷键（Ctrl+B 切它自己的侧栏）。VSCode 窗口吃掉按键时
      // 在捕获阶段截断，同一次按键不会既切编辑器侧栏又切宿主侧栏。
      const consume = () => {
        event.preventDefault()
        event.stopPropagation()
      }
      if (event.shiftKey) {
        if (key === 'e') { consume(); showViewRef.current('files') }
        else if (key === 'f' && !collectionRef.current) { consume(); showViewRef.current('search', true) }
        else if (key === 'h' && !collectionRef.current) {
          consume()
          showViewRef.current('search', true)
          setReplaceOpen(true)
          window.setTimeout(() => replaceInputRef.current?.focus(), 0)
        }
        else if (key === 'b') {
          // 宿主默认占用 Ctrl+B；Ctrl+Shift+B 不冲突，留作编辑器自己的侧栏开关
          consume()
          toggleSidebarRef.current()
        }
        else if (key === 'g' && !collectionRef.current) { consume(); showViewRef.current('git') }
        else if (key === 'o' && !collectionRef.current) { consume(); openPickerRef.current() }
        return
      }
      if (key === 'p' && !collectionRef.current) { consume(); openQuickRef.current(); return }
      if (key === 's' && activeIdRef.current) {
        consume()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Alt+Z：VSCode 的自动换行开关。手机默认就是开的，这条留给桌面、以及手动关掉之后再打开。
  React.useEffect(() => {
    const onKeyDown = event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'z' || pickerOpenRef.current || !ownsKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      setWrap(value => !value)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const callGit = (operation, payload = {}, signal) => Promise
    .resolve(rpc.call('/api', `world-vscode-git/${operation}`, { sessionId: session.id, root: rootPath, ...payload }, signal))
    .then(unwrap)

  const refreshGitHistory = async () => {
    const scope = gitScope
    if (!mounted.current || gitScopeRef.current !== scope) return
    const request = ++historyRequest.current
    setGitHistory(current => ({ scope, busy: true, error: '', value: current?.scope === scope ? current.value : null }))
    try {
      const value = await callGit('log')
      if (!mounted.current || gitScopeRef.current !== scope || historyRequest.current !== request) return
      setGitHistory({ scope, busy: false, error: '', value })
    } catch (cause) {
      if (!mounted.current || gitScopeRef.current !== scope || historyRequest.current !== request) return
      setGitHistory({ scope, busy: false, error: String(cause?.message || cause), value: null })
    }
  }

  /** 打开窗口时静默拉一次状态，拿到徽标数；面板里的刷新才会显示错误。 */
  const refreshGit = async ({ silent = false } = {}) => {
    if (!session?.id || !rootPath || collectionMode) return
    const idle = !gitOpRef.current
    if (idle) setGitOp('status')
    try {
      const value = await callGit('status')
      if (!mounted.current || gitScopeRef.current !== gitScope) return
      setGit(value)
      if (value?.repo) void refreshGitHistory()
      else setGitHistory(null)
    } catch (cause) {
      if (mounted.current && !silent) setGitMsg({ kind: 'error', text: String(cause?.message || cause) })
    } finally {
      if (mounted.current && idle) setGitOp('')
    }
  }
  const refreshGitRef = React.useRef(refreshGit)
  refreshGitRef.current = refreshGit

  React.useEffect(() => {
    setGit(null)
    setGitHistory(null)
    setHistoryOpen(true)
    setHistoryDetails(new Set())
    historyRequest.current++
    if (!session?.id || !rootPath || collectionMode) return
    void refreshGitRef.current({ silent: true })
  }, [session?.id, rootPath, collectionMode])

  // 换仓库后目录树都是新的，别把上一个仓库的折叠状态带过来。
  React.useEffect(() => { setGitClosed(new Set()) }, [git?.root])

  const runGit = async (operation, payload, done) => {
    if (gitOpRef.current) return
    setGitOp(operation)
    setGitMsg(null)
    try {
      const value = await callGit(operation, payload)
      if (!mounted.current || gitScopeRef.current !== gitScope) return
      if (value?.status) setGit(value.status)
      if (value?.status?.repo) void refreshGitHistory()
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
   * Git 更改行：单击打开只读 Diff 标签；同一文件 + 同一分组只留一个，
   * 再点一次就刷新——暂存 / 提交之后 patch 可能已经变了。
   */
  const openGitDiff = (file, staged) => {
    if (phone) setDrawerOpen(false)
    const id = `diff:${staged ? 'index' : 'work'}:${rootPath}:${file.path}`
    const untracked = !staged && Boolean(file.untracked)
    setTabs(current => current.some(tab => tab.id === id)
      ? current.map(tab => tab.id === id ? { ...tab, loading: true, error: '' } : tab)
      : [...current, {
        id, kind: 'diff', path: file.path, from: file.from || '', root: rootPath,
        staged, untracked, pinned: true, patch: '', truncated: false, loading: true, error: '',
      }])
    setActiveId(id)
    const seq = (diffSeq.current.get(id) || 0) + 1
    diffSeq.current.set(id, seq)
    Promise.resolve(callGit('diff', {
      paths: file.from ? [file.from, file.path] : [file.path],
      staged, untracked,
    })).then(value => {
      if (!mounted.current || diffSeq.current.get(id) !== seq) return
      setTabs(list => list.map(tab => tab.id === id
        ? { ...tab, patch: value?.patch || '', truncated: Boolean(value?.truncated), loading: false, error: '' }
        : tab))
    }).catch(cause => {
      if (!mounted.current || diffSeq.current.get(id) !== seq) return
      setTabs(list => list.map(tab => tab.id === id
        ? { ...tab, loading: false, error: String(cause?.message || cause) }
        : tab))
    })
  }

  const selectChatSession = id => {
    if (rootPath) chatPicks.current.set(rootPath, id)
    setTabs(current => current.map(tab => tab.kind === 'chat' ? { ...tab, sessionId: id } : tab))
  }

  /**
   * 打开（或切回）对话标签：优先用这个文件夹上次选中的会话，其次窗口绑定的会话，
   * 再其次这个目录最近的非空会话；都没有就留空，由标签里的「新建会话 / 历史会话」决定。
   */
  const openChatTab = () => {
    if (collectionMode || !rootPath) return
    const existing = tabsRef.current.find(tab => tab.kind === 'chat')
    if (existing) { setActiveId(existing.id); return }
    const list = sessions?.list?.getSnapshot?.()
    const rows = sessionsForFolder(list, rootPath)
    const bound = list?.byId?.[session?.id]
    const remembered = chatPicks.current.get(rootPath)
    const initial = rows.find(row => row.id === remembered)
      || rows.find(row => row.id === session?.id)
      || rows.find(row => !row.blank)
      || rows[0]
      || (bound && (!bound.cwd || sameFolder(bound.cwd, rootPath)) ? bound : null)
    setTabs(current => [...current, { id: 'chat', kind: 'chat', path: '', pinned: true, sessionId: initial?.id || '' }])
    setActiveId('chat')
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

  /**
   * 替换当前结果里的文件：单文件传 `[path]`，全部传 all。
   * 只改列表点名的文件，不重新扫全盘；有草稿的文件跳过，免得下一次保存把替换盖回去。
   */
  const performReplace = async (paths, all) => {
    const query = searchText.trim()
    if (!query) { setSearchError('请输入要搜索的内容。'); return }
    if (!session?.id || !rootPath || replacing || searchBusy) return
    if (all && (!searchResult || String(searchResult.query || '').toLowerCase() !== query.toLowerCase())) {
      setSearchError('搜索结果还没更新，稍等一下再替换。')
      return
    }
    const targets = all ? (searchResult?.files || []).map(file => file.path) : (paths || [])
    if (!targets.length) { setSearchError('没有可替换的文件。'); return }
    const dirtyPaths = tabsRef.current.filter(isDirty).map(tab => tab.path)
    const dirtyRels = new Set(dirtyPaths.map(relativeToRoot).filter(Boolean))
    const replaceable = targets.filter(path => !dirtyRels.has(path))
    if (!replaceable.length) {
      setSearchError(all ? '列表里的文件都有未保存的修改，先保存再替换。' : `「${targets[0]}」还有未保存的修改，先保存再替换。`)
      return
    }
    if (!all && dirtyRels.has(targets[0])) {
      setSearchError(`「${targets[0]}」还有未保存的修改，先保存再替换。`)
      return
    }
    if (all && !await worldConfirm({
      title: '全部替换',
      message: `在 ${replaceable.length} 个文件里把「${query}」替换为「${replaceText || '空'}」，共 ${searchResult?.total || 0} 处。这个操作不能撤销。`
        + (replaceable.length < targets.length ? `\n${targets.length - replaceable.length} 个有未保存修改的文件会被跳过。` : ''),
      confirmLabel: '全部替换',
      danger: true,
    })) return
    setReplacing(true)
    setSearchError('')
    setSearchNotice('')
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-search/replace', {
        sessionId: session.id, root: rootPath, query, replacement: replaceText,
        regex: searchFlags.regex, caseSensitive: searchFlags.caseSensitive,
        paths: replaceable, skip: dirtyPaths,
      }))
      const changed = value?.files || []
      const skipped = value?.skipped || []
      // 打开着且没有草稿的标签跟着刷新，避免之后保存时用旧内容覆盖替换结果。
      const reloadWarnings = []
      for (const file of changed) {
        const tab = tabsRef.current.find(item => relativeToRoot(item.path) === file.path)
        // 请求发出后仍可能继续输入；重读返回时再次检查草稿，不能覆盖新输入。
        if (tab && !isDirty(tab)) {
          const loaded = await loadFile(tab.id, tab.path, true, undefined, tab.root)
          if (loaded?.error?.code === 'WORLD_DESKTOP_DIRTY')
            reloadWarnings.push(`${file.path}：${loaded.error.message}`)
        }
      }
      performSearch(searchText, searchFlags)
      const resultNotice = value?.replacements
        ? `已替换 ${value.replacements} 处 · ${value.fileCount} 个文件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`
        : (skipped[0] ? `没有替换：${skipped[0].reason}` : '没有可替换的内容。')
      setSearchNotice([resultNotice, ...reloadWarnings].join('\n'))
    } catch (cause) {
      setSearchError(String(cause?.message || cause))
    } finally {
      if (mounted.current) setReplacing(false)
    }
  }

  React.useEffect(() => {
    if (sideViewRef.current !== 'search' || !session?.id) return undefined
    const timer = window.setTimeout(() => searchRef.current(searchText, searchFlags), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [searchText, searchFlags, session?.id])

  React.useEffect(() => () => { searchAbort.current?.abort() }, [])

  // 手机的抽屉只是临时状态：写回存储会把「手机上收起了侧栏」带到桌面去。
  React.useEffect(() => { if (!phone) saveSidebar({ open: desktopSidebarOpen }) }, [desktopSidebarOpen, phone])
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
    // 折行时「第 n 行 = n × 行高」不成立：量过前缀和就按前缀和居中，没量到先估一个位置，
    // 同时记下目标行，等测量 effect 量完再补一次（否则在长行文件里跳转会落在半屏之外）。
    const measured = wrapTopsRef.current
    const known = wrap && measured && actualLine <= countLines(value) && measured.length === countLines(value) + 1
    wrapRevealLine.current = wrap && !known ? actualLine : 0
    const lineTop = known ? measured[actualLine - 1] : (actualLine - 1) * lineHeight
    const top = Math.max(0, lineTop - (node.clientHeight - lineHeight) / 2)
    node.scrollTop = top
    scrollTopRef.current = node.scrollTop
    setScrollTop(node.scrollTop)
    syncCaret(node)
  }, [reveal, active?.id, active?.document, active?.path, lineHeight, wrap])

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
      sessionId: session?.id || '', rootPath, activePath: active?.kind === 'diff' || active?.kind === 'chat' ? '' : active?.path || '',
      dirty,
      loading: Boolean(busyFile), saving,
      caret: active?.document ? { line: caretLine + 1, column: caretColumn + 1 } : null,
      files: tabs.filter(tab => tab.kind !== 'diff' && tab.kind !== 'chat').map(tab => ({ path: tab.path, dirty: isDirty(tab), pinned: tab.pinned,
        active: tab.id === activeId, loading: tab.kind !== 'document' && !tab.document })),
    }),
    async openFile(command, signal) {
      signal?.throwIfAborted()
      if (pickerOpenRef.current) throw desktopError(quickOpen ? '编辑器正在搜索文件，请先完成或关闭对话框。' : '编辑器正在选择文件夹，请先完成或关闭对话框。', 'WORLD_DESKTOP_BUSY')
      const path = normalizePath(command.path)
      const existing = tabsRef.current.find(tab => tab.path === path && tab.kind !== 'diff')
      if (command.refresh && isDirty(existing)) throw desktopError('文件有未保存修改，不能重新读取并覆盖草稿。', 'WORLD_DESKTOP_DIRTY')
      const opened = await openFile(path, true, signal)
      if (!opened) throw desktopError('文件未打开。')
      let loaded = await opened.task
      signal?.throwIfAborted()
      if (loaded?.error) throw loaded.error
      if (isDocumentPreviewPath(path)) {
        if (command.refresh) setTabs(list => list.map(tab => tab.id === opened.id
          ? { ...tab, previewRevision: (tab.previewRevision || 0) + 1 } : tab))
        await waitForDesktop(() => tabsRef.current.some(tab => tab.id === opened.id && tab.kind === 'document'), signal)
        return { path, preview: true, refreshed: command.refresh === true }
      }
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
  // 行号槽宽度跟着位数走：5 位行号还能塞进 52px，6 位就会被裁掉。
  // 手机上是小一号字（11px），槽也收窄一档——360px 里 46px 的槽太奢侈。
  const gutterDigits = String(lineCount).length
  const gutterWidth = phone
    ? Math.max(26, 12 + Math.ceil(gutterDigits * 6.9))
    : Math.max(46, 20 + gutterDigits * 8)
  // 折行时行号靠量出来的前缀和定位；没量到（或长度对不上＝刚切了文件）就先不画，
  // 免得整列数字按 n × 行高 排一遍再跳。
  const tops = wrap && wrapTops && wrapTops.length === lineCount + 1 ? wrapTops : null
  const firstLine = tops
    ? Math.max(0, lineAtTop(tops, scrollTop) - OVERSCAN)
    : Math.max(0, Math.floor(scrollTop / lineHeight) - OVERSCAN)
  const wrapLines = []
  if (tops) {
    for (let index = firstLine; index < lineCount; index++) {
      if (tops[index] - scrollTop > viewportHeight + OVERSCAN * lineHeight) break
      wrapLines.push(index)
    }
  }
  const visibleCount = tops
    ? wrapLines.length
    : Math.max(0, Math.min(lineCount - firstLine, Math.ceil(viewportHeight / lineHeight) + OVERSCAN * 2))
  const gutterRows = []
  for (let index = 0; index < visibleCount; index++) gutterRows.push(firstLine + index + 1)
  const gutterOffset = firstLine * lineHeight - scrollTop
  // 切文件的一瞬间 caretLine 可能还停在上一份文件的行号上：下标先夹住，否则 tops 取到 undefined
  const caretSafe = Math.max(0, Math.min(caretLine, lineCount - 1))

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
      // 折行时这一层不再靠 translateY 整体滚动：每行按测量出的顶边各就各位，
      // 行里的 token 自己按 pre-wrap 折行（同字体同宽度，断行点与镜像层一致）。
      // 空行在 pre-wrap 里没有内容就没有高度（镜像层也是塞零宽字符量到的），
      // 这里少一个字形，行号与高亮就会从这一行起错开一行。
      const children = tokens.length
        ? tokens.map((token, order) => token.type === 'punc'
          ? token.text
          : h('span', { key: order, className: `world-vscode-tok-${token.type}` }, token.text))
        : ['\u200b']
      return h('div', {
        key: index,
        className: `world-vscode-hl-line${tops ? ' is-wrap' : ''}`,
        style: tops ? { top: `${tops[index] - scrollTop}px` } : undefined,
      }, children)
    })
    : null
  /**
   * 折行时只有量到前缀和才敢把 textarea 的文字变透明：没量到就透明，整篇字会凭空消失。
   * 宽度同理——没有 `wrapWidth` 那层会按容器宽折一遍，颜色整片错开一帧。
   * 输入法组字期间也退回来（候选串只在 textarea 里，透明了打字的人看不见自己在打什么）。
   */
  const highlightReady = Boolean(highlightRows) && (!wrap || Boolean(tops && wrapWidth)) && !composing

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

  /**
   * 手机底部「视图」菜单的一行：图标 + 名字 + 变更数角标，当前打开的视图打勾。
   * 再点当前项＝收起抽屉（和桌面上点活动栏同一个心智模型）。
   */
  const phoneMenuRow = (id, icon, label, badge) => h('button', {
    type: 'button', role: 'menuitemradio', 'aria-checked': Boolean(sidebarOpen && sideView === id),
    className: `world-vscode-phone-row${sidebarOpen && sideView === id ? ' is-active' : ''}`,
    onClick: () => {
      setPhoneMenuOpen(false)
      if (sidebarOpen && sideView === id) { setDrawerOpen(false); return }
      setSideView(id)
      setDrawerOpen(true)
    },
  },
  h('span', { className: 'world-vscode-phone-row-icon' }, icon),
  h('span', { className: 'world-vscode-phone-row-label' }, label),
  badge ? h('i', { className: 'world-vscode-phone-row-badge' }, badge > 99 ? '99+' : String(badge)) : null,
  sidebarOpen && sideView === id ? h('span', { className: 'world-vscode-phone-row-check', 'aria-hidden': true }, '●') : null)

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
    const fresh = Boolean(result) && String(result.query || '').toLowerCase() === query.toLowerCase()
    const canReplace = Boolean(query) && Boolean(result?.files.length) && fresh && !searchBusy && !replacing
    const summary = searchError ? ''
      : searchBusy ? '搜索中…'
        : !query ? `在 ${baseName(rootPath)} 中搜索`
          : result ? (result.total ? `${result.total} 个结果 · ${result.fileCount} 个文件` : '0 个结果')
            : ''
    return h('div', { className: 'world-vscode-search' },
      h('div', { className: 'world-vscode-search-box' },
        h('button', {
          type: 'button', className: `world-vscode-search-toggle${replaceOpen ? ' is-open' : ''}`,
          title: '切换替换 (Ctrl+Shift+H)', 'aria-label': '切换替换', 'aria-expanded': replaceOpen,
          onClick: () => {
            setReplaceOpen(open => !open)
            if (!replaceOpen) window.setTimeout(() => replaceInputRef.current?.focus(), 0)
          },
        }, h(ReplaceToggleIcon, { open: replaceOpen })),
        h('span', { className: 'world-vscode-search-glyph' }, h(SearchIcon, { size: 14 })),
        h('input', {
          ref: searchInputRef,
          className: 'world-vscode-search-input', value: searchText, spellCheck: false,
          placeholder: '搜索工作区', 'aria-label': '搜索工作区中的文本',
          onChange: event => { setSearchText(event.target.value); setSearchNotice('') },
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
      replaceOpen ? h('div', { className: 'world-vscode-search-box is-replace' },
        h('span', { className: 'world-vscode-search-glyph' }, h(ReplaceIcon, { size: 14 })),
        h('input', {
          ref: replaceInputRef,
          className: 'world-vscode-search-input', value: replaceText, spellCheck: false,
          placeholder: searchFlags.regex ? '替换为（可用 $1 捕获组）' : '替换为',
          'aria-label': '替换为',
          onChange: event => setReplaceText(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') { event.preventDefault(); void performReplace(null, true) }
          },
        }),
        h('button', {
          type: 'button', className: 'world-vscode-search-replace-all',
          title: '全部替换', 'aria-label': '全部替换',
          disabled: !canReplace, onClick: () => void performReplace(null, true),
        }, h(ReplaceIcon, { size: 15 }))) : null,
      h('div', { className: 'world-vscode-search-summary', role: 'status' },
        searchBusy || replacing ? h('i', { className: 'world-vscode-search-spin' }) : null,
        h('span', null, replacing ? '替换中…' : summary),
        result?.truncated ? h('span', { className: 'world-vscode-search-note' }, '结果过多，已截断') : null),
      searchNotice ? h('div', { className: 'world-vscode-search-notice', role: 'status' }, searchNotice) : null,
      searchError ? h('div', { className: 'world-vscode-error' }, searchError) : null,
      h('div', { className: 'world-vscode-search-list' },
        !result
          ? !searchError && h('div', { className: 'world-vscode-search-hint' },
            h(SearchIcon, { size: 28 }),
            h('span', null, query ? '按 Enter 立即搜索' : '输入关键词搜索文件内容；按 Ctrl+P 搜索文件名。'))
          : result.files.length === 0
            ? h('div', { className: 'world-vscode-search-empty' },
              h(SearchIcon, { size: 28 }),
              h('span', null, `没有与 “${query}” 匹配的内容。`),
              h('small', null, '试试更短的词，或关掉区分大小写。'))
            : result.files.map(file => {
              const open = searchOpen.has(file.path)
              return h('div', { key: file.path, className: 'world-vscode-search-file' },
                h('div', { className: 'world-vscode-search-file-row' },
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
                  replaceOpen ? h('button', {
                    type: 'button', className: 'world-vscode-search-file-replace',
                    title: `在 ${file.path} 中替换`, 'aria-label': `在 ${file.path} 中替换`,
                    disabled: !canReplace, onClick: () => void performReplace([file.path], false),
                  }, h(ReplaceIcon, { size: 13 })) : null),
                open ? file.matches.map(match => h('button', {
                  key: `${match.line}:${match.column}`, type: 'button', className: 'world-vscode-search-hit',
                  title: `${file.path}:${match.line}`, onClick: () => revealHit(file.path, match),
                },
                h('span', { className: 'world-vscode-search-line' }, match.line),
                h('span', { className: 'world-vscode-search-text' },
                  match.prefix ? '…' : null, markedText(match), match.suffix ? '…' : null))) : null)
            })))
  }

  /** 批处理运行时占满编辑器正文：输出比代码更需要空间；标签栏、状态栏仍保留。 */
  const batchPanel = () => h('section', { className: 'world-vscode-output', 'aria-label': '批处理输出' },
    h('div', { className: 'world-vscode-output-head' },
      h('span', { className: 'world-vscode-output-title', title: batchRun.path }, `输出 · ${baseName(batchRun.path)}`),
      h('span', { className: 'world-vscode-output-state' },
        batchRun.running ? '运行中…'
          : batchRun.error ? batchRun.error
            : batchRun.cancelled ? '已停止'
              : batchRun.exitCode === null ? '已结束' : `退出码 ${batchRun.exitCode}`,
        batchRun.durationMs ? ` · ${(batchRun.durationMs / 1000).toFixed(1)}s` : ''),
      h('div', { className: 'world-vscode-output-actions' },
        h('button', { type: 'button', onClick: () => void collapseBatchPanel() }, '收起'),
        batchRun.running ? h('button', { type: 'button', onClick: () => void cancelBatch() }, '停止') : null,
        h('button', { type: 'button', 'aria-label': '关闭输出', onClick: () => void closeBatchPanel() }, '关闭'))),
    h('pre', { ref: batchOutputRef, className: 'world-vscode-output-text' },
      batchRun.text || (batchRun.running ? '正在启动…' : '没有输出。')))

  const toggleGitDir = key => setGitClosed(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  /** 一条更改：单击看 Diff，双击打开源码；右侧按钮暂存 / 取消暂存（悬停才出现）。 */
  const gitRow = (file, staged, depth) => {
    const letter = fileState(file, staged)
    return h('div', {
      key: `${staged ? 's' : 'w'}:${file.path}`,
      className: 'world-vscode-git-file', role: 'button', tabIndex: 0,
      style: { paddingLeft: 10 + depth * 14 },
      title: `${file.from ? `${file.from} → ` : ''}${file.path} · 单击查看 Diff，双击打开源码`,
      onClick: () => openGitDiff(file, staged),
      onDoubleClick: event => {
        if (event.target.closest?.('.world-vscode-git-act')) return
        openGitFile(file)
      },
      onKeyDown: event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openGitDiff(file, staged)
      },
    },
    h(TwistSpacer),
    h('span', { className: `world-vscode-tab-icon ${entryIconClass(baseName(file.path))}` }, h(FileIcon)),
    h('span', { className: 'world-vscode-git-name' }, baseName(file.path)),
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

  /**
   * 目录行：点行折叠 / 展开，右侧按钮把整个目录一次暂存 / 取消暂存。
   * 手机没有 hover，所以目录的批量键不像文件行那样藏着。
   */
  const gitDirRow = (node, staged, depth, parentPath) => {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name
    const key = `${staged ? 's' : 'w'}:${path}`
    const open = !gitClosed.has(key)
    const paths = gitTreePaths(node)
    const label = `${staged ? '取消暂存' : '暂存'} ${path} 下的 ${paths.length} 个更改`
    return h('div', {
      key, className: `world-vscode-git-file is-dir${open ? ' is-open' : ''}`,
      role: 'button', tabIndex: 0,
      style: { paddingLeft: 10 + depth * 14 },
      title: `${path} · ${paths.length} 个更改`, 'aria-expanded': open,
      onClick: () => toggleGitDir(key),
      onKeyDown: event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        toggleGitDir(key)
      },
    },
    h(Twist, { open }),
    h('span', { className: 'world-vscode-tab-icon is-dir' }, h(FolderIcon, { open })),
    h('span', { className: 'world-vscode-git-name' }, node.name),
    h('button', {
      type: 'button', className: 'world-vscode-git-act',
      title: label, 'aria-label': label, disabled: Boolean(gitOp),
      onClick: event => {
        event.stopPropagation()
        void runGit(staged ? 'unstage' : 'stage', { paths }, staged ? '已取消暂存' : '已暂存')
      },
    }, h(StageIcon, { undo: staged })))
  }

  /** 目录先、文件后，各自按名字排序；折叠的目录只留自己那一行。 */
  const gitTreeRows = (node, staged, depth, parentPath) => {
    const rows = []
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = parentPath ? `${parentPath}/${dir.name}` : dir.name
      rows.push(gitDirRow(dir, staged, depth, parentPath))
      if (!gitClosed.has(`${staged ? 's' : 'w'}:${path}`))
        rows.push(...gitTreeRows(dir, staged, depth + 1, path))
    }
    for (const file of [...node.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path))))
      rows.push(gitRow(file, staged, depth))
    return rows
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
    gitTreeRows(buildGitTree(list), staged, 0, ''))

  /** 只读统一 Diff：双行号 + 红绿行；超大补丁只渲染前 DIFF_RENDER_LIMIT 行。 */
  const diffEditor = tab => {
    if (tab.loading) return h('div', { className: 'world-vscode-loading' },
      h('i', { className: 'world-vscode-loading-spin' }),
      h('span', null, `正在读取 ${baseName(tab.path)} 的 Diff…`))
    if (tab.error) return h('div', { className: 'world-vscode-diff-message is-error' },
      h('strong', null, 'Diff 读取失败'),
      h('span', null, tab.error),
      h('small', null, '点一下源代码管理里的这个文件可重试。'))
    const rows = diffLines(tab.patch)
    if (!rows.length) return h('div', { className: 'world-vscode-diff-message' },
      h('strong', null, '没有可显示的差异'),
      h('small', null, tab.untracked ? '这个文件是空的。' : '索引 / 工作区里这份文件没有文本变化。'))
    const added = rows.reduce((count, row) => count + (row.kind === 'add' ? 1 : 0), 0)
    const removed = rows.reduce((count, row) => count + (row.kind === 'del' ? 1 : 0), 0)
    const shown = rows.slice(0, DIFF_RENDER_LIMIT)
    const scope = tab.staged ? '已暂存' : tab.untracked ? '未跟踪' : '工作区'
    return h('div', {
      className: 'world-vscode-diff', role: 'region',
      'aria-label': `${baseName(tab.path)} 的 Diff（${scope}）`,
    },
    h('div', { className: 'world-vscode-diff-head' },
      h('span', { className: 'world-vscode-diff-title', title: tab.path }, baseName(tab.path)),
      h('span', { className: 'world-vscode-diff-scope' }, scope),
      h('span', { className: 'world-vscode-diff-stat' },
        h('i', { className: 'is-add' }, `+${added}`), ' ', h('i', { className: 'is-del' }, `−${removed}`)),
      tab.from ? h('span', { className: 'world-vscode-diff-path', title: `${tab.from} → ${tab.path}` }, `${tab.from} → ${tab.path}`) : null,
      tab.truncated ? h('span', { className: 'world-vscode-diff-note' }, '补丁过长，已截断') : null),
    h('div', { className: 'world-vscode-diff-scroll' },
      h('div', { className: 'world-vscode-diff-rows' },
        shown.map((row, index) => h('div', {
          key: index, className: `world-vscode-diff-line is-${row.kind}`,
        },
        h('span', { className: 'world-vscode-diff-num' }, row.old ?? ''),
        h('span', { className: 'world-vscode-diff-num' }, row.new ?? ''),
        h('span', { className: 'world-vscode-diff-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''),
        h('span', { className: 'world-vscode-diff-text' }, row.text || '\u200b')))),
      rows.length > shown.length
        ? h('div', { className: 'world-vscode-diff-more' }, `Diff 过长，只渲染前 ${DIFF_RENDER_LIMIT} 行。`)
        : null))
  }

  const gitHistoryPanel = () => {
    const current = gitHistory?.scope === gitScope ? gitHistory : null
    const commits = current?.value?.commits || []
    return h('section', { className: 'world-vscode-git-history', 'aria-label': '最近提交' },
      h('button', {
        type: 'button', className: 'world-vscode-git-group-head world-vscode-git-history-toggle',
        'aria-expanded': historyOpen, onClick: () => setHistoryOpen(open => !open),
      }, h(Twist, { open: historyOpen }), h('span', null, '最近提交'),
      h('span', { className: 'world-vscode-git-count' }, commits.length ? String(commits.length) : '')),
      historyOpen ? h('div', { className: 'world-vscode-git-history-list' },
        current?.busy && current.value ? h('div', { className: 'world-vscode-git-note', role: 'status' }, '正在读取提交历史…') : null,
        !current || (current.busy && !current.value) ? h('div', { className: 'world-vscode-git-note', role: 'status' }, '正在读取提交历史…')
          : current.error ? h('div', { className: 'world-vscode-git-note', role: 'alert' }, '读取提交历史失败：' + current.error)
            : commits.length === 0 ? h('div', { className: 'world-vscode-git-note' }, current.value?.truncated ? '提交历史输出过长，未显示不完整记录。' : '暂无提交')
              : commits.map(commit => {
                const open = historyDetails.has(commit.hash)
                return h('div', { key: commit.hash, className: 'world-vscode-git-commit' },
                  h('button', {
                    type: 'button', className: 'world-vscode-git-history-row', title: commit.subject,
                    'aria-expanded': open, onClick: () => setHistoryDetails(current => {
                      const next = new Set(current)
                      if (next.has(commit.hash)) next.delete(commit.hash)
                      else next.add(commit.hash)
                      return next
                    }),
                  }, h(Twist, { open }), h('code', null, commit.shortHash),
                  h('span', { className: 'world-vscode-git-name' }, commit.subject)),
                  open ? h('div', { className: 'world-vscode-git-note world-vscode-git-history-detail' },
                    h('div', null, '作者：', commit.author),
                    h('div', null, '提交时间：', commit.date ? new Date(commit.date).toLocaleString() : '—'),
                    h('div', null, 'Hash：', h('code', null, commit.hash)),
                    h('pre', null, commit.body || commit.subject)) : null)
              }),
        current?.value?.truncated && !current.busy ? h('div', { className: 'world-vscode-git-note' }, '仅显示最近 20 条提交；输出过长时只显示完整记录。') : null) : null)
  }

  const gitPanel = () => h('div', { className: 'world-vscode-git' },
    h('div', { className: 'world-vscode-git-branch' },
      h('span', { className: 'world-vscode-git-branch-icon' }, h(BranchIcon)),
      h('span', { className: 'world-vscode-git-branch-name', title: git?.root || '' },
        !rootPath ? '先打开文件夹' : !git ? '读取中…' : git.repo ? (git.branch || 'HEAD') : '未检测到仓库'),
      git?.ahead ? h('span', { className: 'world-vscode-git-track is-ahead', title: `领先上游 ${git.ahead} 个提交` }, `↑${git.ahead}`) : null,
      git?.behind ? h('span', { className: 'world-vscode-git-track is-behind', title: `落后上游 ${git.behind} 个提交` }, `↓${git.behind}`) : null,
      h('button', {
        type: 'button', className: 'world-vscode-git-refresh', title: '刷新 Git 状态',
        'aria-label': '刷新 Git 状态', disabled: !rootPath || Boolean(gitOp), onClick: () => void refreshGit(),
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
              git.truncated ? h('div', { className: 'world-vscode-git-note' }, `更改过多，只显示前 ${changedFiles.length} 个。`) : null),
      git?.repo ? gitHistoryPanel() : null))

  /** 侧栏与「打开文件夹」共用的插件位置：IMA 一个整体，PB 工程逐个列出。 */
  const pluginRootItems = React.useMemo(() => {
    const items = []
    const ima = pluginRoots?.ima
    if (ima && typeof ima.path === 'string' && ima.path) {
      items.push({
        id: 'ima', kind: 'ima', label: ima.label || 'IMA', path: normalizePath(ima.path),
        note: ima.available ? '知识库 · 笔记 · 记忆' : '未授权',
        disabled: !ima.available, title: ima.error || 'IMA 当前不可用',
      })
    }
    for (const project of pluginRoots?.projects || []) {
      if (!project || typeof project.root !== 'string' || !project.root) continue
      items.push({
        id: project.id, kind: project.kind === 'exe' ? 'exe' : 'pbt', label: project.name,
        path: normalizePath(project.root),
        note: `PB${project.pbVersion ?? '?'} · ${project.libraries}库`,
      })
    }
    return items
  }, [pluginRoots])

  /** 模态目录选择器：只列子目录，路径与「上一级」在顶部。 */
  const pickerDialog = () => {
    const current = picker
    const disabled = !current?.path || Boolean(current?.busy) || Boolean(current?.error)
    const recentItems = recentFolders.filter(path => path !== rootPath)
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
      // 最近打开 / 插件位置 / 子目录都放进同一个可滚动区：历史再多也只滚中间，
      // 底部的「取消 / 在新窗口打开 / 打开」始终留在对话框里。
      h('div', { className: 'world-vscode-picker-body' },
        recentItems.length ? h('div', { className: 'world-vscode-picker-recent' },
          h('span', { className: 'world-vscode-picker-roots-head' }, '最近打开'),
          h('div', { className: 'world-vscode-picker-recent-list' },
            recentItems.map(path => h('button', {
              key: path, type: 'button', className: 'world-vscode-picker-recent-row',
              title: nativePath(path),
              onClick: () => { closePicker(); void switchRoot(path) },
            }, h('span', { className: 'world-vscode-picker-root-icon is-recent' }, h(FolderIcon, { open: false })),
            h('span', { className: 'world-vscode-picker-root-name' }, baseName(path)),
            h('span', { className: 'world-vscode-picker-root-note' }, nativePath(dirName(path) || path)))))) : null,
        pluginRootItems.length ? h('div', { className: 'world-vscode-picker-roots' },
          h('span', { className: 'world-vscode-picker-roots-head' }, '插件位置'),
          h('div', { className: 'world-vscode-picker-roots-list' },
            pluginRootItems.map(item => h('button', {
              key: item.id, type: 'button',
              className: `world-vscode-picker-root is-${item.kind}`,
              disabled: item.disabled,
              title: item.disabled ? `${item.title} · ${nativePath(item.path)}` : nativePath(item.path),
              onClick: () => {
                if (item.disabled) return
                closePicker()
                switchRoot(item.path)
              },
            }, h('span', { className: 'world-vscode-picker-root-icon is-' + item.kind }, h(FolderIcon, { open: false })),
            h('span', { className: 'world-vscode-picker-root-name' }, item.label),
            h('span', { className: 'world-vscode-picker-root-note' }, item.note))))) : null,
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
          current?.truncated ? h('div', { className: 'world-vscode-picker-note' }, '子文件夹过多，只显示前 2000 个。') : null)),
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
    // 双击标题栏 = 最大化 / 还原，和桌面其它窗口一致；点按钮不触发。手机上窗口本来就满屏
    onDoubleClick: event => { if (!phone && !event.target.closest('button')) onToggleMaximize?.() },
  },
    h('div', { className: 'world-vscode-title' }, h(VscodeGlyph, { size: 16 }),
      h('span', null, active ? `${baseName(active.path)} — ${displayName}` : `Visual Studio Code — ${displayName}`)),
    h('div', { className: 'world-vscode-title-actions' },
      !collectionMode && h('button', {
        type: 'button', className: 'world-vscode-title-btn', title: '打开文件夹 (Ctrl+Shift+O)',
        'aria-label': '打开文件夹', onClick: openPicker,
      }, h(FolderIcon, { open: true })),
      !collectionMode && h('button', {
        type: 'button', className: 'world-vscode-title-btn',
        title: rootPath ? '对话 · 与当前文件夹的 dsh 会话聊天' : '先打开一个文件夹',
        'aria-label': '打开对话', disabled: !rootPath, onClick: openChatTab,
      }, h(ChatIcon)),
      active && isBatchPath(active.path) && h('button', {
        type: 'button', className: 'world-vscode-title-btn',
        title: batchStarting ? '正在启动批处理…' : '运行批处理', 'aria-label': '运行批处理',
        'aria-busy': batchStarting, disabled: batchStarting || Boolean(batchRun?.running), onClick: () => void runBatch(active.path),
      }, h(RunIcon))),
    h('span', { className: 'world-vscode-title-sep', 'aria-hidden': true }),
    h('div', { className: 'world-vscode-controls world-vscode-caps' },
      // 钉住 = 始终置顶：失去焦点也压在未钉住窗口之上，再点一次取消。
      phone ? null : h('button', {
        type: 'button', className: `world-pin-cap${pinned ? ' is-pinned' : ''}`,
        title: pinLabel(pinned), 'aria-label': pinLabel(pinned), 'aria-pressed': pinned,
        onClick: onTogglePin,
      }, h(PinGlyph, { size: 12, filled: pinned })),
      // 手机上窗口已经铺满整屏：最小化 / 最大化既没有可去的地方，又白占 88px 标题栏
      phone ? null : h('button', { type: 'button', title: '最小化', 'aria-label': '最小化 Visual Studio Code', onClick: onMinimize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
      phone ? null : h('button', {
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
    // 手机上不挂活动栏：它那一列图标全收进状态栏左端的「视图」按钮（底部弹出菜单），
    // 正文因此拿回整整 40px 宽。
    phone ? null : h('nav', { className: 'world-vscode-activity', 'aria-label': '活动栏' },
      activityButton('files', h(ExplorerIcon, { size: 20 }), '资源管理器', 0, 'Ctrl+Shift+E'),
      !collectionMode && activityButton('search', h(SearchIcon, { size: 20 }), '搜索', 0, 'Ctrl+Shift+F'),
      !collectionMode && activityButton('git', h(SourceControlIcon, { size: 20 }), '源代码管理', changedFiles.length, 'Ctrl+Shift+G'),
      h('div', { className: 'world-vscode-activity-gap' }),
      h('button', {
        type: 'button', className: `world-vscode-activity-btn is-collapse${sidebarOpen ? '' : ' is-off'}`,
        title: sidebarOpen ? '收起侧栏 (Ctrl+Shift+B)' : '展开侧栏 (Ctrl+Shift+B)',
        'aria-label': sidebarOpen ? '收起侧栏' : '展开侧栏',
        onClick: toggleSidebar,
      }, h('span', { className: 'world-vscode-activity-icon' }, h(SidebarIcon)))),
    sidebarOpen && phone
      ? h('div', {
        className: 'world-vscode-scrim', 'aria-hidden': true,
        // 抽屉盖住正文时，点正文＝收起（手机上唯一的「点空白返回」手势）
        onPointerDown: event => { event.preventDefault(); setDrawerOpen(false) },
      })
      : null,
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
                onClick: () => rootPath || collectionMode ? toggleDir(treeRoot) : openPicker(),
                onContextMenu: collectionMode || !rootPath ? undefined : event => openFileMenu(event, rootPath),
              }, h(Twist, { open: expanded.has(treeRoot) }), h(FolderIcon, { open: expanded.has(treeRoot) }),
              h('span', { className: 'world-vscode-root-name' }, collectionMode ? displayName.toUpperCase() : displayName)),
              expanded.has(treeRoot) && rootEntries.map(entry => h(TreeNode, {
                key: entry.path || entry.name, parent: treeRoot, entry, depth: 1, expanded, tree, selected: active?.path,
                onToggle: toggleDir, onOpen: openFile, onPin: path => openFile(path, true), onMenu: openFileMenu,
                onOpenProject: openProject,
              })),
              busyDir && h('div', { className: 'world-vscode-file-note' }, '正在读取目录…'),
              busyFile && h('div', { className: 'world-vscode-file-note' }, '正在打开文件…'),
              error && h(ErrorNote, {
                text: error, onDismiss: () => setError(''),
                onCopied: copied => flashNotice(copied ? '错误原文已复制' : '复制失败：当前环境不允许访问剪贴板。'),
              }),
              rootEntries.length === 0 && !busyDir && !error && h('div', { className: 'world-vscode-file-note' }, rootPath || collectionMode ? '此目录为空' : '尚未选择文件夹'),
              pluginRootItems.length && !collectionMode ? h('div', { className: 'world-vscode-roots' },
                h('div', { className: 'world-vscode-roots-head' }, '插件位置'),
                pluginRootItems.map(item => h('button', {
                  key: item.id, type: 'button',
                  className: `world-vscode-root-entry is-${item.kind}${item.disabled ? ' is-disabled' : ''}${!item.disabled && item.path === rootPath ? ' is-current' : ''}`,
                  title: item.disabled ? `${item.title || '当前不可用'} · ${nativePath(item.path)}` : nativePath(item.path),
                  disabled: item.disabled,
                  onClick: () => { setError(''); switchRoot(item.path) },
                },
                h('span', { className: `world-vscode-root-icon is-${item.kind}` }, h(FolderIcon, { open: false })),
                h('span', { className: 'world-vscode-file-name' }, item.label),
                h('span', { className: 'world-vscode-root-note' }, item.note)))) : null),
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
        tabs.map(tab => {
          const chat = tab.kind === 'chat'
          const label = chat ? '对话' : baseName(tab.path)
          return h('div', {
          key: tab.id,
          ref: tab.id === activeId ? activeTabRef : null,
          role: 'tab',
          'aria-selected': tab.id === activeId,
          tabIndex: tab.id === activeId ? 0 : -1,
          className: `world-vscode-tab${tab.id === activeId ? ' active' : ''}${tab.pinned ? ' is-pinned' : ' preview'}${tab.kind === 'diff' ? ' is-diff' : ''}${chat ? ' is-chat' : ''}${isDirty(tab) ? ' is-dirty' : ''}`,
          title: chat
            ? '与当前 dsh 会话对话'
            : tab.kind === 'diff'
              ? `${tab.path} · ${tab.staged ? '已暂存' : tab.untracked ? '未跟踪' : '工作区'} Diff`
              : tab.pinned ? tab.path : `${tab.path} · 预览标签（在文件树双击可锁定）`,
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
        h('span', { className: `world-vscode-tab-icon ${chat ? 'is-chat' : entryIconClass(baseName(tab.path))}` },
          chat ? h(ChatIcon) : h(FileIcon)),
        tab.kind === 'diff' ? h('i', { className: 'world-vscode-tab-diffmark', 'aria-hidden': true }, '±') : null,
        h('span', { className: 'world-vscode-tab-name' }, label),
        isDirty(tab) ? h('i', { className: 'world-vscode-tab-dirty', title: '未保存' }, '●') : null,
        h('button', {
          type: 'button', className: 'world-vscode-tab-close', tabIndex: -1,
          'aria-label': `关闭标签 ${label}`, title: '关闭标签',
          onClick: event => { event.stopPropagation(); closeTab(tab.id) },
        }, '×'))
        })),
      ...tabs.filter(tab => tab.kind === 'document').map(tab => h('div', {
        key: `document:${tab.id}:${tab.path}:${tab.previewRevision || 0}`, className: 'world-vscode-document',
        'data-world-document': tab.path, style: { display: activeId === tab.id && !(batchRun && !batchCollapsed) ? 'flex' : 'none' },
      }, h(NativeDocument, {
        path: tab.path, sessionId: session?.id, sessions, SessionProvider, renderSlot,
        visible: activeId === tab.id && isActive && !minimized,
        onOpen: path => openFile(path, true), onClose: () => closeTab(tab.id),
      }))),
      batchRun && !batchCollapsed ? batchPanel()
        : active?.kind === 'document' ? null
        : active?.kind === 'chat'
        ? h(VscodeChat, {
          active: isActive, sessionId: active.sessionId, boundSessionId: session?.id, rootPath, rpc,
          sessions, SessionProvider, renderSlot, conversationSeat,
          onSelectSession: selectChatSession,
        })
        : active?.kind === 'diff'
        ? diffEditor(active)
        : active?.document
          ? h('div', {
          className: `world-vscode-editor-content${wrap ? ' is-wrap' : ''}`,
          style: {
            '--vscode-gutter': `${gutterWidth}px`,
            '--vscode-line-height': `${lineHeight}px`,
            '--vscode-font-size': `${phone ? FONT_SIZE_PHONE : 13}px`,
          },
        },
          // 折行时一段逻辑行可能铺开好几行视觉行：底纹跟着 tops 走，高度取整段
          tops || !wrap
            ? h('div', {
              // 焦点在侧栏时底色淡一点：位置还在，但不和编辑器抢注意力
              className: `world-vscode-active-line${editing ? '' : ' is-dim'}`, 'aria-hidden': true,
              style: {
                transform: `translateY(${(tops ? tops[caretSafe] : caretLine * lineHeight) - scrollTop}px)`,
                height: tops ? `${tops[caretSafe + 1] - tops[caretSafe]}px` : undefined,
              },
            })
            : null,
          h('div', { className: 'world-vscode-gutter', 'aria-hidden': true },
            tops
              ? h('div', { className: 'world-vscode-gutter-rows is-absolute' },
                wrapLines.map(index => h('div', {
                  key: index,
                  className: `world-vscode-gutter-row is-absolute${index === caretLine ? ' is-active' : ''}`,
                  // 折行的行各自顶边不同：逐条绝对定位，数字仍然贴在各自第一行视觉行上
                  style: { top: `${tops[index] - scrollTop}px`, height: `${tops[index + 1] - tops[index]}px` },
                }, index + 1)))
              // 折行但还没量到（刚切文件那一帧）：槽留着、不画数字，正文就不会左右跳一下
              : wrap
                ? null
                : h('div', {
                  className: 'world-vscode-gutter-rows',
                  style: { transform: `translateY(${gutterOffset}px)` },
                }, gutterRows.map(number => h('div', {
                  key: number,
                  className: `world-vscode-gutter-row${number === caretLine + 1 ? ' is-active' : ''}`,
                }, number)))),
          // 折行时得有个不可见的镜像层来量「每行折成几行」（见上面的测量 effect）
          wrap ? h('div', { ref: measureRef, className: 'world-vscode-measure', 'aria-hidden': true }) : null,
          highlightReady
            ? h('div', {
              ref: highlightRef,
              className: `world-vscode-highlight${wrap ? ' is-wrap' : ''}`, 'aria-hidden': true,
              // 折行层的宽度必须与镜像层逐像素相等（它俩都要减掉滚动条和右内边距）
              style: wrap && wrapWidth ? { width: `${wrapWidth}px` } : undefined,
            },
            h('div', {
              className: 'world-vscode-highlight-rows',
              // 折行时每行自己带 top（已含 -scrollTop），整层不再位移
              style: wrap ? undefined : { transform: `translate(${-scrollLeft}px, ${gutterOffset}px)` },
            }, highlightRows))
            : null,
          h('textarea', {
            key: `${active.id}:${active.path}:${active.reload || 0}`, ref: textareaRef,
            className: `world-vscode-textarea${highlightReady ? ' is-highlight' : ''}${wrap ? ' is-wrap' : ''}`,
            'aria-label': `编辑 ${baseName(active.path)}`,
            readOnly: Boolean(active.document.readOnly),
            spellCheck: false, wrap: wrap ? 'soft' : 'off', defaultValue: active.draft,
            onScroll: onEditorScroll,
            // 组字期间退回原生文字（高亮层同时让位），否则中文候选串是透明的
            onCompositionStart: () => setComposing(true),
            onCompositionEnd: () => setComposing(false),
            onSelect: event => syncCaret(event.currentTarget),
            onFocus: event => { setEditing(true); syncCaret(event.currentTarget) },
            onBlur: () => setEditing(false),
            onClick: event => syncCaret(event.currentTarget),
            onChange: event => {
              if (active.document.readOnly) return
              const value = event.target.value
              // 一旦改动就锁定标签，避免下一次点文件时被预览标签顶掉、还弹一次确认
              setTabs(list => list.map(tab => tab.id === active.id ? { ...tab, draft: value, pinned: true } : tab))
              // 打字后光标也动了：不跟一下，状态栏的行列会停在打字前
              syncCaret(event.target)
              setNotice('')
            },
            onKeyDown: event => {
              if (active.document.readOnly || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
            // 手机上没有 Ctrl / Shift / Tab，这几条提示既按不出来也挤不进 360px：
            // 折叠成三行后还会被状态栏裁掉。手机上只留上面那句「单击预览、双击锁定」。
            !phone && (rootPath || collectionMode) ? h('div', { className: 'world-vscode-welcome-keys' },
              keyHint(['Ctrl', 'S'], '保存'),
              !collectionMode && keyHint(['Ctrl', 'P'], '搜索文件'),
              keyHint(['Ctrl', 'Shift', 'B'], '侧栏'),
              !collectionMode && keyHint(['Ctrl', 'Shift', 'F'], '搜索'),
              !collectionMode && keyHint(['Ctrl', 'Shift', 'O'], '打开文件夹'),
              keyHint(['Tab'], '缩进'),
              keyHint(['Shift', 'Tab'], '反缩进')) : null)),
    phone && phoneMenuOpen
      ? h(React.Fragment, null,
        h('div', {
          className: 'world-vscode-phone-scrim', 'aria-hidden': true,
          // 透明遮罩：点正文任意处先关菜单，别顺手把光标插到别处
          onPointerDown: event => { event.preventDefault(); setPhoneMenuOpen(false) },
        }),
        h('div', { className: 'world-vscode-phone-menu', role: 'menu', 'aria-label': '视图' },
          h('div', { className: 'world-vscode-phone-menu-title' }, '视图'),
          phoneMenuRow('files', h(ExplorerIcon, { size: 18 }), '资源管理器', 0),
          !collectionMode && phoneMenuRow('search', h(SearchIcon, { size: 18 }), '搜索', 0),
          !collectionMode && phoneMenuRow('git', h(SourceControlIcon, { size: 18 }), '源代码管理', changedFiles.length)))
      : null
  ),
  h('footer', { className: `world-vscode-statusbar${phone ? ' is-phone' : ''}` },
    // 手机上活动栏的入口：一条 28px 的按钮换回 40px 正文，菜单从底部弹出
    phone ? h('button', {
      type: 'button', className: `world-vscode-status-menu${phoneMenuOpen ? ' is-on' : ''}`,
      title: '视图菜单', 'aria-label': '视图菜单', 'aria-haspopup': 'menu', 'aria-expanded': phoneMenuOpen,
      onClick: () => setPhoneMenuOpen(open => !open),
    }, h(MenuIcon, { size: 16 })) : null,
    h('button', {
      type: 'button', className: 'world-vscode-status-root',
      title: collectionMode ? `收纳盒：${displayName}` : rootPath ? `当前文件夹：${rootPath} · 点击更换` : '打开一个文件夹',
      onClick: collectionMode ? undefined : openPicker,
    }, `◆ ${collectionMode ? displayName : rootPath ? baseName(rootPath) : '打开文件夹'}`),
    // 收起输出后进程照跑：状态栏留一个「● 输出」按钮，点一下回到运行面板
    batchRun && batchCollapsed ? h('button', {
      type: 'button', className: `world-vscode-status-batch${batchRun.running ? ' is-running' : ''}`,
      title: `${batchRun.running ? '批处理运行中' : '批处理输出'}：${batchRun.path} · 点击展开输出`,
      'aria-label': '展开批处理输出', onClick: () => setBatchCollapsed(false),
    }, batchRun.running ? '● 输出' : '输出') : null,
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
      // 手机上这段被挤到只剩 15px，「未保存」会截成「未..」：改成一个符号，
      // 完整文字留在 title 里（桌面仍然是完整文字，宽着）。
      : h('span', {
        className: `world-vscode-status-msg${notice || saving || activeDirty ? ' is-active' : ''}`,
        title: notice || (saving ? '正在保存…' : activeDirty ? '未保存' : active?.document?.readOnly ? 'GBK · 只读' : ''),
      }, phone
        ? (notice ? '✓' : saving ? '…' : activeDirty ? '●' : active?.document?.readOnly ? 'GBK · 只读' : '')
        : (notice || (saving ? '正在保存…' : activeDirty ? '未保存' : active?.document?.readOnly ? 'GBK · 只读' : ''))),
    // 文件还在读的时候别报「1 行 / LF」：那些数还没意义
    // 手机上状态栏要同时塞下换行开关和保存：位置写成 VSCode 的 行:列 形式，省 30px 留给「未保存」
    active?.document
      ? h('span', {
        className: 'world-vscode-status-pos',
        title: `光标位置：行 ${caretLine + 1}, 列 ${caretColumn + 1}`,
      }, phone ? `${caretLine + 1}:${caretColumn + 1}` : `行 ${caretLine + 1}, 列 ${caretColumn + 1}`)
      : null,
    // 换行开关：手机默认开（360px 不折行就得左右拖），桌面默认关；两边都露在状态栏上，
    // 和 Alt+Z 是同一个状态。Diff 是只读单栏，切换没有落点，所以不显示。
    active?.kind === 'diff' || active?.kind === 'chat'
      ? h('span', {
        className: 'world-vscode-status-diff',
        title: active.kind === 'chat' ? '与当前 dsh 会话对话' : active.path,
      }, active.kind === 'chat' ? '对话' : active.staged ? 'Diff · 已暂存' : active.untracked ? 'Diff · 未跟踪' : 'Diff · 工作区')
      : null,
    active?.kind === 'diff' || active?.kind === 'chat' || active?.kind === 'document' ? null : h('button', {
      type: 'button', className: `world-vscode-status-wrap${wrap ? ' is-on' : ''}`,
      title: wrap ? '自动换行：开（点击关闭，Alt+Z）' : '自动换行：关（点击打开，Alt+Z）',
      'aria-pressed': wrap, onClick: () => setWrap(value => !value),
    }, wrap ? '换行 开' : '换行 关'),
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: `换行符 ${active.document.eol || 'LF'}` },
      active.document.eol || 'LF') : null,
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: '文件编码' },
      active.document.encoding && active.document.encoding !== 'UTF-8' ? active.document.encoding : active.document.bom ? 'UTF-8 BOM' : 'UTF-8') : null,
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: '语言模式' },
      language ? languageLabel(language) : extension) : null,
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: '文件行数' }, `${lineCount} 行`) : null,
    active?.document ? h('button', { type: 'button', disabled: !activeDirty || saving, title: '保存 (Ctrl+S)', onClick: () => void saveFile() },
      saving ? '保存中…' : '保存') : null),
  minimized || maximized ? null : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => h('div', { key: edge, className: `world-vscode-resize world-vscode-resize-${edge}`,
    onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd })),
  immersive && !collectionMode && rootPath ? h('button', {
    type: 'button', className: 'world-vscode-chat-fab', 'data-world-vscode-chat': true,
    title: '对话 · 与当前文件夹的 dsh 会话聊天', 'aria-label': '打开对话',
    onPointerDown: event => event.stopPropagation(),
    onClick: openChatTab,
  }, h(ChatIcon), h('span', null, '对话')) : null,
  picker ? pickerDialog() : null,
  quickOpen ? h(QuickOpen, { key: `${session?.id}:${rootPath}`, rpc, sessionId: session?.id, root: rootPath,
    cardRef: pickerCardRef, onClose: () => setQuickOpen(false),
    onOpen: path => { setQuickOpen(false); void openFile(absolutePath(path), true) } }) : null,
  // 菜单留在窗口里：portal 到 body 会被 world 的 inert 逻辑锁住（host 窗口关闭时），
  // 也会被窗口的 stacking context 压在下面；fixed 定位本身不受 overflow 裁剪。
  fileMenu ? h('div', {
    ref: fileMenuRef, className: 'world-context-menu world-vscode-menu', role: 'menu',
    style: { left: fileMenu.x, top: fileMenu.y },
    onPointerDown: event => event.stopPropagation(),
    onContextMenu: event => event.preventDefault(),
  },
  h('div', { className: 'world-context-title', title: fileMenu.path }, baseName(fileMenu.path)),
  isBatchPath(fileMenu.path) ? h('button', {
    type: 'button', role: 'menuitem', autoFocus: true,
    disabled: batchStarting, 'aria-busy': batchStarting,
    onClick: () => { setFileMenu(null); void runBatch(fileMenu.path) },
  }, '运行批处理') : null,
  h('button', {
    type: 'button', role: 'menuitem', autoFocus: !isBatchPath(fileMenu.path),
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
