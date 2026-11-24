import React from 'react'
import { applyNativeEdit, bindSourceHistory, nativeInput } from './vscode-source-history.js'
import { ErrorDetailsContext, ErrorDetailsDialog, NativeErrorScope, detailsButton, errorMessage } from './vscode-error-details.js'
import { nativeFoldRows } from './vscode-folding.js'
import { LargeSource, largeDocument, setLargeText, tabText } from './vscode-large-source.js'
import { GitDiffView } from './git-diff-view.js'
import { lineOfOffset, useNativeWord, wordRow } from './vscode-word-highlight.js'
import { createHighlighter, languageLabel, languageOf, markdownTestBlocks } from './highlight.js'
import { commentPrefixOf, duplicateLineBlock, moveLineBlock, toggleCommentBlock } from './editor-commands.js'
import { desktopError, waitForDesktop } from './desktop-client.js'
import { worldConfirm } from './world-confirm.js'
import { isPhoneViewport } from './responsive.js'
import { usePbJob, PbRunPanel, projectObjects, pbGroups, groupOf, groupKey } from './vscode-pb.js'
import { PinGlyph, pinLabel } from './window-pin.js'
import { AssistantConversation, observeConversationPortals } from './assistant-conversation.js'
import { NativeDocument, isDocumentPreviewPath } from './native-document.js'
import { QuickOpen, reserveQuickOpen, reserveTextFind } from './vscode-quick-open.js'
import { findTextOffsets, MAX_TEXT_MATCHES, replaceAllText } from './text-find.js'
import { DockSlot } from './window-docking.js'
import {
  addTab, closestPaneEdge, groupById, groupsOf, moveTabToGroup, paneBounds, removeTab,
  setPaneRatio, splitWithTab, tabGroupOf, visibleTabs as visibleTabIds,
} from './vscode-layout.js'
import { findInScript, scriptContext } from './srw-code-editor.js'
import { parsePainter } from './srw-model.js'
import { taskbarSource } from './taskbar-source.js'
import { useWindowCache } from './window-cache.js'
import { SrwDesigner, defaultSrwPanels, packSrwLayout, saveSrwLayout, srwPreset, srwViews, useSrwLifetime } from './srw-designer.js'
import { acknowledgeEdits, createEdits, designChanges, designText, editsDirty } from './srw-edits.js'
import { detachMember, replaceId, editLayout, emptyDeck, memberIds, moveMember, ownership, reconcileDeck, wrapTab } from './vscode-tab-groups.js'
import { createPaneMounts, PaneLayout, TabSurface, TAB_DRAG_TYPE } from './vscode-panes.js'

const h = React.createElement
const EMPTY_FILES = []
const EMPTY_LIBRARIES = new Set()
/** 没有折行行高可用时（没量到、或超过测量上限）的哨兵：长度 0，任何 `count + 1` 都对不上。 */
const EMPTY_TOPS = new Int32Array(0)
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
const SIDE_TITLES = { files: '资源管理器', search: '搜索', git: '源代码管理', run: '运行' }
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
export function ChatIcon({ size = 15 }) {
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

// Index native rows once per draft, not on click or scroll. CM owns its own line index.
const nativeIndexes = new WeakMap()
/** Line starts as a packed Int32Array: 4 bytes per line, and `length` is the line count.
 *  Built once per draft; callers that only need a prefix use newlinesIn() instead. */
function nativeIndex(text, document) {
  const cached = nativeIndexes.get(document)
  if (cached?.text === text) return cached.starts
  let count = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count++
  const starts = new Int32Array(count)
  let row = 1
  for (let i = text.indexOf('\n'); i >= 0 && row < count; i = text.indexOf('\n', i + 1)) starts[row++] = i + 1
  nativeIndexes.set(document, {text, starts}); return starts
}
const rowText = (text, starts, i) => text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] - 1 : text.length)
function countLines(text, document) {
  if (document && !document.large) return nativeIndex(text, document).length
  return newlinesIn(text) + 1
}
function newlinesIn(text) {
  let count = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count++
  return count
}

/**
 * 折行行高尺子：镜像层里每个逻辑行一个 div，量回每行占多高，再做前缀和。
 *
 * 整篇重建看着简单，但 2000 行的文件每次按键都要新建 2000 个 div、重排 2000 个元素：
 * 实测 24 个字符多花 100ms 脚本 + 176ms 布局 + 459ms 样式重算（每键 19ms 样式），
 * 敲起来是顿的，而且每次都是新数组 → React 跟着整棵编辑器重渲染。
 * 现在只碰「文本真的变了」那几行：其余行连 DOM 都不动，行高沿用上一次量到的值，
 * 前缀和是纯算术。宽度、行高、排版方式变了才整篇重排（那时结果本来就全变了）。
 *
 * 返回的 tops 在几何没变时是同一个引用（React 因此跳过重渲染）。
 */
function createWrapRuler() {
  const state = { layer: null, signature: '', value: '', lines: [], cells: [], heights: [], tops: new Int32Array(0), scratch: new Int32Array(0) }

  const build = (layer, value, width) => {
    layer.style.width = `${width}px`
    const lines = value.split('\n')
    const cells = new Array(lines.length)
    const fragment = document.createDocumentFragment()
    for (let index = 0; index < lines.length; index += 1) {
      const cell = document.createElement('div')
      // 空行在 pre-wrap 里没有内容就没有高度：塞一个零宽字符，让它照样占一行
      cell.textContent = lines[index] || '\u200b'
      fragment.appendChild(cell)
      cells[index] = cell
    }
    layer.replaceChildren(fragment)
    state.layer = layer
    state.value = value
    state.lines = lines
    state.cells = cells
    state.heights = new Array(lines.length).fill(0)
  }

  /** 只重建变了的行；行数没变时连节点都不换，改 textContent 就够。 */
  const patch = (value, lines) => {
    const previous = state.lines
    // 逐行比：字符串比较走到的是原生 memcmp，比逐字符数换行快得多
    const shortest = Math.min(previous.length, lines.length)
    let first = 0
    while (first < shortest && previous[first] === lines[first]) first += 1
    let tailOld = previous.length, tailNew = lines.length
    while (tailOld > first && tailNew > first && previous[tailOld - 1] === lines[tailNew - 1]) { tailOld -= 1; tailNew -= 1 }
    const oldSpan = tailOld - first
    const newSpan = tailNew - first
    if (oldSpan === newSpan) {
      for (let index = 0; index < newSpan; index += 1) {
        const cell = state.cells[first + index]
        const text = lines[first + index] || '\u200b'
        if (cell.textContent !== text) cell.textContent = text
        state.heights[first + index] = 0
      }
    } else {
      const fragment = document.createDocumentFragment()
      const cells = new Array(newSpan)
      for (let index = 0; index < newSpan; index += 1) {
        const cell = document.createElement('div')
        cell.textContent = lines[first + index] || '\u200b'
        fragment.appendChild(cell)
        cells[index] = cell
      }
      // 先插新的再删旧的：中间那段一旦空了，插进去的位置就不好找了
      state.layer.insertBefore(fragment, state.cells[first + oldSpan] || null)
      for (let index = 0; index < oldSpan; index += 1) state.cells[first].remove()
      state.cells.splice(first, oldSpan, ...cells)
      state.heights.splice(first, oldSpan, ...new Array(newSpan).fill(0))
    }
    state.value = value
    state.lines = lines
  }

  return {
    /**
     * @param round 按整行高取整（主编辑区一直这么算，行号槽和当前行底纹都按整行定位）；
     *   分屏视图用原始高度。
     * @returns {Int32Array} 每行顶边的前缀和，`tops[i]` 是第 i 行的顶边。
     */
    measure({ layer, value, width, lineHeight, round = false }) {
      const signature = `${width}|${lineHeight}|${round ? 'r' : 'h'}`
      if (layer !== state.layer || signature !== state.signature || !state.cells.length) {
        build(layer, value, width)
        state.signature = signature
      } else if (value !== state.value) {
        patch(value, value.split('\n'))
      }
      const count = state.cells.length
      const size = count + 1
      if (state.scratch.length !== size) { state.scratch = new Int32Array(size); state.tops = new Int32Array(0) }
      const next = state.scratch
      let top = 0
      let changed = state.tops.length !== size
      for (let index = 0; index < count; index += 1) {
        let height = state.heights[index]
        if (!height) {
          const raw = state.cells[index].offsetHeight
          // 折行只会在行高处切：高度 ÷ 行高就是这一行占了几行视觉行
          height = round ? Math.max(1, Math.round(raw / lineHeight)) * lineHeight : Math.max(lineHeight, raw)
          state.heights[index] = height
        }
        top += height
        next[index + 1] = top
        if (!changed && next[index + 1] !== state.tops[index + 1]) changed = true
      }
      if (changed) state.tops = next.slice()
      return state.tops
    },
  }
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

/**
 * 行命令（移动行 / 复制行 / 切换注释）落盘。
 * 只替换真正变了的 `from`~`to` 那一段：整段替换在 5 万行（1.4MB）的文件里要 120ms 以上，
 * 而移动一行实际只动两行文本。
 */
function applyLineEdit(node, result) {
  if (!result || result.value === node.value) return false
  const top = node.scrollTop
  const left = node.scrollLeft
  node.focus({ preventScroll: true })
  node.setSelectionRange(result.from, result.to)
  insertText(node, result.text)
  node.setSelectionRange(result.start, result.end)
  node.scrollTop = top
  node.scrollLeft = left
  return true
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
/**
 * 超过这个大小就交给虚拟化编辑器（CodeMirror）：单个 textarea 在 1.5 MiB 时
 * 每敲一个字符要 13ms（其中 9ms 是浏览器重排整段文本），已经贴着掉帧线。
 */
const CM_SOURCE_MIN = 1024 * 1024
// A native wrapped mirror cannot position rows beyond its measurement limit. Use the
// virtual editor for that case (including plain text), and for minified single-line files.
function virtualSource(path, text) {
  if (text.length > CM_SOURCE_MIN || (text.length > 200_000 && languageOf(path))) return true
  if (text.length < WRAP_MEASURE_LIMIT) return false
  let start = 0, lines = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    if (++lines > WRAP_MEASURE_LIMIT || i - start > 8192) return true
    start = i + 1
  }
  return text.length - start > 8192
}
/** 再往上只读浏览：保存时要一次性把全文取出，超过 8 MiB 那一下会有明显停顿。 */
const CM_EDIT_MAX = 8 * 1024 * 1024
/** textarea 的兜底：理论上到不了这里（>CM_SOURCE_MIN 已改走虚拟化视图）。 */
const LARGE_FILE_LIMIT = CM_SOURCE_MIN
// Choose from the loaded snapshot, never from keystrokes in a smaller editable draft.
const largeSource = tab => Boolean(tab?.document?.large && !tab.kind)

/** 这次编辑能不能落盘：服务端判定只读（GBK 等）、超大只读视图，或者 textarea 的大文件保护。 */
function isLocked(tab) {
  if (!tab?.document) return true
  if (tab.document.large) return Boolean(tab.document.readOnly || tab.document.huge)
  return Boolean(tab.document.readOnly) || (tab.draft?.length ?? 0) > LARGE_FILE_LIMIT
}

const codeView = tab => largeSource(tab) || Boolean(tab?.foldEditor && !tab.kind)

const painterPath = path => /\.sr[wudam]$/i.test(path)
// Flatten visible strips, not the document array: dragging tabs changes the deck order.
// Painter children describe one file; chat, diff and docked applications aren't files.
function fileSessionOf(tabs, deck, activeId) {
  const bySlot = new Map(tabs.filter(t => !t.kind || t.kind === 'document' || t.designKey).map(t => [t.designKey || t.id, t]))
  const files = []
  let active = ''
  const add = id => {
    const tab = bySlot.get(id)
    if (!tab) return
    files.push({ path: tab.path, pinned: !!(tab.designKey ? tab.designPinned : tab.pinned), design: !!(tab.designKey || tab.openAsDesign) })
    if (tab.id === activeId || (tab.designKey && deck.parents[id]?.active === activeId)) active = tab.path
  }
  for (const id of memberIds(deck.root)) {
    if (deck.parents[id] && !bySlot.has(id)) memberIds(deck.parents[id].layout).forEach(add)
    else add(id)
  }
  return files.length ? { files, active } : null
}

function withinFolder(path, root) {
  if (!root) return false
  const fold = value => /^(?:[a-z]:\/|\/\/)/i.test(root) ? value.toLowerCase() : value
  return fold(path).startsWith(fold(root.endsWith('/') ? root : `${root}/`))
}

function restoreFileTabs(saved, rootFor) {
  if (!Array.isArray(saved?.files)) return []
  const seen = new Set(), tabs = []
  for (const file of saved.files) {
    if (typeof file?.path !== 'string') continue
    const path = normalizePath(file.path)
    if (!/^(?:[a-z]:\/|\/)/i.test(path) || /[\x00-\x1f]|(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || seen.has(path)) continue
    const root = rootFor(path)
    if (!withinFolder(path, root)) continue
    seen.add(path)
    tabs.push({ id: `restored-${tabs.length}`, path, root, pinned: file.pinned === true, openAsDesign: file.design === true && painterPath(path),
      kind: isDocumentPreviewPath(path) ? 'document' : undefined, document: null, draft: '' })
  }
  return tabs
}

function isDirty(tab) {
  if (tab?.designKey) return Boolean(tab.srw.needsReview) || editsDirty(tab.srw.edits)
  if (!tab?.document || isLocked(tab)) return false
  // 虚拟化视图的文本在 CodeMirror 里，tab 上只留一个「动过没有」的标记。
  if (tab.document.large) return Boolean(tab.edited)
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

// A search response is an immutable snapshot. Scrolling the editor or typing in Find
// must not rebuild every highlighted hit in the workspace search sidebar.
const SearchHits = React.memo(function SearchHits({ file, revealRef }) {
  return file.matches.map(match => h('button', {
    key: `${match.line}:${match.column}`, type: 'button', className: 'world-vscode-search-hit',
    title: `${file.path}:${match.line}`, onClick: () => revealRef.current(file.path, match),
  },
  h('span', { className: 'world-vscode-search-line' }, match.line),
  h('span', { className: 'world-vscode-search-text' },
    match.prefix ? '…' : null, markedText(match), match.suffix ? '…' : null)))
})

// Keep inactive tab headers out of unrelated focus/caret updates. Selection, dirty
// and pin state are explicit props (design sessions also mutate outside the tab object).
const EditorTabHeader = React.memo(function EditorTabHeader({ tab, isParent, selected, current, dirtyTab, pinned, customLabel, windowKey, activeTabRef, actions }) {
  const chat = tab.kind === 'chat', name = baseName(tab.path)
  const label = customLabel || (chat ? '对话' : name)
  return h('div', {
    ref: selected && !isParent ? activeTabRef : null,
    role: 'tab',
    draggable: true,
    onDragStart: event => {
      actions.current.draggedTab.current = tab.id
      event.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify({ windowKey, id: tab.id }))
      event.dataTransfer.effectAllowed = 'move'
    },
    'aria-selected': current,
    tabIndex: current ? 0 : -1,
    'data-tab-id': tab.id, 'data-parent-tab': isParent ? tab.id : undefined,
    onContextMenu: event => actions.current.openTabMenu(event, tab.id),
    className: `world-vscode-tab${selected ? ' active' : ''}${current && !selected ? ' is-current' : ''}${pinned ? ' is-pinned' : ' preview'}${tab.kind === 'diff' ? ' is-diff' : ''}${chat ? ' is-chat' : ''}${dirtyTab ? ' is-dirty' : ''}${tab.stale ? ' is-stale' : ''}`,
    title: tab.kind === 'app' ? `${label} · 拖到内容区边缘分屏；关闭标签还原独立窗口` : chat
      ? '与当前 dsh 会话对话'
      // 设计视图的 path 是「父组/视图名」，悬停时只给视图名，别把内部 key 露出来
      : tab.kind === 'srw-view' ? label
      : tab.kind === 'diff'
        ? `${tab.path} · ${tab.commit ? `提交 ${tab.commit.slice(0, 7)}` : tab.staged ? '已暂存' : tab.untracked ? '未跟踪' : '工作区'} Diff`
        : tab.pinned ? tab.path : `${tab.path} · 预览标签（在文件树双击可锁定）`,
    onClick: () => actions.current.activateTab(tab.id),
    onDoubleClick: () => actions.current.pinTab(tab.id),
    onAuxClick: event => {
      if (event.button !== 1) return
      event.preventDefault()
      actions.current.closeTab(tab.id)
    },
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      actions.current.activateTab(tab.id)
    },
  },
  h('span', { className: `world-vscode-tab-icon ${chat ? 'is-chat' : entryIconClass(name)}` },
    isParent ? h(FolderIcon, { open: selected }) : chat ? h(ChatIcon) : h(FileIcon)),
  tab.kind === 'diff' ? h('i', { className: 'world-vscode-tab-diffmark', 'aria-hidden': true }, '±') : null,
  // 标签等宽（见 styles.css），长名字必然省略：把全名挂在 title 上，别让人猜。
  h('span', { className: 'world-vscode-tab-name', title: label }, tab.commit ? `${label} · ${tab.commit.slice(0, 7)}` : label),
  tab.stale ? h('i', { className: 'world-vscode-tab-stale', title: '磁盘上的文件已被外部修改' }, '●') : null,
  dirtyTab ? h('i', { className: 'world-vscode-tab-dirty', title: '未保存' }, '●') : null,
  h('button', {
    type: 'button', className: 'world-vscode-tab-close', tabIndex: -1,
    'aria-label': `关闭标签 ${label}`, title: '关闭标签',
    onClick: event => { event.stopPropagation(); actions.current.closeTab(tab.id) },
  }, '×'))
})

function entryIconClass(name) {
  const ext = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  if (ext === 'js' || ext === 'mjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') return 'is-js'
  if (ext === 'json') return 'is-json'
  if (ext === 'md' || ext === 'txt') return 'is-md'
  if (ext === 'pbt' || ext === 'exe' || ext === 'pbl' || ext === 'pbd') return 'is-pb'
  return 'is-file'
}

/** Desktop file links and explorer rows must enter through the same project resolver. */
export const PROJECT_DRAG_TYPE = 'application/x-world-project-path'
export const isProjectEntry = name => /\.(?:pbt|exe|zip)$/i.test(name)
const resolvingProjects = new WeakMap()
export const projectOpeningText = path => `正在打开 ${baseName(path)}…`
export function resolveProject(rpc, path, sessionId) {
  let jobs = resolvingProjects.get(rpc)
  if (!jobs) resolvingProjects.set(rpc, jobs = new Map())
  const name = normalizePath(path), key = JSON.stringify([sessionId, /^(?:[a-z]:\/|\/\/)/i.test(name) ? name.toLowerCase() : name])
  if (!jobs.has(key)) jobs.set(key, requestProject(rpc, path, sessionId).finally(() => jobs.delete(key)))
  return jobs.get(key)
}
async function requestProject(rpc, path, sessionId) {
  const zip = /\.zip$/i.test(path)
  const endpoints = zip ? ['world-vscode-source/open-zip'] : /\.pbt$/i.test(path)
    ? ['pbnpm-pbd-project/open', 'pbnpm-project/open'] : ['pbnpm-pbd-project/open']
  let reason = zip ? 'ZIP 服务不可用' : '请检查 PowerBuilder 插件'
  for (const endpoint of endpoints) {
    try {
      const value = unwrap(await rpc.call('/api', endpoint, zip ? { path, sessionId } : { path }))
      if (value?.path) return normalizePath(value.path)
    } catch (error) { reason = error.message || String(error) }
  }
  throw new Error(`无法打开${zip ? ' ZIP' : ' PowerBuilder'} 工程 ${baseName(path)}：${reason}`)
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
export function isBatchPath(path) {
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

/** 欢迎页的快捷键小条：键帽 + 说明。键帽单独包一层，好按最长那组（Ctrl Shift O）统一宽度，说明文字才能对齐成一列。 */
function keyHint(keys, label) {
  return h('span', null, h('span', { className: 'world-vscode-welcome-keys-group' }, keys.map(key => h('kbd', { key }, key))), label)
}

/**
 * 侧栏报错条：原文必须能被选中，也要能一键复制。
 * 反编译失败时那行 pypower 文案是唯一的定位线索，而整套 vscode 外壳都禁掉了选中。
 */
function ErrorNote({ text, onDismiss, onCopied }) {
  return h('div', { className: 'world-vscode-error' },
    h('div', { className: 'world-vscode-error-head' },
      h('span', null, '出错了'),
      h('span', { className: 'world-vscode-error-actions' }, detailsButton(text),
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

// Keep the draft per editor window even while the Git sidebar is closed. Only
// the form subscribes: editing a message is not a change to the repository tree.
function createCommitDraft() {
  let text = ''
  const listeners = new Set()
  return {
    getSnapshot: () => text,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) {
      if (text === next) return
      text = next
      for (const notify of listeners) notify()
    },
  }
}
function GitCommitForm({ draft, hasStaged, conflicted, gitOp, onCommit }) {
  const commitText = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  const canCommit = hasStaged && !conflicted && !gitOp && Boolean(commitText.trim())
  return h('div', { className: 'world-vscode-git-compose' },
    h('textarea', {
      className: 'world-vscode-git-message', rows: 2, spellCheck: false,
      placeholder: '提交信息（Ctrl+Enter 提交）', value: commitText, 'aria-label': '提交信息',
      onChange: event => draft.set(event.target.value),
      onKeyDown: event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return
          event.preventDefault()
          if (canCommit) onCommit(commitText)
        }
      },
    }),
    h('button', {
      type: 'button', className: 'world-vscode-git-primary', disabled: !canCommit,
      title: hasStaged ? '提交已暂存的更改 (Ctrl+Enter)' : '先暂存要提交的文件',
      onClick: () => onCommit(commitText),
    }, h(CheckIcon), h('span', null, gitOp === 'commit' ? '提交中…' : '提交')))
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
  return /[MADRC]/u.test(file.worktree) ? file.worktree : 'M'
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

function gitFilePaths(file, includeOrigin) {
  return includeOrigin && file.from ? [file.from, file.path] : [file.path]
}
function gitTreeFiles(node) {
  const files = [...node.files]
  for (const child of node.dirs.values()) files.push(...gitTreeFiles(child))
  return files
}

function dirNote(listing) {
  if (listing?.error) return errorMessage(`读取失败：${listing.error}`, listing.error)
  if (!listing?.entries || (listing.loading && !listing.entries.length)) return '正在读取目录…'
  return listing.entries.length ? '' : '空目录'
}

const libraryPath = path => /\.pb[ld]$/i.test(path)
function libraryTree(full, listing, depth, expanded, actions, children) {
  return [['最近修改', listing.recentObjects || []], ...pbGroups(listing.entries)].map(([label, items]) => {
    const id = groupKey(full, label), visible = expanded.has(id)
    return h(React.Fragment, { key: id }, h('button', {
      type: 'button', className: 'world-vscode-file is-dir', 'aria-expanded': visible,
      style: { paddingLeft: 8 + depth * 14 }, onClick: () => actions.current.toggleGroup(id),
    }, h(Twist, { open: visible }), h(FolderIcon, { open: visible }), h('span', { className: 'world-vscode-file-name' }, label)),
    visible && (items.length ? children(items, 1) : h('div', { className: 'world-vscode-tree-note', role: 'status' },
      !listing.entries.length ? '库中没有对象。' : Array.isArray(listing.recentObjects) ? '库中没有记录对象修改时间。'
        : '目录服务未返回对象修改时间，请检查 PB 插件版本。')))
  })
}

function TreeNode({ grouped, parent, entry, depth, expanded, tree, selected, gitStates, actions }) {
  const full = entry.path ? normalizePath(entry.path) : joinPath(parent, entry.name)
  const isDir = entry.type === 'directory'
  const project = !isDir && isProjectEntry(entry.name) && !/\.zip\.workspace\//i.test(full)
  const open = expanded.has(full)
  const listing = isDir && open ? tree.get(full) : null
  const note = isDir && open ? dirNote(listing) : ''
  const status = gitStates?.get(full)
  const children = (items, extraDepth = 0) => items.map(child => h(TreeNode, {
    key: child.name, parent: full, entry: child, depth: depth + 1 + extraDepth,
    expanded, tree, selected, gitStates, actions,
  }))
  return h(React.Fragment, { key: full },
    h('button', {
      type: 'button',
      'aria-label': entry.name, 'data-git-state': status?.letter,
      draggable: project || undefined,
      onDragStart: project ? event => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(PROJECT_DRAG_TYPE, full) } : undefined,
      className: `world-vscode-file${isDir ? ' is-dir' : ''}${open ? ' is-open' : ''}${project ? ' is-project' : ''}${selected === full ? ' selected' : ''}`,
      style: { paddingLeft: 8 + depth * 14 },
      title: `${isDir ? full : project ? `${full} · 点击作为${/\.zip$/i.test(full) ? ' ZIP' : ' PowerBuilder'} 工程打开` : `${full} · 双击锁定标签`}${status ? ` · Git：${status.label}` : ''}`,
      'aria-expanded': isDir ? open : undefined,
      onPointerEnter: isDir && !open ? event => { if (event.pointerType === 'mouse') actions.current.warmDir(full) } : undefined,
      onPointerLeave: isDir ? () => actions.current.warmDir(null) : undefined,
      onClick: () => isDir ? actions.current.toggleDir(full) : project ? actions.current.openProject(full) : actions.current.openFile(full, false),
      onDoubleClick: () => { if (!isDir && !project) actions.current.openFile(full, true) },
      onContextMenu: event => actions.current.openFileMenu(event, full),
    },
    isDir ? h(Twist, { open }) : h(TwistSpacer),
    h('span', { className: `world-vscode-file-icon ${isDir ? 'is-dir' : entryIconClass(entry.name)}` },
      isDir ? h(FolderIcon, { open }) : h(FileIcon)),
    h('span', { className: 'world-vscode-file-name' }, entry.name),
    status && h('span', { className: `world-vscode-git-state ${stateClass(status.letter)}`, 'aria-hidden': true }, status.letter)),
    listing?.entries && (grouped || libraryPath(full) ? libraryTree(full, listing, depth + 1, expanded, actions, children) : children(listing.entries)),
    note
      ? h('div', { className: 'world-vscode-tree-note', role: 'status', style: { paddingLeft: 26 + depth * 14 } }, note)
      : null)
}

// Window focus, caret and scroll updates do not change the explorer. Only rebuild
// the row subtree when its displayed data changes; events use the latest committed actions.
const ExplorerRows = React.memo(function ExplorerRows({ treeRoot, collectionMode, tree, expanded, selected, gitStates, pbLibraries, application, actions }) {
  const listing = tree.get(treeRoot)
  const rows = (entries, extraDepth = 0) => entries.map(entry => h(TreeNode, {
    key: entry.path || entry.name, parent: treeRoot, entry, depth: 1 + extraDepth, expanded, tree, selected, gitStates, actions,
    grouped: entry.type === 'directory' && pbLibraries.has(entry.name.toLowerCase()),
  }))
  if (application && !collectionMode && listing?.entries) {
    const path = joinPath(joinPath(treeRoot, application.library), application.name)
    return rows([{ name: `应用程序 · ${application.name}`, type: 'file', path }, ...listing.entries])
  }
  return !collectionMode && libraryPath(treeRoot) && listing?.entries
    ? libraryTree(treeRoot, listing, 1, expanded, actions, rows) : rows(listing?.entries || EMPTY_FILES)
})

const NO_SESSION_SUBSCRIBE = () => () => {}
const EMPTY_SESSION_LIST = { ids: [], byId: {} }
const emptySessionSnapshot = () => EMPTY_SESSION_LIST

/** Windows 路径不区分大小写；其它平台按原样比较。 */
function sameFolder(a, b) {
  const left = normalizePath(a)
  const right = normalizePath(b)
  if (!left || !right) return false
  return /^(?:[a-z]:\/|\/\/)/i.test(left) || /^(?:[a-z]:\/|\/\/)/i.test(right)
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

/** 编辑器快照 → 对话上下文条需要的数据；选区行号按需切片，不在每次光标移动时算。 */
function describeEditorContext(ctx) {
  if (!ctx?.path) return null
  let selection = ctx.selection || null
  if (!selection && ctx.value && ctx.end > ctx.start) {
    const raw = ctx.value.slice(ctx.start, ctx.end)
    const from = newlinesIn(ctx.value.slice(0, ctx.start)) + 1
    // 选区以换行结尾时「最后一行」是空的：行号按去掉尾部换行后的位置算。
    const to = newlinesIn(ctx.value.slice(0, ctx.start + raw.replace(/\n+$/, '').length)) + 1
    selection = { text: raw, from, to: Math.max(from, to) }
  }
  return { path: ctx.path, line: ctx.line, column: ctx.column, selection, dirty: Boolean(ctx.dirty) }
}

/**
 * 编辑器里的原生对话标签：复用 DSH 的 native conversation（历史、流式、工具、输入、审批）。
 * 会话按 VSCode 当前根目录筛选，可新建或从该目录的历史会话里选。
 * 挂载时 AssistantConversation 会 retain 会话并占用唯一的对话座位，卸载即释放。
 */
function VscodeChat({ active, sessionId, boundSessionId, rootPath, rpc, sessions, SessionProvider, renderSlot, conversationSeat, onSelectSession, editorContext }) {
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

  // 编辑器上下文：只在对话标签激活时生成，后台标签不必为一次大文件切片付钱。
  const context = React.useMemo(() => active ? describeEditorContext(editorContext) : null, [active, editorContext])
  const [hint, setHint] = React.useState('')
  const hintTimer = React.useRef(0)
  React.useEffect(() => () => clearTimeout(hintTimer.current), [])
  const flash = (text, failed = false) => {
    setHint(failed ? errorMessage(text) : text)
    clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(''), 2200)
  }
  /** 引用文本：路径 + 光标位置；有选区时再带代码块（超过 2 万字符截断并注明）。 */
  const quote = withSelection => {
    const dirty = context.dirty ? '（未保存）' : ''
    if (!withSelection || !context.selection) return `【编辑器上下文】${context.path}\n光标：第 ${context.line} 行，第 ${context.column} 列${dirty}\n`
    const selection = context.selection, language = languageOf(context.path) || ''
    const raw = selection.text.replace(/\n+$/, '')
    const body = raw.length > 20000
      ? `${raw.slice(0, 20000)}\n…（已截断，完整内容见文件）` : raw
    const range = selection.from === selection.to ? `第 ${selection.from} 行` : `第 ${selection.from}-${selection.to} 行`
    return `【编辑器上下文】${context.path} ${range}${dirty}\n\`\`\`${language}\n${body}\n\`\`\`\n`
  }
  // 宿主输入框不受我们控制：textarea 用原生 setter + input 事件喂给 React；
  // contenteditable（Lexical 之类）走 execCommand 的原生插入，失败就提示手动粘贴。
  const insert = text => {
    const body = chatRef.current?.querySelector('.world-vscode-chat-body')
    const input = body?.querySelector('textarea, [contenteditable="true"]')
    if (!input) { flash('先点一下对话输入框'); return }
    if (input.tagName === 'TEXTAREA') {
      const current = input.value
      const next = current ? `${current}${current.endsWith('\n') ? '' : '\n'}${text}` : text
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      input.selectionStart = input.selectionEnd = next.length
      flash('已加入输入框')
      return
    }
    input.focus()
    const selection = document.getSelection()
    selection.selectAllChildren(input)
    selection.collapseToEnd()
    const inserted = document.execCommand('insertText', false, text)
    flash(inserted ? '已加入输入框' : '这个输入框不支持直接插入，请手动粘贴', !inserted)
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
        error ? h('div', { className: 'world-vscode-chat-error' }, errorMessage(error)) : null)

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
      h('div', { className: 'world-vscode-chat-message' }, errorMessage('当前宿主不支持内嵌原生对话。')))
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
    context ? h('div', { className: 'world-vscode-chat-context' },
      h('span', { className: 'world-vscode-chat-context-file', title: context.path },
        h(FileIcon), h('span', null, baseName(context.path))),
      h('span', { className: `world-vscode-chat-context-meta${hint ? ' is-hint' : ''}` }, hint
        || `第 ${context.line} 行${context.selection ? ` · 选中 ${context.selection.from === context.selection.to ? 1 : context.selection.to - context.selection.from + 1} 行` : ''}`),
      h('span', { className: 'world-vscode-chat-context-actions' },
        h('button', { type: 'button', title: '把文件路径和光标位置加入输入框', onClick: () => insert(quote(false)) }, '+ 文件'),
        h('button', { type: 'button', disabled: !context.selection,
          title: context.selection ? `把第 ${context.selection.from}-${context.selection.to} 行加入输入框` : '先在编辑器里选中一段代码',
          onClick: () => insert(quote(true)) }, '+ 选区')))
      : null,
    h(NativeErrorScope, { className: 'world-vscode-chat-body', visible: active }, body))
}

function rememberTextPosition(bookmarks, doc, node) {
  if (doc && node.clientHeight) bookmarks.set(doc, { start: node.selectionStart, end: node.selectionEnd,
    direction: node.selectionDirection, top: node.scrollTop, left: node.scrollLeft })
}

const noTests = { rows: new Map(), gutter: new Map() }
// A split can show two different Markdown documents. Actions and row numbers belong to
// the file, not to whichever pane most recently had focus.
const testPlans = new WeakMap(), largeTestPlans = new WeakMap()
function fileTests(tab) {
  if (!tab?.document || tab.kind || !/\.(md|markdown)$/i.test(tab.path)) return noTests
  if (tab.document.large) return largeTestPlans.get(tab.document) || noTests
  const text = tabText(tab), cached = testPlans.get(tab)
  if (cached?.text === text) return cached
  const plan = {text, ...testPlan(markdownTestBlocks(text))}; testPlans.set(tab, plan); return plan
}
function testPlan(blocks) {
  const rows = new Map(), gutter = new Map()
  for (const block of blocks) {
    const run = {blockIndex: block.index, label: `运行代码块 ${block.index}`}
    rows.set(block.line, run)
    if (block.cases.length) gutter.set(block.line, run)
    for (const item of block.cases) {
      const target = {blockIndex: block.index, caseName: item.name, label: `运行 ${item.name}`, ambiguous: item.ambiguous}
      rows.set(item.line, target); gutter.set(item.line, target)
    }
  }
  return { rows, gutter }
}
// 手机上运行列让位给正文：跑测试走标题栏的「文件内单元测试」面板，行号槽只留行号和折叠。
// 折叠列同时加宽到 30px，一行高的方形按钮才够拇指点。
function gutterStyle(width, folds, tests, phone) {
  return { '--world-number-width': `${width}px`,
    '--world-fold-width': folds?.size ? (phone ? '30px' : 'var(--vscode-line-height)') : '0px',
    '--world-run-width': !phone && tests?.size ? 'var(--vscode-line-height)' : '0px',
    '--vscode-gutter': 'calc(var(--world-run-width) + var(--world-number-width) + var(--world-fold-width))' }
}
function gutterCells(line, folds, onFold, testRows, runTest, disabled, hint, phone) {
  const target = !phone && testRows?.get(line)
  return [target && h('button', { key: 'test', type: 'button', className: 'world-vscode-gutter-test',
    title: hint || (target.ambiguous ? '名称前缀重复，请运行整个代码块。' : target.label),
    'aria-label': target.label, disabled: disabled || target.ambiguous, onClick: () => runTest(target) }, '▶'),
    h('span', {key: 'number', className: 'world-vscode-row-number', 'aria-hidden': true}, line), foldArrow(line, folds, onFold)]
}
function foldArrow(line, rows, action) {
  const endLine = rows?.get(line)
  return endLine && h('button', {key: 'fold', type: 'button', className: 'world-vscode-fold-arrow',
    title: `折叠第 ${line} 行代码块 · 切换到代码视图`, 'aria-label': `折叠第 ${line} 行代码块`, 'aria-expanded': true,
    onMouseDown: e => e.preventDefault(), onClick: () => action({line, endLine})}, null)
}
function SplitSource({ tab, onFold, testRows, runTest, testsDisabled, wrap, phone, bookmarks, active, inputRef, onFocus, onChange, onCaret }) {
  const highlight = React.useMemo(() => createHighlighter(), [])
  const input = React.useRef(null), measure = React.useRef(null)
  const foldRows = React.useRef(null)
  const ruler = React.useRef(null)
  if (!ruler.current) ruler.current = createWrapRuler()
  const [scroll, setScroll] = React.useState({ top: 0, left: 0 })
  const [metrics, setMetrics] = React.useState({ width: 0, height: 0, tops: EMPTY_TOPS })
  const lastMetrics = React.useRef(metrics)
  const [composing, setComposing] = React.useState(false)
  const starts = React.useMemo(() => nativeIndex(tab.draft, tab.document), [tab.draft, tab.document])
  const count = starts.length
  React.useLayoutEffect(() => {
    if (input.current) { input.current.worldLineStarts = starts; input.current.worldIndexedText = tab.draft }
  }, [starts, tab.draft])
  const lineHeight = phone ? LINE_HEIGHT_PHONE : LINE_HEIGHT
  const gutter = phone ? 26 : Math.max(46, String(count).length * 8 + 20)
  const language = languageOf(tab.path)
  const words = useNativeWord(tab.path, language)
  const tokens = React.useMemo(() => language ? highlight(tab.draft, language) : null, [tab.draft, language, highlight])
  const folds = React.useMemo(() => {
    const next = nativeFoldRows(tab.draft, language, foldRows.current)
    foldRows.current = next
    return next
  }, [tab.draft, language])
  React.useLayoutEffect(() => {
    const node = input.current, mirror = measure.current
    if (!node) return undefined
    const update = () => {
      const style = getComputedStyle(node)
      const width = node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      const tops = wrap && count <= WRAP_MEASURE_LIMIT && width && mirror
        ? ruler.current.measure({ layer: mirror, value: tab.draft, width, lineHeight })
        : EMPTY_TOPS
      const previous = lastMetrics.current
      // 行高没变时 tops 是同一个引用：没有新信息就别让 React 重画一遍分屏
      if (previous.width !== width || previous.height !== node.clientHeight || previous.tops !== tops) {
        const next = { width, height: node.clientHeight, tops }
        lastMetrics.current = next
        setMetrics(next)
      }
      node.worldLineTops = tops
    }
    update()
    const observer = new ResizeObserver(update); observer.observe(node)
    return () => observer.disconnect()
  }, [tab.draft, wrap, phone, lineHeight, gutter])
  React.useLayoutEffect(() => {
    if (input.current && input.current.value !== tab.draft) input.current.value = tab.draft
  }, [tab.draft])
  React.useLayoutEffect(() => {
    const saved = bookmarks?.get(tab.document), node = input.current
    if (!saved || !node) return
    const restore = () => {
      node.setSelectionRange(saved.start, saved.end, saved.direction)
      node.scrollTop = saved.top; node.scrollLeft = saved.left
      setScroll({ top: node.scrollTop, left: node.scrollLeft })
    }
    // TabSurface attaches its portal after this child's first layout effect.
    if (node.clientHeight) restore()
    else { const frame = requestAnimationFrame(restore); return () => cancelAnimationFrame(frame) }
  }, [bookmarks, tab.document])
  const remember = node => rememberTextPosition(bookmarks, tab.document, node)
  const ref = React.useCallback(node => { input.current = node; if (active) inputRef.current = node }, [active, inputRef])
  const tops = wrap && metrics.tops.length === count + 1 ? metrics.tops : null
  const ready = (!wrap || Boolean(tops)) && !composing
  const first = Math.max(0, (tops ? lineAtTop(tops, scroll.top) : Math.floor(scroll.top / lineHeight)) - OVERSCAN)
  const bottom = scroll.top + metrics.height
  const last = wrap && !tops ? 0 : Math.min(count, (tops ? lineAtTop(tops, bottom) + 1 : Math.ceil(bottom / lineHeight)) + OVERSCAN)
  // Keep row positions local to a small buffer. Pixel scrolling moves two layers;
  // it needn't rewrite the position or recreate the tokens of every visible row.
  const origin = tops ? tops[first] : first * lineHeight
  const layers = React.useMemo(() => {
    const gutterRows = [], highlightRows = []
    for (let i = first; i < last; i++) {
      const top = (tops ? tops[i] : i * lineHeight) - origin
      gutterRows.push(h('div', { key: i, className: 'world-vscode-gutter-row is-absolute', style: { top } }, gutterCells(i + 1, folds, range => onFold(tab.id, range), testRows, runTest, testsDisabled, null, phone)))
      if (ready) highlightRows.push(h('div', { key: i, 'data-word-row': i, className: `world-vscode-hl-line${wrap ? ' is-wrap' : ''}`,
        style: { position: 'absolute', top, left: 0 },
      }, wordRow(tokens?.lines[i], rowText(tab.draft, starts, i), words.pattern)))
    }
    return { gutterRows, highlightRows }
  }, [first, last, tops, origin, lineHeight, tokens, ready, wrap, starts, tab.draft, words.pattern, folds, onFold, testRows, runTest, testsDisabled, phone])
  const offset = origin - scroll.top
  return h('div', { className: 'world-vscode-editor-content', style: {
    ...gutterStyle(gutter, folds, testRows, phone), '--vscode-line-height': `${lineHeight}px`, '--vscode-font-size': `${phone ? FONT_SIZE_PHONE : 13}px`,
  } },
  h('div', { className: 'world-vscode-gutter', 'aria-hidden': !folds?.size && !(testRows?.size && !phone) },
    h('div', { className: 'world-vscode-gutter-rows is-absolute', style: { transform: `translateY(${offset}px)` } }, layers.gutterRows)),
  wrap ? h('div', { ref: measure, className: 'world-vscode-measure', 'aria-hidden': true }) : null,
  ready ? h('div', { className: `world-vscode-highlight${tokens && !tokens.plain ? '' : ' is-word-mirror'}`, 'aria-hidden': true, style: { width: metrics.width } },
    h('div', { className: 'world-vscode-highlight-rows', style: { transform: `translate(${-scroll.left}px, ${offset}px)` } }, layers.highlightRows)) : null,
  h('textarea', {
    ref, 'data-source-tab': tab.id, className: `world-vscode-textarea world-vscode-split-textarea${ready && tokens && !tokens.plain ? ' is-highlight' : ''}${wrap ? ' is-wrap' : ''}`,
    'aria-label': `编辑 ${baseName(tab.path)}`, defaultValue: tab.draft, readOnly: isLocked(tab),
    spellCheck: false, wrap: wrap ? 'soft' : 'off',
    onFocus: event => { onFocus(); onCaret?.(event.currentTarget) }, onSelect: event => { remember(event.currentTarget); if (active) onCaret?.(event.currentTarget) },
    onScroll: event => { remember(event.currentTarget); setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }) },
    onCompositionStart: () => { words.clear(); setComposing(true) }, onCompositionEnd: () => setComposing(false),
    onBlur: words.clear, onMouseUp: e => words.click(e, tab.draft, starts),
    onChange: event => { words.clear(); onChange(nativeInput(event)) },
    onKeyDown: event => {
      if (isLocked(tab) || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.key === 'Tab') { event.preventDefault(); indentSelection(event.currentTarget, event.shiftKey) }
      else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); autoIndent(event.currentTarget) }
    },
  }))
}

export function VscodeWindow({ toolHistory, replaySearch,
  session, remote, rpc, rect, rootPath: rootProp, extraRoots = EMPTY_FILES, windowKey, zIndex = 5, isActive = true,
  pinned = false, onTogglePin, desktopOpeningProject,
  state = 'normal', onClose, onMinimize, onToggleMaximize, collection = null, openRequest = null,
  fileSession, onFileSessionChange, onDirtyChange, onRootChange, onOpenInNewWindow, onFocusFolder, onDesktopRegister,
  onDragStart, onDragMove, onDragEnd, onResizeStart, onActivate, getDirectoryPicker, getShortcuts,
  sessions, SessionProvider, renderSlot, conversationSeat, immersive = false, docking, dockedApps = EMPTY_FILES,
}) {
  const [errorDetails, setErrorDetails] = React.useState(null)
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
  const dirReads = React.useRef(new Map()), warmTimer = React.useRef(null)
  const [busyFile, setBusyFile] = React.useState('')
  const rootPath = collectionMode ? '' : normalizePath(rootProp ?? session?.cwd ?? '')
  const workspaceRoots = React.useMemo(() => rootPath ? [rootPath, ...extraRoots] : [], [rootPath, extraRoots])
  // Nested roots use the most specific folder for file operations.
  const workspaceRootFor = path => workspaceRoots.reduce((best, root) => root.length > best.length &&
    (sameFolder(path, root) || withinFolder(path, root)) ? root : best, '')
  const bindingKey = 'dsh.world.git-folder:' + (/^[a-z]:\//i.test(rootPath) ? rootPath.toLowerCase() : rootPath)
  const bindingCache = React.useRef(new Map())
  const [bindingRevision, bumpBinding] = React.useReducer(n => n + 1, 0)
  const boundGit = React.useMemo(() => {
    if (!rootPath || collectionMode) return ''
    if (bindingCache.current.has(bindingKey)) return bindingCache.current.get(bindingKey)
    try { return localStorage.getItem(bindingKey) || '' } catch { return '' }
  }, [bindingKey, rootPath, collectionMode, bindingRevision])
  const gitRoot = boundGit || rootPath
  const explorerRootFor = filePath => {
    if (!collectionMode) return workspaceRootFor(filePath) || rootPath
    const target = normalizePath(filePath)
    const match = collectionEntries.find(item => target === item.path || (item.type === 'directory' && withinFolder(target, item.path)))
    if (!match) return rootPath
    if (match.type === 'directory') return match.path
    const index = match.path.lastIndexOf('/')
    if (index < 0) return match.path
    const dir = match.path.slice(0, index) || '/'
    return /^[a-zA-Z]:$/u.test(dir) ? `${dir}/` : dir
  }
  const [tabs, setTabs] = React.useState(() => restoreFileTabs(fileSession, path => collectionMode
    ? explorerRootFor(path) : workspaceRootFor(path) || gitRoot))
  const [activeId, setActiveId] = React.useState(() => (tabs.find(tab => tab.path === fileSession?.active) || tabs[0])?.id || '')
  const [deck, setDeck] = React.useState(emptyDeck)
  const parentSeq = React.useRef(0)
  const bookmarks = React.useRef(new WeakMap())
  const foldCache = React.useRef(null)
  const [paneDrop, setPaneDrop] = React.useState(null)
  const draggedTab = React.useRef(null) // dragover cannot read the DataTransfer payload until drop.
  const [paneMounts] = React.useState(createPaneMounts)
  // 组 id 只在拖动分屏时新建，'main' 是没分屏时那个组
  const groupSeq = React.useRef(1)
  const makeGid = () => `g${++groupSeq.current}`
  const focusedGroup = React.useRef(null)
  // Draft changes do not invalidate the layout. Reconcile before committing portals so a
  // hidden editor never flashes or steals the active input during a parent switch.
  const idsKey = tabs.filter(tab => !tab.designKey).map(tab => tab.id).join('\n')
  const settled = React.useMemo(() => reconcileDeck(deck, idsKey ? idsKey.split('\n') : [], activeId, focusedGroup.current), [deck, idsKey, activeId])
  // 设计组的分组/比例按文件记住：每个文件切回源码再打开时还原上次的布局。
  // 拖动分隔条时 settled 每帧都变，写入合并到 300ms 一次；latest 始终指向最新树。
  const latestParents = React.useRef(settled.parents)
  latestParents.current = settled.parents
  const savedLayouts = React.useRef(new WeakMap())
  const { flush: flushLayout } = useWindowCache(() => {
    for (const parent of Object.values(settled.parents)) {
      if (!parent.srw) continue
      const saved = savedLayouts.current.get(parent.srw)
      if (saved?.layout === parent.layout && saved.active === parent.active) continue
      saveSrwLayout(parent.srw.layoutKey, packSrwLayout(parent.layout, parent.id), parent.active?.slice(parent.id.length + 1))
      savedLayouts.current.set(parent.srw, { layout: parent.layout, active: parent.active })
    }
  }, [settled.parents])
  if (settled !== deck) setDeck(settled)
  // The signature excludes document contents, so typing never schedules a desktop write.
  const fileSignature = React.useMemo(() => JSON.stringify(fileSessionOf(tabs, settled, activeId)), [tabs, settled, activeId])
  React.useLayoutEffect(() => { onFileSessionChange?.(windowKey, JSON.parse(fileSignature)) }, [windowKey, onFileSessionChange, fileSignature])
  const { root: visibleLayout, parents } = settled
  useSrwLifetime(parents)
  const owners = React.useMemo(() => ownership(parents), [parents])
  const outerActive = owners.get(activeId) || activeId
  const visibleTabs = React.useMemo(() => visibleTabIds(visibleLayout).flatMap(id => parents[id] ? visibleTabIds(parents[id].layout) : [id]), [visibleLayout, parents])
  const visibleSet = React.useMemo(() => new Set(visibleTabs), [visibleTabs])
  const splitMode = visibleTabs.length > 1 || owners.has(activeId)
  const activateTab = id => setActiveId(parents[id]?.active || id)
  const changeLayout = (scope, fn) => setDeck(current => editLayout(current, scope, fn))
  const dockRequests = React.useRef(new Map())
  const [findTarget, setFindTarget] = React.useState(''), [findQuery, setFindQuery] = React.useState('')
  const [findReplacement, setFindReplacement] = React.useState(''), [findReplace, setFindReplace] = React.useState(false)
  /** 虚拟化视图的文本在 CodeMirror 里：同步过快照之后靠它把匹配重算一遍。 */
  const [findNonce, setFindNonce] = React.useState(0)
  const [findCase, setFindCase] = React.useState(false), [findIndex, setFindIndex] = React.useState(-1)
  const findInputRef = React.useRef(null), findReplaceInputRef = React.useRef(null)
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
  const [gitPick, setGitPick] = React.useState(null)
  const [gitOp, setGitOp] = React.useState('')
  const [gitMsg, setGitMsg] = React.useState(null)
  const [gitHistory, setGitHistory] = React.useState(null)
  const [historyOpen, setHistoryOpen] = React.useState(true)
  const [historyDetails, setHistoryDetails] = React.useState(() => new Set())
  const [historyFiles, setHistoryFiles] = React.useState(() => new Map())
  const historyFilesRef = React.useRef(new Map())
  const discardPrompt = React.useRef(false)
  const historyRequest = React.useRef(0)
  /** 折叠着的 Git 目录（键 = 分组 + 仓库相对目录）；默认全展开，换仓库时清空。 */
  const [gitClosed, setGitClosed] = React.useState(() => new Set())
  const [commitDraft] = React.useState(createCommitDraft)
  const [picker, setPicker] = React.useState(null)
  const [quickOpen, setQuickOpen] = React.useState(false)
  const [pickerDraft, setPickerDraft] = React.useState('')
  /** 别的插件留下的可打开目录：IMA 虚拟工作区、PowerBuilder 工程工作区。 */
  const [pluginRoots, setPluginRoots] = React.useState(null)
  const [openingProject, setOpeningProject] = React.useState('')
  const projectRequest = React.useRef(false)
  const pendingProject = openingProject || desktopOpeningProject
  const [fileMenu, setFileMenu] = React.useState(null)
  const fileMenuRef = React.useRef(null)
  const [tabMenu, setTabMenu] = React.useState(null)
  const tabMenuRef = React.useRef(null)
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
  const largeHandles = React.useRef(new Map())
  /**
   * 最近一次源码编辑器的快照，给「对话」标签代入上下文用。
   * 对话标签激活后 currentInput() 已经拿不到编辑器选区，所以在光标/选区变化时顺手记下来。
   */
  const editorContext = React.useRef(null)
  /** path → 最近一次读到的文件版本：自动刷新和保存用它区分「外部改了」和「刚才是自己写的」。 */
  const versionsRef = React.useRef(new Map())
  const currentInput = () => largeHandles.current.get(activeIdRef.current) || textareaRef.current
  /** 不可见的排版镜像层：只在折行时挂载，用来量每行折成几行。 */
  const measureRef = React.useRef(null)
  /** 折行时的高亮层：宽度要和镜像层一模一样，否则断行点不同、颜色就会错位。 */
  const highlightRef = React.useRef(null)
  const wrapTopsRef = React.useRef(null)
  /** 折行行高的尺子（见 createWrapRuler）：跨按键复用上一次量到的行高。 */
  const wrapRuler = React.useRef(null)
  if (!wrapRuler.current) wrapRuler.current = createWrapRuler()
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
  React.useLayoutEffect(() => bindSourceHistory(shellRef.current, id => tabsRef.current.find(t => t.id === id)), [])
  const activeIdRef = React.useRef(activeId)
  const treeRef = React.useRef(tree)
  const gitRef = React.useRef(git)
  const gitOpRef = React.useRef(gitOp)
  const gitTaskRef = React.useRef(null)
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
  pickerOpenRef.current = Boolean(picker || quickOpen || errorDetails)
  tabsRef.current = tabs
  activeIdRef.current = activeId
  treeRef.current = tree
  gitRef.current = git
  gitOpRef.current = gitOp
  sideViewRef.current = sideView
  sidebarOpenRef.current = sidebarOpen
  sidebarWidthRef.current = sidebarWidth
  const pbProject = sameFolder(pluginRoots?.currentProject?.root, rootPath) ? pluginRoots.currentProject : null
  const pbLibraries = React.useMemo(() => new Set((pbProject?.libraryNames || []).map(s => s.toLowerCase())), [pbProject])
  const objectIndex = React.useMemo(() => projectObjects(async signal => unwrap(await rpc.call('/api',
    'world-vscode-roots/objects', { root: rootPath, binaryNames: true }, signal))), [rpc, rootPath, session?.id, pbProject?.libraryNames])
  React.useEffect(() => () => objectIndex.clear(), [objectIndex])
  const adoptingApplication = React.useRef(new Set())
  React.useLayoutEffect(() => { adoptingApplication.current.clear() }, [tabs])
  const readApplication = React.useCallback(async (path, signal) => unwrap(await rpc.call('/api', 'world-vscode-source/open', {
    sessionId: session.id, root: rootPath, path,
  }, signal)), [rpc, session?.id, rootPath])
  const applicationFor = objectPath => {
    if (!withinFolder(normalizePath(objectPath), rootPath)) return null
    let path
    if (pbProject) {
      const app = pbProject.application
      if (app) path = joinPath(joinPath(rootPath, app.library), app.name)
    } else {
      // Loose exports have no target metadata. Only use an unambiguous sibling,
      // never pick an SRA from another library or a partially listed folder.
      const folder = dirName(normalizePath(objectPath)), listing = tree.get(folder)
      if (!listing?.entries || listing.truncated) return null
      const apps = listing.entries.filter(e => e.type === 'file' && /\.sra$/i.test(e.name))
      if (apps.length === 1) path = joinPath(folder, apps[0].name)
    }
    if (!path) return null
    const owner = tabsRef.current.find(t => (!t.kind || t.designKey) && sameFolder(t.path, path))
    return { path, owner, read: readApplication, saving, attach: doc => attachApplication(path, doc),
      changed: () => pinDesignOwner(owner) }
  }
  const gitScope = JSON.stringify([session?.id, rootPath, gitRoot, collectionMode])
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
  const active = tabs.find(tab => tab.id === activeId) || null
  const findAvailable = Boolean(active?.document && !active.kind)
  const scriptFind = active?.kind === 'srw-view' && active.view === 'script'
  const findMatches = React.useMemo(() => findAvailable && findTarget === activeId ? findTextOffsets(tabText(active), findQuery, findCase) : [],
    [findAvailable, findTarget, activeId, active?.document, active?.draft, findQuery, findCase, findNonce])
  const dockSignature = dockedApps.map(app => `${app.id}:${app.nonce}:${app.focusNonce || 0}`).join('|')
  React.useEffect(() => {
    const ids = new Set(dockedApps.map(app => `app:${app.id}`))
    setTabs(current => current.filter(tab => tab.kind !== 'app' || ids.has(tab.id)))
    for (const app of dockedApps) {
      const id = `app:${app.id}`
      setTabs(current => current.some(tab => tab.id === id) ? current : [...current, { id, appId: app.id, path: app.label, kind: 'app', pinned: true }])
      const request = `${app.nonce}:${app.focusNonce || 0}`
      if (dockRequests.current.get(app.id) === request) continue
      const fresh = !dockRequests.current.has(app.id)
      dockRequests.current.set(app.id, request)
      setBatchCollapsed(true)
      if (fresh && app.placement?.edge && app.placement.tab) {
        // 拖进来的应用按落点分屏：落点记的是当时那个标签，先换算成它所在的组。
        // 落在当前这一格（多半是它的标签栏）就并进这一组 —— 标签栏在格子最上面，
        // 按几何算很容易被判成「顶边」，那样每拖一个应用进来都会多出一格。
        changeLayout('', layout => {
          // placement.tab 可能记的是标签 id（落在标签栏），也可能是组 id（落在内容区）
          const sourceGid = tabGroupOf(layout, app.placement.tab)
            || (groupById(layout, app.placement.tab) ? app.placement.tab : null)
          return sourceGid ? splitWithTab(layout, sourceGid, id, app.placement.edge, makeGid()) : layout
        })
      }
      if (!(fresh && app.placement?.restoreBackground && activeId)) setActiveId(id)
    }
    for (const id of dockRequests.current.keys()) if (!dockedApps.some(app => app.id === id)) dockRequests.current.delete(id)
  }, [dockSignature, rootPath])
  React.useLayoutEffect(() => () => docking?.releaseOwner(windowKey), [docking, windowKey])
  React.useEffect(() => {
    const gid = tabGroupOf(visibleLayout, outerActive)
    if (gid) focusedGroup.current = gid
  }, [visibleLayout, outerActive])
  const dirty = tabs.some(isDirty)
  const designOwner = active?.kind === 'srw-view' ? tabs.find(tab => tab.designKey === owners.get(active.id)) : null
  // Variables/Global is a view of the application's document, never a patch on the SRW/SRU.
  const saveOwner = (target, owner) => {
    if (target?.view !== 'variables' || !owner || /\.sra$/i.test(owner.path) || !['global', 'globalExternal'].includes(owner.srw.state.declare)) return owner || target
    const app = applicationFor(owner.path)?.owner
    return app?.srw ? app : null
  }
  const activeDirty = isDirty(saveOwner(active, designOwner))
  // 状态栏右侧那句「为什么不能改」：服务端只读（GBK 之类）和文件过大要分开说
  const readOnlyLabel = active?.document
    ? (active.document.readOnly ? `${active.document.encoding || '文档'} · 只读` : isLocked(active) ? '文件过大 · 只读' : '')
    : ''
  const language = languageOf(active?.path)
  const {rows: testRows, gutter: activeTestGutter, pending: testsPending} = fileTests(active)
  const [, redrawTests] = React.useReducer(n => n + 1, 0)
  const publishTests = React.useCallback((doc, blocks) => {
    if (blocks) largeTestPlans.set(doc, testPlan(blocks))
    else {
      const prior = largeTestPlans.get(doc)
      if (!prior || prior.pending) return
      // Keep the open run panel in place. Old rows must not execute, even if a
      // fast save makes the editor clean before indexing this revision finishes.
      largeTestPlans.set(doc, {rows: prior.rows, gutter: noTests.gutter, pending: true})
    }
    redrawTests()
  }, [])
  const canShowRun = Boolean(pbProject || testRows.size)
  React.useEffect(() => { if (!canShowRun && sideView === 'run') setSideView('files') }, [canShowRun, sideView])
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
    if (!node || splitMode) return
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
  }, [active?.id, Boolean(active?.document), splitMode])

  /**
   * 折行以后「第 n 行 = n × 行高」不再成立：一行折成几行只有排版引擎知道。
   * 所以拿一个不可见的镜像层（同字体、同宽度、同 pre-wrap）把每逻辑行单独排一遍，读回高度做前缀和。
   * 行号槽与当前行底纹都按这个前缀和绝对定位；折行关掉时走老路，一个 div 都不建。
   */
  React.useLayoutEffect(() => {
    const drop = () => {
      if (!wrapTopsRef.current) return
      wrapTopsRef.current = null
      setWrapTops(null)
    }
    if (!wrap) { drop(); return }
    const node = textareaRef.current
    const layer = measureRef.current
    if (!node || !layer) { drop(); return }
    const value = active?.draft || ''
    const count = countLines(value, active?.document)
    if (count > WRAP_MEASURE_LIMIT) { drop(); return }
    const style = window.getComputedStyle(node)
    const width = node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
    if (!width) return
    // 高亮层用同一份宽度：少 1px 就可能提前一个字折行，颜色整片错位
    setWrapWidth(current => current === width ? current : width)
    const tops = wrapRuler.current.measure({ layer, value, width, lineHeight, round: true })
    // 几何没变时 tops 是同一个引用：setState 直接跳过，打字不再整棵编辑器重渲染
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
  }, [wrap, active?.draft, active?.id, lineHeight, viewportWidth, splitMode])

  React.useLayoutEffect(() => {
    caretCache.current = null
    const viewer = largeHandles.current.get(active?.id)
    if (viewer) { viewer.reportCaret(); return }
    const node = textareaRef.current
    if (!node) { setCaretLine(0); setCaretColumn(0); return }
    if (splitMode) { syncCaret(node); return } // SplitSource restores its own surface.
    const doc = active?.document, saved = bookmarks.current.get(doc)
    const restore = () => {
      if (saved) {
        node.setSelectionRange(saved.start, saved.end, saved.direction)
        node.scrollTop = saved.top; node.scrollLeft = saved.left
      }
      scrollTopRef.current = node.scrollTop
      setScrollTop(node.scrollTop); setScrollLeft(node.scrollLeft); syncCaret(node)
    }
    // A newly mounted portal may not yet be attached to its pane.
    const frame = node.clientHeight ? (restore(), 0) : requestAnimationFrame(restore)
    return () => { cancelAnimationFrame(frame); rememberTextPosition(bookmarks.current, doc, node) }
  }, [active?.id, active?.path, active?.document, splitMode])

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
    rememberTextPosition(bookmarks.current, active?.document, node)
    scrollTopRef.current = node.scrollTop
    if (scrollFrame.current) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0
      setScrollTop(scrollTopRef.current)
      setScrollLeft(textareaRef.current?.scrollLeft ?? 0)
    })
  }

  /** 只数光标前的换行符，不切分整段文本：5 万行的文件里每次点一下也不会卡。 */
  /**
   * 光标所在行列。
   * 每敲一个字符都从头数一遍换行，1.4MB 的文件要 5ms 以上、正好把一帧吃满；
   * 打字和退格是「只动了一个字符」的特例，拿上一次的缓存挪一位即可，
   * 其余情况（跳转、粘贴、替换）仍老老实实重扫。
   */
  const caretCache = React.useRef(null)
  const syncCaret = node => {
    if (!node) return
    const value = node.value
    const end = node.selectionStart
    const cache = caretCache.current
    let line = 0
    let lineStart = 0
    // 只校验光标附近 4KB：打字/退格改的永远是光标脚下，整段 startsWith 在 1.4MB 文本上要 2~3ms
    const prefixSame = length => {
      if (length > value.length || length > cache.value.length) return false
      const from = Math.max(0, length - 4096)
      return value.slice(from, length) === cache.value.slice(from, length)
    }
    const inserted = cache && value.length === cache.value.length + 1 && end === cache.offset + 1 && prefixSame(cache.offset)
    const removed = cache && value.length === cache.value.length - 1 && end === cache.offset - 1 && prefixSame(end)
    if (cache && cache.value === value && cache.offset === end) {
      // 同一个位置被问了两次（onChange 之后紧跟 onSelect / onClick）：直接用上次的结果
      line = cache.line
      lineStart = cache.lineStart
    } else if (inserted) {
      line = cache.line
      lineStart = cache.lineStart
      if (value.charCodeAt(end - 1) === 10) { line += 1; lineStart = end }
    } else if (removed) {
      line = cache.line
      lineStart = cache.lineStart
      if (cache.value.charCodeAt(cache.offset - 1) === 10) {
        line = Math.max(0, line - 1)
        // 删掉的那个换行之前，最后一个换行之后就是新的行首
        lineStart = value.lastIndexOf('\n', cache.offset - 2) + 1
      }
    } else {
      const index = node.worldLineStarts
      if (index && node.worldIndexedText === value) {
        line = lineOfOffset(index, end); lineStart = index[line]
      } else {
        for (let i = 0; i < end; i++) if (value.charCodeAt(i) === 10) { line++; lineStart = i + 1 }
      }
    }
    caretCache.current = { value, offset: end, line, lineStart }
    const column = end - lineStart
    setCaretLine(current => current === line ? current : line)
    setCaretColumn(current => current === column ? current : column)
    // 对话标签激活后就切走了，选区只在这里留一份；点「文件 / 选区」时再切片算行号。
    const tab = tabsRef.current.find(t => t.id === activeIdRef.current)
    if (tab && !tab.kind && tab.document) editorContext.current = {
      path: tab.path, line: line + 1, column: column + 1, value,
      start: node.selectionStart, end: node.selectionEnd, dirty: isDirty(tab),
    }
  }

  /** 目录列表与「打开文件夹」对话框共用宿主的一个入口，工作区外的文件夹也能读。 */
  const loadDir = dirPath => {
    const reads = dirReads.current
    if (reads.has(dirPath)) return reads.get(dirPath).promise
    const controller = new AbortController()
    const root = explorerRootFor(dirPath)
    const update = fields => setTree(current => new Map(current).set(dirPath, { ...current.get(dirPath), ...fields }))
    update({ loading: true, error: '' })
    const promise = Promise.resolve().then(() => rpc.call('/api', 'world-vscode-source/list', {
      sessionId: session.id, path: dirPath, root,
    }, controller.signal)).then(unwrap).then(value => {
      if (controller.signal.aborted) return EMPTY_FILES
      const entries = value.entries.filter(item => item && typeof item.name === 'string')
      update({ entries, truncated: value.truncated, recentObjects: value.recentObjects, loading: false })
      if (value.truncated) setNotice('目录条目过多，列表已截断。')
      return entries
    }).catch(cause => {
      if (!controller.signal.aborted) update({ error: String(cause?.message || cause), loading: false })
      return EMPTY_FILES
    }).finally(() => {
      if (reads.get(dirPath)?.controller === controller) reads.delete(dirPath)
    })
    reads.set(dirPath, { promise, controller })
    return promise
  }

  // Only warm the folder the mouse settles on; never recursively enumerate siblings.
  const warmDir = dirPath => {
    window.clearTimeout(warmTimer.current)
    if (dirPath && !treeRef.current.has(dirPath)) {
      warmTimer.current = window.setTimeout(() => {
        if (!treeRef.current.has(dirPath) && !dirReads.current.size) void loadDir(dirPath)
      }, 120)
    }
  }

  const listedRoots = React.useRef(new Set())
  React.useEffect(() => {
    const reads = dirReads.current
    listedRoots.current.clear()
    if (collectionMode) {
      setTree(new Map([[treeRoot, { entries: collectionEntries }]]))
      setExpanded(new Set([treeRoot]))
      setSideView('files')
    } else {
      setTree(new Map())
      setExpanded(new Set())
    }
    setError('')
    return () => {
      window.clearTimeout(warmTimer.current)
      for (const { controller } of reads.values()) controller.abort()
      reads.clear()
    }
  }, [session?.id, rootPath, collectionMode, treeRoot, collectionSignature])

  React.useEffect(() => {
    if (!session?.id) return
    const added = workspaceRoots.filter(root => !listedRoots.current.has(root))
    if (!added.length) return
    setExpanded(current => new Set([...current, ...added]))
    for (const root of added) { listedRoots.current.add(root); void loadDir(root) }
  }, [session?.id, workspaceRoots])

  const toggleDir = dirPath => {
    if (expanded.has(dirPath)) {
      setExpanded(current => { const next = new Set(current); next.delete(dirPath); return next })
      return
    }
    setExpanded(current => new Set(current).add(dirPath))
    if (!tree.get(dirPath)?.entries || tree.get(dirPath)?.error) void loadDir(dirPath)
  }

  /** 重新读取当前展开的目录，保住展开状态。 */
  const refreshTree = async () => {
    objectIndex.clear()
    setTabMenu(current => current?.script ? null : current)
    const open = [...expanded].filter(dir => dir !== collectionKey && !dir.includes("\0"))
    setTree(current => new Map([...current].filter(([dir]) => expanded.has(dir) || dir === collectionKey)))
    await Promise.all(open.map(dir => loadDir(dir)))
  }

  const loadFile = (id, path, preserveDraft = false, signal, rootOverride) => {
    if (signal?.aborted) return Promise.resolve({ error: signal.reason })
    const backing = tabsRef.current.find(t => t.id === id && t.designKey)
    if (backing && preserveDraft) {
      if (isDirty(backing) || savingRef.current) return Promise.resolve({ error: desktopError('设计组有未保存的修改，已保留草稿。', 'WORLD_DESKTOP_DIRTY') })
      restoreSource(backing)
    }
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
    const root = rootOverride || explorerRootFor(path)
    const task = Promise.resolve(rpc.call('/api', 'world-vscode-source/open', { sessionId: session.id, root, path }, controller.signal))
      .then(unwrap)
      .then(value => {
        if (!mounted.current || controller.signal.aborted) return
        if (preserveDraft && isDirty(tabsRef.current.find(tab => tab.id === id)))
          throw desktopError('读取期间文件产生了未保存修改，已保留草稿。', 'WORLD_DESKTOP_DIRTY')
        const loaded = virtualSource(path, value.source)
          ? { document: largeDocument({ ...value, huge: value.source.length > CM_EDIT_MAX }), draft: '', edited: false, version: value.version }
          : { document: value, draft: value.source, edited: false, version: value.version }
        // Publish a completed read, not a still-pending tab; promotion must not depend on
        // which simultaneous directory/file read happens to clear the busy indicator.
        if (pending.current.get(path)?.controller === controller) pending.current.delete(path)
        versionsRef.current.set(path, value.version)
        setTabs(list => list.map(tab => tab.id === id && tab.path === path
          ? { ...tab, ...loaded, foldEditor: null, editHistory: null, stale: false,
            reload: preserveDraft && tabText(loaded) !== tabText(tab) ? (tab.reload || 0) + 1 : tab.reload } : tab))
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

  // Read restored sources on demand, after the host rebinds the session. A failed read removes
  // the tab; fall back to a survivor only if the user hasn't already selected something else.
  React.useEffect(() => {
    if (!session?.id || !activeId?.startsWith('restored-')) return
    if (!active) { setActiveId(visibleTabs.find(Boolean) || ''); return }
    if (!active.kind && !active.document && !pending.current.has(active.path)) void loadFile(active.id, active.path, false, undefined, active.root)
  }, [session?.id, activeId, active, visibleTabs])

  /**
   * 设计父标签的「已定住」以 owner 的 designPinned 为准：双击文件树时 pin 可能落在
   * 设计组建好之后，parent.pinned 来不及更新，这里实时合并两个来源。
   */
  const designPinned = parent => Boolean(parent?.pinned) ||
    Boolean(parent?.id) && tabs.some(tab => tab.designKey === parent.id && tab.designPinned)
  /** 双击文件树/标签时把设计组定住：owner 在 tabs 里，父标签在 deck.parents 里。 */
  const pinDesignOwner = owner => {
    if (!owner?.designKey) return
    setTabs(list => list.map(tab => tab.id === owner.id ? { ...tab, pinned: true, designPinned: true } : tab))
    setDeck(current => {
      const parent = current.parents[owner.designKey]
      return parent && !parent.pinned
        ? { ...current, parents: { ...current.parents, [owner.designKey]: { ...parent, pinned: true } } } : current
    })
  }
  /** Single click reuses one preview tab; double click pins it so the next click opens another tab. */
  const openFile = async (filePath, pin = false, signal, rootOverride, mode = 'default') => {
    // 手机上侧栏是抽屉：点文件就是在「选它」，选完该把正文让出来
    if (phone) setDrawerOpen(false)
    let list = tabsRef.current
    // Diff 标签与源码标签共用 path，但打开源码时必须跳过它
    const existing = list.find(tab => tab.path === filePath && tab.kind !== 'diff')
    const inFlight = pending.current.get(filePath)
    const root = rootOverride || explorerRootFor(filePath)
    const kind = isDocumentPreviewPath(filePath) ? 'document' : undefined
    const openAsDesign = mode !== 'source' && painterPath(filePath)
    if (existing?.designKey) {
      if (pin) pinDesignOwner(existing)
      if (openAsDesign) {
        setActiveId(parents[existing.designKey]?.active || `${existing.designKey}:${existing.srw.hasLayout ? 'layout' : 'script'}`)
        return { id: existing.id, task: Promise.resolve() }
      }
      if (savingRef.current) { setError('请等待保存完成后再切回源码。'); return }
      restoreSource(existing)
      return { id: existing.id, task: Promise.resolve() }
    }
    if (existing || inFlight) {
      const id = existing?.id || inFlight.id
      if (pin || mode === 'source') {
        setTabs(current => current.map(tab => tab.id === id
          ? { ...tab, pinned: tab.pinned || pin, openAsDesign: tab.openAsDesign && mode !== 'source' } : tab))
        // 设计组的 owner 标签被定住时，父标签也要一起定住（否则单击打开建出的组还是预览态）
        if (pin) pinDesignOwner(existing)
      }
      setActiveId(id)
      return { id, task: inFlight?.task || (existing && !existing.kind && !existing.document
        ? loadFile(id, filePath, false, signal, existing.root || root) : Promise.resolve()) }
    }
    // 设计组默认也是预览标签：打开新文件先让它让位；双击定住过的不动。
    if (!pin) {
      const stale = Object.values(parents).filter(parent => parent.srw && !designPinned(parent))
      for (const parent of stale) if (!(await closeTabs([parent.id]))) return
      if (stale.length) list = tabsRef.current
    }
    // 分组里的成员是用户显式组织过的：即使它还是 preview 状态，也不让新打开的文件顶掉。
    const preview = pin ? null : list.find(tab => !tab.pinned && !tab.designKey && tab.kind !== 'diff' && !owners.has(tab.id))
    if (preview) {
      if (isDirty(preview) && !await worldConfirm({
        title: '放弃未保存的修改',
        message: `预览标签「${baseName(preview.path)}」还有未保存的修改，打开 ${baseName(filePath)} 会把它顶掉。`,
        confirmLabel: '放弃并打开',
        danger: true,
      })) return
      setTabs(current => current.map(tab => tab.id === preview.id
        ? { ...tab, path: filePath, root, kind, openAsDesign, document: null, draft: '' } : tab))
      setActiveId(preview.id)
      if (kind) {
        for (const [path, entry] of pending.current) if (entry.id === preview.id) { entry.controller.abort(); pending.current.delete(path) }
        setBusyFile('')
      }
      return { id: preview.id, task: kind ? Promise.resolve() : loadFile(preview.id, filePath, false, signal, root) }
    }
    const id = `tab-${++nextTabId.current}`
    setTabs(current => [...current, { id, path: filePath, root, kind, openAsDesign, pinned: pin, document: null, draft: '' }])
    setActiveId(id)
    return { id, task: kind ? Promise.resolve() : loadFile(id, filePath, false, signal, root) }
  }

  const designFile = tab => tab && !tab.kind && painterPath(tab.path)
  // 设计组默认左右分栏。固定 80:20 会把属性栏压到一百来像素（窄窗口连一个标签都放不下），
  // 所以按编辑器实际可用宽度反推比例：右栏至少 240px；窄到摆不下两栏就改成上下堆叠。
  const designLayout = () => {
    const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth
    const available = Math.max(320, (rect.w / 100) * viewport - (sidebarOpen && !phone ? sidebarWidth : 0) - (phone ? 0 : 48))
    if (available < 560) return { axis: 'column', ratio: .56 }
    return { axis: 'row', ratio: Math.min(.78, Math.max(.52, 1 - 240 / available)) }
  }
  // A hidden backing document owns the path/root/version, not a second editor tab.
  const showDesign = (tab, text, model, readBase, background = false) => {
    flushLayout()
    setTabMenu(null)
    if (!designFile(tab) || !tab.document || tab.designKey) return
    if (savingRef.current || pending.current.has(tab.path)) { setError('请等待当前读写完成再切换视图。'); return }
    const key = `parent-${++parentSeq.current}`
    // 双击文件树时，pin 可能落在 loadFile 完成之前：设计组按 tabsRef 里的最新状态决定预览/定住。
    const snapshot = tabsRef.current.find(t => t.id === tab.id) || tab
    const designPin = background || Boolean(snapshot.designPinned ?? snapshot.pinned)
    const preset = srwPreset(key, tab.path, text, makeGid, { model, readBase, readOnly: isLocked(tab), dirty: isDirty(tab), pinned: designPin, ...designLayout() })
    const srw = preset.parent.srw
    // owner 本身必须 pinned（它不出现在标签栏，不能被预览替换）；设计组的预览状态记在 designPinned 上，
    // 切回源码再打开时沿用，不会被 owner 的 pinned 顶成「已定住」。
    setTabs(list => {
      const sourceTabs = background && !list.some(t => t.id === tab.id) ? [...list, tab] : list
      return [...sourceTabs.map(t => t.id === tab.id ? { ...t, document: tab.document, openAsDesign: false, pinned: true, designPinned: designPin,
        kind: 'srw-owner', version: tab.document.large ? tab.version ?? tab.document.version : tab.document.version, designKey: key, srw } : t), ...preset.tabs]
    })
    setDeck(current => {
      // 文件原来在父标签组里：只把成员摘出来，组本身留在外层（空组）——
      // 直接把组拆掉会让用户建好的分组连同位置一起消失。
      if (owners.has(tab.id)) {
        const gid = tabGroupOf(current.root, owners.get(tab.id))
        const deck = detachMember(current, tab.id)
        return { root: gid ? addTab(deck.root, gid, key) : deck.root, parents: { ...deck.parents, [key]: preset.parent } }
      }
      return { root: replaceId(current.root, tab.id, key), parents: { ...current.parents, [key]: preset.parent } }
    })
    if (!background) setActiveId(preset.parent.active)
  }
  // One real SRA painter owns version checks, save spans, pending edits and close prompts for all views.
  const attachApplication = (path, doc) => {
    const existing = tabsRef.current.find(t => (!t.kind || t.designKey) && sameFolder(t.path, path))
    if (existing?.srw || savingRef.current || pending.current.has(path) || adoptingApplication.current.has(path)) return
    let tab = existing, text
    if (existing?.document) {
      if (doc) return // A source tab opened during the async read. Use its live draft only on explicit conversion.
      text = largeSource(existing) && existing.edited ? syncLargeSnapshot(existing)?.text : tabText(existing)
      if (text == null) { setError('请先保存已打开的应用程序源码草稿。'); return }
    } else {
      text = doc?.source
      if (typeof text !== 'string') return
      const large = virtualSource(path, text)
      tab = { ...existing, id: existing?.id || `tab-${++nextTabId.current}`, path, root: rootPath, pinned: true,
        document: large ? largeDocument({ ...doc, huge: text.length > CM_EDIT_MAX }) : doc, draft: large ? '' : text }
    }
    adoptingApplication.current.add(path)
    showDesign(tab, text, null, undefined, true)
  }
  const openDesign = tab => {
    setTabMenu(null)
    if (!designFile(tab) || !tab.document) return
    if (savingRef.current || pending.current.has(tab.path)) { setError('请等待当前读写完成再切换视图。'); return }
    // The source surface unmounts while the painter opens. Preserve its live large-file snapshot.
    const document = largeSource(tab) ? largeDocument({ ...tab.document,
      source: tab.edited ? syncLargeSnapshot(tab)?.text ?? tabText(tab) : tabText(tab),
    }) : tab.document
    setTabs(list => list.map(t => t.id === tab.id ? { ...t, document, openAsDesign: true } : t))
    setActiveId(tab.id)
  }
  // Only the active request may promote its tab. Cancel an unfinished SRU scan if the user switches files.
  React.useLayoutEffect(() => {
    if (!active?.openAsDesign || !active.document || saving || pending.current.has(active.path)) return
    const text = tabText(active)
    if (/\.sru$/i.test(active.path)) {
      const folder = dirName(normalizePath(active.path)), root = active.root || rootPath, sessionId = session.id
      const readBase = async (name, signal) => unwrap(await rpc.call('/api', 'world-vscode-source/open', {
        sessionId, root, path: joinPath(folder, `${name}.sru`),
      }, signal)).source
      return parsePainter(text, active.path, model => showDesign(active, text, model, readBase), readBase)
    }
    showDesign(active, text)
  }, [active, saving, busyFile])
  const restoreSource = owner => {
    flushLayout()
    const { designKey, srw, kind, foldEditor, ...tab } = owner
    const draft = designText(srw), edited = isDirty(owner), virtual = tab.document.large || virtualSource(tab.path, draft)
    const normal = virtual ? { ...tab, document: largeDocument({ ...tab.document, source: draft, huge: draft.length > CM_EDIT_MAX }), draft: '', edited }
      : { ...tab, draft, edited }
    setTabs(list => list.filter(t => !t.id.startsWith(`${designKey}:`)).map(t => t.id === tab.id ? normal : t))
    setDeck(deck => {
      const parents = { ...deck.parents }; delete parents[designKey]
      return { root: replaceId(deck.root, designKey, tab.id), parents }
    })
    setActiveId(tab.id)
  }
  const designDirtyChanged = srw => setTabs(list => list.map(tab => tab.srw === srw ? { ...tab } : tab))
  const openDesignView = (parent, view) => {
    const id = `${parent.id}:${view}`
    if (!tabsRef.current.some(tab => tab.id === id)) {
      setTabs(list => [...list, { id, view, path: `${parent.id}/${srwViews[view]}`, kind: 'srw-view', pinned: true }])
      changeLayout(parent.id, layout => addTab(layout, tabGroupOf(layout, parent.active), id))
    }
    setActiveId(id)
  }
  // 设计组和普通文件一样先是预览标签，双击定住；父标签不在 tabs 里，要一起改 deck。
  const pinTab = id => {
    setTabs(list => list.map(tab => tab.id === id || tab.designKey === id
      ? { ...tab, pinned: true, ...(tab.designKey === id ? { designPinned: true } : {}) } : tab))
    setDeck(current => {
      const parent = current.parents[id]
      return parent && !parent.pinned ? { ...current, parents: { ...current.parents, [id]: { ...parent, pinned: true } } } : current
    })
  }

  /**
   * 外部改了磁盘上的 .srw/.sru：重读源码并重解析模型，保留分组布局和当前视图，不切回源码。
   * 有未保存草稿时不动（调用方只打 stale 标记）。
   */
  const refreshDesign = React.useCallback(async (parent, expectVersion) => {
    const owner = tabsRef.current.find(t => t.designKey === parent.id)
    if (!owner?.document || isDirty(owner)) return false
    let cancel = () => {}
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-source/open', {
        sessionId: session.id, root: owner.root || rootPath, path: owner.path,
      }))
      if (expectVersion && value.version !== expectVersion) return false
      const text = value.source
      const model = await new Promise((resolve, reject) => {
        try { cancel = parsePainter(text, owner.path, resolve, parent.srw.readBase) } catch (error) { reject(error) }
      })
      // The design group and its hidden source tab must share the same snapshot after a reload.
      if (!mounted.current || !tabsRef.current.some(t => t.srw === parent.srw && !isDirty(t))) return false
      const srw = { ...parent.srw, text, model, edits: createEdits() }
      versionsRef.current.set(owner.path, value.version)
      setTabs(list => list.map(tab => tab.srw === parent.srw
        ? { ...tab, srw, document: value, version: value.version, draft: '', edited: false, stale: false, reload: (tab.reload || 0) + 1 } : tab))
      setDeck(current => {
        const live = current.parents[parent.id]
        return live?.srw === parent.srw ? { ...current, parents: { ...current.parents, [parent.id]: { ...live, srw } } } : current
      })
      return true
    } catch (cause) {
      if (mounted.current) setError(String(cause?.message || cause))
      return false
    } finally { cancel() }
  }, [session?.id, rootPath, rpc])

  const loadFileRef = React.useRef(null)
  loadFileRef.current = loadFile
  /** 手动重读被外部改过的标签（设计组重解析，普通文件走 loadFile 的保草稿读取）。 */
  const reloadStale = async tab => {
    if (!tab) return
    if (tab.designKey) {
      const parent = latestParents.current?.[tab.designKey]
      if (parent) await refreshDesign(parent)
      return
    }
    await loadFile(tab.id, tab.path, true)
  }
  /**
   * 对话里的工具改了文件后，编辑器要自己跟上，但不能整窗重渲染：
   * 批量取一次版本（窗口可见时才跑），只有版本号变了才动那一个标签。
   * 空闲时退到 3s 一次、有变化立刻回到 1.5s；草稿不覆盖，只打 stale 标记，
   * 大文件和设计组按各自的方式处理。
   */
  React.useEffect(() => {
    if (!session?.id || !isActive || minimized || collectionMode) return undefined
    let stopped = false, timer = 0, running = false
    const known = versionsRef.current
    const markStale = id => setTabs(list => list.some(tab => tab.id === id && !tab.stale)
      ? list.map(tab => tab.id === id ? { ...tab, stale: true } : tab) : list)
    const poll = async () => {
      if (stopped || running || document.visibilityState === 'hidden') return false
      running = true
      let changed = false
      try {
        const groups = new Map()
        for (const tab of tabsRef.current) {
          if (!tab.document || tab.kind || tab.designKey) continue
          const root = tab.root || rootPath
          if (!groups.has(root)) groups.set(root, [])
          groups.get(root).push({ path: tab.path, tab, base: tab.version ?? tab.document.version })
        }
        for (const parent of Object.values(latestParents.current || {})) {
          if (!parent.srw) continue
          const owner = tabsRef.current.find(tab => tab.designKey === parent.id)
          if (!owner?.document) continue
          const root = owner.root || rootPath
          if (!groups.has(root)) groups.set(root, [])
          groups.get(root).push({ path: owner.path, parent, base: owner.version ?? owner.document.version })
        }
        for (const [root, items] of groups) {
          if (stopped) return changed
          let value
          try {
            value = unwrap(await rpc.call('/api', 'world-vscode-source/versions', {
              sessionId: session.id, root, paths: [...new Set(items.map(item => item.path))],
            }))
          } catch { return }   // 旧宿主没有 versions 接口：这一轮到此为止
          const found = new Map((value?.versions || []).map(row => [row.path, row.version]))
          for (const item of items) {
            const version = found.get(item.path)
            if (version === undefined) continue
            const previous = known.has(item.path) ? known.get(item.path) : item.base
            known.set(item.path, version)
            if (previous === undefined || previous === version) continue
            changed = true
            if (item.parent) {
              const owner = tabsRef.current.find(tab => tab.designKey === item.parent.id)
              if (!owner) continue
              if (isDirty(owner)) { markStale(owner.id); continue }
              await refreshDesign(item.parent, version)
              continue
            }
            const tab = tabsRef.current.find(t => t.id === item.tab.id && t.path === item.path)
            if (!tab) continue
            if (isDirty(tab) || tab.document.large) { markStale(tab.id); continue }
            await loadFileRef.current(tab.id, tab.path, true)
          }
        }
      } finally { running = false }
      return changed
    }
    let interval = 1500
    const schedule = () => {
      timer = window.setTimeout(async () => {
        let changed = false
        try { changed = await poll() } catch (error) { console.error('[world] file version poll failed', error) }
        interval = changed ? 1500 : Math.min(3000, interval + 500)
        if (!stopped) schedule()
      }, interval)
    }
    schedule()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [session?.id, isActive, minimized, collectionMode, rootPath, refreshDesign])

  // 桌面文件链接：窗口打开后自动把这个文件放进标签（同一窗口再次打开走 nonce 递增）。
  React.useEffect(() => {
    if (!openRequest?.path || !session?.id) return
    const path = normalizePath(openRequest.path)
    openFile(path, true)
  }, [openRequest?.nonce])

  /** 真正把标签摘掉（不确认）；批量关闭也走这里，保证一次只提交一次 tabs。 */
  const dropTab = id => {
    const list = tabsRef.current
    const index = list.findIndex(item => item.id === id)
    if (index < 0) return
    if (list[index].designKey) return closeTabs([list[index].designKey])
    const remaining = list.filter(item => item.id !== id)
    setTabs(remaining)
    if (id === activeIdRef.current) setActiveId(afterClose(remaining, index))
    for (const [path, entry] of pending.current) {
      if (entry.id === id) { entry.controller.abort(); pending.current.delete(path) }
    }
  }

  const confirmClose = async tab => !isDirty(tab) || worldConfirm({
    title: '关闭标签',
    message: `「${baseName(tab.path)}」还有未保存的修改，关闭后就没了。`,
    confirmLabel: '仍然关闭',
    danger: true,
  })

  const afterClose = (remaining, index) => {
    remaining = remaining.filter(tab => !tab.designKey)
    const parent = parents[owners.get(activeIdRef.current)]
    if (parent) {
      const gid = tabGroupOf(parent.layout, activeIdRef.current)
      const sibling = [...(groupById(parent.layout, gid)?.tabs || []), ...memberIds(parent.layout)]
        .find(id => remaining.some(tab => tab.id === id))
      if (sibling) return sibling
    }
    return remaining[Math.min(index, remaining.length - 1)]?.id || ''
  }
  const closeTab = async id => {
    if (parents[id] || parents[owners.get(id)]?.srw) return closeTabs([id])
    const tab = tabsRef.current.find(item => item.id === id)
    if (tab?.kind === 'app') docking?.undock(tab.appId)
    if (!await confirmClose(tab)) return
    dropTab(id)
  }

  /** 关闭一批标签：有未保存的逐个确认，中途取消就停在已确认的那些。 */
  const closeTabs = async ids => {
    flushLayout()
    const targets = []
    const closing = new Set(ids.flatMap(id => parents[id] ? memberIds(parents[id].layout) : [id]))
    // 空分组没有成员可确认：直接从布局里摘掉父标签，别留一个点不掉的组。
    if (!closing.size && ids.some(id => parents[id])) {
      const empty = new Set(ids.filter(id => parents[id]))
      setDeck(current => {
        let root = current.root
        const next = { ...current.parents }
        for (const id of empty) { root = removeTab(root, id); delete next[id] }
        return { root, parents: next }
      })
      const list = tabsRef.current
      setActiveId(afterClose(list, Math.max(0, list.findIndex(tab => tab.id === activeIdRef.current))))
      return true
    }
    // Closing a single script panel keeps the draft. Closing the last panel or the parent
    // checks the document once, before removing any sibling tabs.
    for (const tab of tabsRef.current) if (tab.designKey && memberIds(parents[tab.designKey]?.layout).every(id => closing.has(id))) closing.add(tab.id)
    for (const id of closing) {
      const tab = tabsRef.current.find(item => item.id === id)
      if (!tab) continue
      if (!await confirmClose(tab)) return false
      targets.push(id)
    }
    if (!targets.length) return true
    const list = tabsRef.current
    for (const tab of list) if (targets.includes(tab.id) && tab.kind === 'app') docking?.undock(tab.appId)
    const remaining = list.filter(item => !targets.includes(item.id))
    setTabs(remaining)
    if (targets.includes(activeIdRef.current)) {
      const index = list.findIndex(item => item.id === activeIdRef.current)
      setActiveId(afterClose(remaining, index))
    }
    for (const [path, entry] of pending.current) {
      if (targets.includes(entry.id)) { entry.controller.abort(); pending.current.delete(path) }
    }
    return true
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
    const target = tabsRef.current.find(item => item.id === activeIdRef.current)
    const owner = target?.kind === 'srw-view' ? tabsRef.current.find(t => t.designKey === owners.get(target.id)) : null
    const tab = saveOwner(target, owner)
    // 快捷键和按钮可能在 React 提交状态前接连触发，同步占住同一条保存事务。
    if (!isDirty(tab) || savingRef.current) return
    if (tab.srw?.needsReview) { setError('文件系统已重新生成源码，请切换回源代码核对草稿后保存。'); return }
    const srw = tab.srw
    const sent = srw && new Map(srw.edits.patches)
    const large = !srw && Boolean(tab.document?.large)
    const handle = large ? largeHandles.current.get(tab.id) : null
    // 虚拟化视图只在可见时存在；看不见就取不到全文，别静默存一份空文件。
    if (large && !handle) { setError('这块编辑器还没准备好，切回来再保存。'); return }
    const source = srw ? designText(srw, sent) : large ? handle.text() : tab.draft
    const docAtSave = large ? handle.doc() : null
    const version = large || srw ? (tab.version ?? tab.document.version) : tab.document.version
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-source/save', {
        sessionId: session.id, root: tab.root || rootPath, path: tab.path, version, source, ...(srw ? { spans: designChanges(srw.edits) } : {}),
      }))
      if (srw) {
        if (tabsRef.current.some(t => t.srw === srw)) {
          acknowledgeEdits(srw.edits, sent)
          let nextSession = srw
          if (typeof value.source === 'string' && value.source !== source) {
            // ORCA can re-export canonical code. Use it as the new basis; never discard
            // keystrokes made while the provider was compiling.
            if (!editsDirty(srw.edits)) {
              nextSession = { ...srw, model: null, edits: createEdits(), text: value.source }
              setDeck(deck => { const parent = deck.parents[tab.designKey]; return parent ? { ...deck,
                parents: { ...deck.parents, [parent.id]: { ...parent, srw: nextSession } } } : deck })
            } else { srw.needsReview = true; setError('保存成功，文件系统已重新生成源码。随后输入仍在草稿中，请切换回源代码核对。') }
          }
          setTabs(list => list.map(t => t.srw === srw ? { ...t, srw: nextSession, version: value.version,
            document: t.document.large ? t.document : { ...t.document, ...value }, draft: '', edited: false } : t))
        }
      } else if (large) {
        // 文档对象不换（换了两件事：视图会重建、光标和滚动位置全丢），只记新版本号。
        // 等待期间用户还改过的话，Text 对象已经不是保存时那个，脏标记要留着。
        setTabs(list => list.map(item => item.id === tab.id && item.path === tab.path
          ? { ...item, version: value.version, edited: largeHandles.current.get(tab.id)?.doc() !== docAtSave } : item))
        setLargeText(tab.document, value.source)
      } else {
        // 保存的是发起请求时的草稿；等待期间的新输入仍未落盘，只更新它的磁盘版本。
        setTabs(list => list.map(item => item.id === tab.id && item.path === tab.path
          ? { ...item, document: value, draft: item.draft === tab.draft ? value.source : item.draft } : item))
      }
      // 保存成功说明磁盘版本和草稿对上了：外部修改的提醒可以撤掉，轮询也别把自己的写盘当成外部改动。
      versionsRef.current.set(tab.path, value.version)
      setTabs(list => list.some(item => item.id === tab.id && item.stale)
        ? list.map(item => item.id === tab.id ? { ...item, stale: false } : item) : list)
      const current = tabsRef.current.find(item => item.id === tab.id && item.path === tab.path)
      const clean = srw ? !editsDirty(srw.edits) : large ? current?.edited === false : current?.draft === tab.draft
      if (clean && activeIdRef.current === target.id) flashNotice('已保存')
      const library = dirName(tab.path)
      if (treeRef.current.has(library) && (libraryPath(library) || pbLibraries.has(baseName(library).toLowerCase()))) void loadDir(library)
      void refreshGitRef.current({ silent: true })
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
      currentInput()?.focus({ preventScroll: true })
    }
  }
  const toggleSidebarRef = React.useRef(toggleSidebar)
  toggleSidebarRef.current = toggleSidebar

  const saveRef = React.useRef(saveFile)
  saveRef.current = saveFile
  const closeFind = () => { setFindTarget(''); currentInput()?.focus({ preventScroll: true }) }
  const revealFindMatch = (start, index, focus = false) => {
    const input = currentInput()
    if (!input || start === undefined) { setFindIndex(-1); return }
    if (focus) input.focus({ preventScroll: true })
    const end = start + findQuery.length
    if (codeView(active)) { input.select(start, end); setFindIndex(index); return }
    input.setSelectionRange(start, end)
    const line = newlinesIn(input.value.slice(0, start))
    const lineTops = input.worldLineTops?.length ? input.worldLineTops : tops
    const top = wrap && lineTops ? lineTops[line] : line * lineHeight
    if (top < input.scrollTop || top + lineHeight > input.scrollTop + input.clientHeight) input.scrollTop = Math.max(0, top - input.clientHeight / 2)
    syncCaret(input); setFindIndex(index)
  }
  const stepFind = (direction = 1, focus = false, source) => {
    const input = currentInput()
    if (!input) return
    const matches = source === undefined ? findMatches : findTextOffsets(source, findQuery, findCase)
    if (!matches.length) { setFindIndex(-1); return }
    const boundary = direction > 0 ? input.selectionEnd : input.selectionStart - findQuery.length
    let index = direction > 0 ? matches.findIndex(start => start >= boundary)
      : matches.findLastIndex(start => start <= boundary)
    if (index < 0) index = direction > 0 ? 0 : matches.length - 1
    revealFindMatch(matches[index], index, focus)
  }
  /** 虚拟化视图：把 CodeMirror 里的最新文本刷回快照，全文查找/数行都从这份开始。 */
  const syncLargeSnapshot = tab => {
    if (!largeSource(tab)) return null
    const handle = largeHandles.current.get(tab.id)
    if (!handle) return null
    const text = handle.text()
    setLargeText(tab.document, text)
    return { handle, text }
  }
  const openFind = replace => {
    if (scriptFind) {
      const strip = shellRef.current?.querySelector(`[data-world-active="${CSS.escape(activeId)}"]`)
      return !replace && findInScript(strip?.parentElement)
    }
    if (!findAvailable) return false
    const tab = tabsRef.current.find(item => item.id === activeIdRef.current)
    const input = currentInput()
    const synced = largeSource(tab) ? syncLargeSnapshot(tab) : null
    if (synced) setFindNonce(n => n + 1)
    const text = synced ? synced.text : input?.value
    const selected = text?.slice(input?.selectionStart || 0, input?.selectionEnd || 0)
    if (selected && !selected.includes('\n')) setFindQuery(selected)
    setFindTarget(activeIdRef.current); setFindReplace(replace)
    window.setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select() }, 0)
    return true
  }
  const openFindRef = React.useRef(openFind)
  openFindRef.current = openFind
  React.useEffect(() => {
    if (findTarget !== activeId || !findQuery || !findAvailable) return
    const input = currentInput()
    const matches = findMatches
    const from = input?.selectionStart || 0
    let index = matches.findIndex(start => start >= from)
    if (index < 0) index = 0
    revealFindMatch(matches[index], index)
  }, [findQuery, findCase, findTarget, activeId])
  const replaceFound = all => {
    const input = currentInput()
    if (!input || !findQuery || isLocked(active)) return
    const large = largeHandles.current.get(active.id)
    if (large) {
      const matches = findTextOffsets(large.text(), findQuery, findCase)
      if (!matches.length) return
      if (all) {
        // 一次事务改完：两千处命中逐个 dispatch 会把主线程按住好几百毫秒
        large.replace(matches.map(from => ({ from, to: from + findQuery.length, insert: findReplacement })))
        flashNotice(`已替换 ${matches.length} 处`)
        setFindIndex(-1)
      } else {
        const caret = large.selectionStart
        const from = matches.find(start => start >= caret) ?? matches[0]
        large.replace({ from, to: from + findQuery.length, insert: findReplacement }, from + findReplacement.length)
      }
      // 改完把新文本刷回快照：计数、下一次查找、行数都基于它
      syncLargeSnapshot(active)
      setFindNonce(n => n + 1)
      findReplaceInputRef.current?.focus({ preventScroll: true })
      return
    }
    if (all) {
      const result = replaceAllText(input.value, findQuery, findReplacement, findCase)
      if (!result.count) return
      input.select(); insertText(input, result.source); setFindIndex(-1)
      flashNotice(`已替换 ${result.count} 处`)
    } else {
      const matches = findTextOffsets(input.value, findQuery, findCase)
      const caret = input.selectionStart
      const from = matches.find(start => start >= caret) ?? matches[0]
      if (from === undefined) return
      input.setSelectionRange(from, from + findQuery.length)
      insertText(input, findReplacement); stepFind(1, false, input.value)
    }
    findReplaceInputRef.current?.focus({ preventScroll: true })
  }

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
  const pbJob = usePbJob({ rpc, project: pbProject, sessionId: session?.id, dirty, show: () => showView('run') })
  const runPbRef = React.useRef(null)
  runPbRef.current = pbProject ? () => pbJob.start('run') : null

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
    const folder = !picker?.forGit && /\.zip$/i.test(path) ? resolveProject(rpc, path, session.id) : path
    return Promise.resolve(folder).then(dir => rpc.call('/api', 'world-vscode-source/list', {
      sessionId: session.id, path: dir, root: rootPath,
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

  const openTabMenu = (event, id, extra) => {
    event.preventDefault()
    event.stopPropagation()
    const width = 220, height = 200
    setFileMenu(null)
    const menu = {
      id, ...extra,
      x: Math.min(Math.max(8, event.clientX), Math.max(8, (window.innerWidth || 0) - width)),
      y: Math.min(Math.max(8, event.clientY), Math.max(8, (window.innerHeight || 0) - height)),
    }
    setTabMenu(menu)
    return menu
  }

  const openDesignMenu = (event, parent) => {
    if (event.defaultPrevented) return
    const script = pbProject && !collectionMode && withinFolder(normalizePath(parent.srw.path), rootPath) && scriptContext(event)
    if (script) {
      const found = objectIndex.find(script.word.toLowerCase())
      const loading = found instanceof Promise
      if (loading || found.matches.length || found.objectNote) {
        const menu = openTabMenu(event, parent.id, { script, objectIndex,
          ...(loading ? { objectNote: '正在查找工程对象…' } : found) })
        // A slow first lookup must never reopen a dismissed menu or replace a newer word.
        if (loading) found.then(result => setTabMenu(current => current === menu ? { ...menu, ...result } : current))
          .catch(error => {
            if (error.name !== 'AbortError') setTabMenu(current => current === menu ? { ...menu, objectNote: error.message } : current)
          })
        return
      }
    }
    if (!event.target.closest('textarea,input,select,pre,[contenteditable=true]')) openTabMenu(event, parent.id)
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

  const runBatch = path => {
    const file = normalizePath(path)
    if (!isBatchPath(file)) { setError('只能运行 .bat 或 .cmd 文件。'); return }
    return startOutputJob(file, 'run', { cwd: dirName(file) || rootPath, line: `call "${nativePath(file)}"` })
  }
  const testHint = activeDirty ? '请先保存文档再运行。' : active?.stale ? '文件已变更，请重新打开后运行。' : testsPending ? '正在更新测试列表…' : ''
  const runTest = (target = {}, owner = active) => {
    const plan = fileTests(owner)
    if (!owner || isDirty(owner) || owner.stale || plan.pending || !plan.rows.size || target.ambiguous || batchStartingRef.current || batchRun?.running) return
    if (phone) setDrawerOpen(false)
    const { blockIndex, caseName } = target
    if (owner.id !== activeId) setActiveId(owner.id)
    return startOutputJob(owner.path, 'pbtest', { root: owner.root || rootPath, path: owner.path,
      version: owner.document.large ? owner.version : owner.document.version, blockIndex, caseName }, target.label || '运行文件内全部测试')
  }
  const testButton = target => h('button', { type: 'button', key: target?.line || target?.label,
    title: testHint || (target?.ambiguous ? '名称前缀重复，请运行整个代码块。' : target?.label),
    'aria-label': target?.label || '运行文件内全部测试', disabled: Boolean(testHint || target?.ambiguous || batchStarting || batchRun?.running),
    onClick: () => void runTest(target) }, target?.label || '运行文件内全部测试')
  const nativeLang = !splitMode && active?.document && !active.kind && !active.openAsDesign && !codeView(active) ? language : null
  // Hand the previous result back in so only the edited line is re-tokenized.
  const folds = React.useMemo(() => {
    const next = nativeFoldRows(active?.draft, nativeLang, foldCache.current)
    foldCache.current = next
    return next
  }, [active?.draft, nativeLang])
  const foldSource = React.useCallback((id, range) => {
    const handle = largeHandles.current.get(id)
    if (handle) handle.fold(range)
    else setTabs(list => list.map(t => t.id === id ? { ...t, foldEditor: range } : t))
    setActiveId(id)
  }, [])
  const gutterLabel = line => gutterCells(line, folds, range => foldSource(active.id, range), activeTestGutter, runTest,
    Boolean(testHint || batchStarting || batchRun?.running), testHint, phone)

  const startOutputJob = async (file, operation, payload, label) => {
    if (!session?.id) { setError('先打开一个会话再运行。'); return }
    // 锁住整个启动事务，包括取消旧任务的等待；React state 只负责显示。
    if (batchStartingRef.current) return
    batchStartingRef.current = true
    setBatchStarting(true)
    try {
      if (batchRun?.running) await cancelBatch()
      stopBatchPolling()
      const value = unwrap(await rpc.call('/api', `world-terminal/${operation}`, { sessionId: session.id, ...payload }))
      batchJobRef.current = value.jobId
      setBatchCollapsed(false)
      setBatchRun({ path: file, label, text: '', offset: 0, jobId: value.jobId,
        running: true, exitCode: null, cancelled: false, durationMs: 0, error: '' })
      window.setTimeout(() => void pollBatchJob(value.jobId, 0), 120)
    } catch (cause) {
      batchJobRef.current = ''
      setBatchCollapsed(false)
      setBatchRun({ path: file, label, text: '', offset: 0, jobId: '',
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

  React.useLayoutEffect(() => {
    const menu = tabMenuRef.current
    if (!menu || !tabMenu) return
    menu.style.maxHeight = 'calc(100dvh - 16px)'; menu.style.overflowY = 'auto'
    const { height } = menu.getBoundingClientRect()
    menu.style.top = `${Math.max(8, Math.min(tabMenu.y, window.innerHeight - height - 8))}px`
  }, [tabMenu])
  React.useEffect(() => {
    if (!tabMenu) return undefined
    const close = event => { if (!tabMenuRef.current?.contains(event.target)) setTabMenu(null) }
    const key = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setTabMenu(null)
    }
    const blur = () => setTabMenu(null)
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', blur)
    }
  }, [tabMenu])

  React.useEffect(() => {
    if (!minimized) return
    setFileMenu(null)
    setTabMenu(null)
    setPhoneMenuOpen(false)
  }, [minimized])

  const relativeToFolder = (path, root) => sameFolder(path, root) ? '.' : withinFolder(path, root)
    ? path.slice(root.length).replace(/^\//, '') : path
  const relativeToRoot = path => relativeToFolder(path, rootPath)

  const revealInExplorer = async path => {
    setFileMenu(null)
    if (!session?.id) { setError('先打开一个会话再显示文件。'); return }
    setError('')
    try {
      await unwrap(await rpc.call('/api', 'world-vscode-source/reveal', {
        sessionId: session.id, root: explorerRootFor(path), path,
      }))
      flashNotice('已在资源管理器中显示')
    } catch (cause) {
      setError(String(cause?.message || cause))
    }
  }

  const copyFilePath = async (path, relative) => {
    setFileMenu(null)
    const copied = await writeClipboard(relative && !collectionMode ? relativeToFolder(path, explorerRootFor(path)) : nativePath(path))
    if (copied) flashNotice(relative && !collectionMode ? '已复制相对路径' : '已复制绝对路径')
    else setError('复制失败：当前环境不允许访问剪贴板。')
  }

  const openPicker = (purpose = 'workspace') => {
    const forGit = purpose === 'git'
    setQuickOpen(false)
    setPhoneMenuOpen(false)
    // 别的窗口可能刚开过文件夹：每次打开对话框都重新读一次共享列表；
    // 存储被禁时 readFolders() 返回 null，别把内存里的记录擦掉
    const stored = readFolders()
    if (stored?.length) setRecentFolders(stored)
    const start = (forGit && gitRoot) || rootPath || normalizePath(session?.cwd || '')
    setPicker({ forGit, adding: purpose === 'add', path: start, parent: '', folders: [], busy: true, error: '', truncated: false })
    setPickerDraft(start)
    void browseTo(start)
    // 列表可能刚在别处装好/授权，打开对话框时顺手重扫一次
    if (!forGit) void scanRootsRef.current?.()
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
    changeSearchText('')
    setReplaceText('')
    setReplaceOpen(false)
    setReplacing(false)
    setGit(null)
    setGitMsg(null)
    commitDraft.set('')
    setNotice('')
    onRootChange?.(next)
  }
  const switchRootRef = React.useRef(switchRoot)
  switchRootRef.current = switchRoot
  const openQuick = () => {
    if (collectionMode) return
    if (!rootPath) { openPicker(); return }
    closePicker(); setPhoneMenuOpen(false); setQuickOpen(true)
  }
  const openQuickRef = React.useRef(openQuick)
  openQuickRef.current = openQuick
  React.useEffect(() => { setQuickOpen(false) }, [rootPath, session?.id, minimized])
  React.useEffect(() => {
    if (!isActive || minimized || collectionMode) return undefined
    return reserveQuickOpen(getShortcuts?.())
  }, [isActive, minimized, collectionMode, getShortcuts])
  React.useEffect(() => {
    if (!isActive || minimized || !(findAvailable || scriptFind)) return undefined
    return reserveTextFind(getShortcuts?.(), scriptFind)
  }, [isActive, minimized, findAvailable, scriptFind, getShortcuts])

  const setGitFolder = path => {
    bindingCache.current.set(bindingKey, path)
    try { if (path) localStorage.setItem(bindingKey, path); else localStorage.removeItem(bindingKey) } catch {}
    setGit(null); setGitMsg(null); commitDraft.set(''); setFileMenu(null); bumpBinding()
  }
  const applyFolder = async destination => {
    const next = normalizePath((picker?.forGit ? pickerDraft : picker?.path) || '')
    if (!next) return
    if (picker?.forGit) {
      const controller = new AbortController(), scope = gitScope
      pickerAbort.current?.abort(); pickerAbort.current = controller
      setPicker(current => current && { ...current, busy: true, error: '' })
      try {
        const status = unwrap(await rpc.call('/api', 'world-vscode-git/status', { sessionId: session.id, root: next }, controller.signal))
        if (!mounted.current || controller.signal.aborted || gitScopeRef.current !== scope) return
        if (!status?.repo || !status.root) throw new Error('所选文件夹不在 Git 仓库中。')
        closePicker(); setGitFolder(normalizePath(status.root))
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted && gitScopeRef.current === scope) setPicker(current => current && { ...current, busy: false, error: String(cause?.message || cause) })
      }
      return
    }
    closePicker()
    if (picker.adding) onRootChange?.(next, true)
    else switchRoot(next, destination)
  }

  /** 插件提供的可打开位置：IMA 是一个整体，PB 是逐个工程。 */
  const scanSequence = React.useRef(0)
  const scanPluginRoots = React.useCallback(async signal => {
    const seq = ++scanSequence.current
    if (!session?.id) return
    try {
      const value = unwrap(await rpc.call('/api', 'world-vscode-roots/scan', { root: rootPath }, signal))
      if (!mounted.current || signal?.aborted || seq !== scanSequence.current) return
      setPluginRoots(value && typeof value === 'object' ? value : null)
      // Resolve only the active target, not every project in the picker.
      const project = value?.currentProject
      if (project) {
        try {
          const app = unwrap(await rpc.call('/api', `${project.plugin}-project/application`, { root: project.root }, signal))
          if (app && mounted.current && !signal?.aborted && seq === scanSequence.current)
            setPluginRoots({ ...value, currentProject: { ...project, application: app } })
        } catch { /* Older providers still have a usable library tree. */ }
      }
    } catch {
      // 旧宿主没有这个服务，或者 IMA 没授权：这一栏不出现就好，不在侧栏里报警
      if (mounted.current && !signal?.aborted && seq === scanSequence.current) setPluginRoots(null)
    }
  }, [rpc, session?.id, rootPath])
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
    if (projectRequest.current) return
    projectRequest.current = true
    setOpeningProject(path)
    setError('')
    setNotice('')
    try {
      const root = await resolveProject(rpc, path, session?.id)
      if (!mounted.current) return
      if (!/\.zip$/i.test(path)) void scanRootsRef.current?.()
      await switchRootRef.current?.(root)
    } catch (cause) { if (mounted.current) setError(cause.message) }
    finally { projectRequest.current = false; if (mounted.current) setOpeningProject('') }
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
    const owner = event.target?.closest?.('.world-vscode-window[data-world-vscode-key]')
      || window.document.activeElement?.closest?.('.world-vscode-window[data-world-vscode-key]')
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
    const target = currentInput() || shell
    target.focus({ preventScroll: true })
  }

  /** 最小化时把「打开文件夹」收起来：否则它跟着窗口一起消失，键盘却还被它的模态接管着。 */
  React.useEffect(() => {
    if (minimized) { closePicker(); setErrorDetails(null) }
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
    ;(currentInput() || shell).focus({ preventScroll: true })
  }, [minimized])

  /** 对话框是模态的：Tab 在卡片里循环、Escape 关闭，其余快捷键一律让路。 */
  React.useEffect(() => {
    if (!picker) return undefined
    const onKeyDown = event => {
      if (event.target?.closest?.('[data-world-error-details]')) return
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
      if (event.key === 'F5' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (!runPbRef.current || !activeRef.current || pickerOpenRef.current || !ownsKey(event) || document.querySelector('[aria-modal="true"]')) return
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat) void runPbRef.current()
        return
      }
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
      if ((key === 'f' || key === 'h') && openFindRef.current(key === 'h')) { consume(); return }
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
    .resolve(rpc.call('/api', `world-vscode-git/${operation}`, { sessionId: session.id, root: gitRoot, ...payload }, signal))
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
    if (!session?.id || !rootPath || collectionMode || (gitOpRef.current && gitTaskRef.current?.scope === gitScope)) return
    const task = { scope: gitScope }
    gitTaskRef.current = task
    gitOpRef.current = 'status'
    setGitOp('status')
    try {
      const value = await callGit('status')
      if (!mounted.current || gitScopeRef.current !== gitScope) return
      setGit(value)
      await refreshOpenGitDiffs(value)
      if (value?.repo) void refreshGitHistory()
      else setGitHistory(null)
    } catch (cause) {
      if (mounted.current && gitScopeRef.current === gitScope) {
        setGit(current => current || { repo: false, statusError: String(cause?.message || cause) })
        if (!silent) setGitMsg({ kind: 'error', text: String(cause?.message || cause) })
      }
    } finally {
      if (gitTaskRef.current === task) { gitOpRef.current = ''; if (mounted.current) setGitOp('') }
    }
  }
  const refreshGitRef = React.useRef(refreshGit)
  refreshGitRef.current = refreshGit

  React.useEffect(() => {
    setGit(null)
    setGitPick(null)
    setGitHistory(null)
    setHistoryOpen(true)
    setHistoryDetails(new Set())
    historyFilesRef.current.clear(); setHistoryFiles(new Map())
    historyRequest.current++
    if (!session?.id || !rootPath || collectionMode) return
    void refreshGitRef.current({ silent: true })
  }, [gitScope])

  // 换仓库后目录树都是新的，别把上一个仓库的折叠状态带过来。
  React.useEffect(() => { setGitClosed(new Set()) }, [git?.root])

  const runGit = async (operation, payload, done) => {
    if (gitOpRef.current) return
    const task = { scope: gitScope }
    gitTaskRef.current = task
    gitOpRef.current = operation
    setGitOp(operation)
    setGitMsg({ kind: 'ok', text: operation === 'discard' ? '正在放弃更改…'
      : operation === 'commit' ? '正在提交…' : operation.includes('unstage') ? '正在取消暂存…'
        : operation.includes('stage') ? '正在暂存…' : '正在执行 Git 操作…' })
    try {
      let value
      const output = []
      for (const step of operation === 'sync' ? ['pull', 'push'] : [operation]) {
        if (operation === 'sync') setGitMsg({ kind: 'ok', text: step === 'pull' ? '正在拉取…' : '拉取完成，正在推送…' })
        value = await callGit(step, payload)
        if (!mounted.current || gitScopeRef.current !== gitScope) return
        if (value?.status) setGit(value.status)
        if (value?.output) output.push(value.output)
      }
      if (value?.status?.repo) void refreshGitHistory()
      if (!boundGit && (operation === 'pull' || operation === 'sync' || operation === 'discard')) void refreshTree()
      await refreshOpenGitDiffs(value?.status)
      if (!mounted.current || gitScopeRef.current !== gitScope) return
      if (operation === 'commit' && commitDraft.getSnapshot() === payload.message) commitDraft.set('')
      setGitMsg({ kind: 'ok', text: output.join('\n') || done })
      return value
    } catch (cause) {
      if (!mounted.current || gitScopeRef.current !== gitScope) return
      setGitMsg({ kind: 'error', text: String(cause?.message || cause) })
      // 失败后状态可能已经变了（比如 pull 留下冲突），重新读一次真实状态。
      window.setTimeout(() => { void refreshGitRef.current({ silent: true }) }, 0)
    } finally {
      if (gitTaskRef.current === task) { gitOpRef.current = ''; if (mounted.current) setGitOp('') }
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
      if (!treeRef.current.get(prefix)?.entries || treeRef.current.get(prefix)?.error) await loadDir(prefix)
      if (!mounted.current) return
      setExpanded(current => current.has(prefix) ? current : new Set(current).add(prefix))
    }
    if (libraryPath(prefix) || (segments.length === 2 && pbLibraries.has(segments[0].toLowerCase()))) {
      const id = groupKey(prefix, groupOf(segments.at(-1)))
      setExpanded(current => new Set(current).add(id))
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
    const target = joinPath(gitRoot, file.open)
    openFile(target, true, undefined, gitRoot)
    if (!boundGit) void revealDir(target)
  }

  /**
   * Git 更改行：单击打开只读 Diff 标签；同一文件 + 同一分组只留一个，
   * 再点一次就刷新——暂存 / 提交之后 patch 可能已经变了。
   */
  const loadGitDiff = (id, details) => {
    const scope = gitScope
    setTabs(list => list.map(tab => tab.id === id ? { ...tab, ...details, loading: true, error: '' } : tab))
    const seq = (diffSeq.current.get(id) || 0) + 1
    diffSeq.current.set(id, seq)
    return Promise.resolve(callGit(details.commit ? 'commit-diff' : 'diff', {
      paths: gitFilePaths(details, details.staged || details.commit),
      staged: details.staged, untracked: details.untracked, ...(details.commit ? { commit: details.commit } : {}),
    })).then(value => {
      if (!mounted.current || gitScopeRef.current !== scope || diffSeq.current.get(id) !== seq) return
      setTabs(list => list.map(tab => tab.id === id
        ? { ...tab, patch: value?.patch || '', snapshot: value?.snapshot, canStageHunks: Boolean(value?.canStageHunks),
          truncated: Boolean(value?.truncated), loading: false, error: '' } : tab))
    }).catch(cause => {
      if (!mounted.current || gitScopeRef.current !== scope || diffSeq.current.get(id) !== seq) return
      setTabs(list => list.map(tab => tab.id === id ? { ...tab, loading: false, error: String(cause?.message || cause) } : tab))
    })
  }
  const refreshOpenGitDiffs = status => Promise.all(tabsRef.current.filter(tab => tab.kind === 'diff' && !tab.commit && tab.root === gitRoot)
    .map(tab => {
      const file = status?.files?.find(file => file.path === tab.path)
      return loadGitDiff(tab.id, { ...tab, untracked: !tab.staged && Boolean(file?.untracked), from: tab.staged ? file?.from || '' : '', open: file?.open || tab.open })
    }))
  const openGitDiff = (file, staged, commit) => {
    if (phone) setDrawerOpen(false)
    const id = `diff:${commit ? `commit:${commit}` : staged ? 'index' : 'work'}:${gitRoot}:${file.path}`
    const untracked = !staged && Boolean(file.untracked)
    const details = { path: file.path, from: staged || commit ? file.from || '' : '', open: file.open || '', root: gitRoot, staged, untracked, commit }
    setTabs(current => current.some(tab => tab.id === id)
      ? current.map(tab => tab.id === id ? { ...tab, loading: true, error: '' } : tab)
      : [...current, {
        id, kind: 'diff', ...details, pinned: true, patch: '', truncated: false, loading: true, error: '',
      }])
    setActiveId(id)
    void loadGitDiff(id, details)
  }

  const dirtyGitFile = file => Boolean(file?.open && tabsRef.current.some(tab => tab.path === joinPath(gitRoot, file.open) && isDirty(tab)))
  const discardGitFiles = async files => {
    if (gitOpRef.current || discardPrompt.current || !files.length) return
    const scope = gitScope
    const blocked = () => files.some(dirtyGitFile)
    if (blocked()) { setGitMsg({ kind: 'error', text: '文件有未保存草稿，请先保存或关闭草稿后再放弃更改。' }); return }
    discardPrompt.current = true
    const paths = files.map(file => file.path)
    let confirmed, plan
    try {
      setGitMsg({ kind: 'ok', text: '正在核对要放弃的更改…' })
      plan = await callGit('prepare-discard', { paths })
      if (!mounted.current || gitScopeRef.current !== scope) return
      if (blocked()) { setGitMsg({ kind: 'error', text: '文件有未保存草稿，已取消放弃更改。' }); return }
      setGitMsg(null)
      confirmed = await worldConfirm({ title: '放弃更改', danger: true, confirmLabel: '放弃更改',
        message: `放弃 ${files.length === 1 ? `「${files[0].path}」` : `${files.length} 个文件`} 的工作区更改？`,
        detail: `未暂存的修改将丢失，已暂存的内容保留。${plan.files.some(file => file.removed) ? '选中的未跟踪文件会被删除。' : ''}此操作不能通过编辑器撤销。` })
    } catch (error) {
      if (mounted.current && gitScopeRef.current === scope) setGitMsg({ kind: 'error', text: String(error.message || error) })
      return
    } finally { discardPrompt.current = false }
    if (!confirmed || !mounted.current || gitScopeRef.current !== scope) return
    if (blocked()) { setGitMsg({ kind: 'error', text: '确认期间产生了未保存草稿，已取消放弃更改。' }); return }
    const result = await runGit('discard', { paths, confirmed: true, snapshot: plan.snapshot }, '已放弃未暂存的更改')
    if (!result || gitScopeRef.current !== scope) return
    for (const file of files) {
      if (!file.open) continue
      for (const tab of tabsRef.current.filter(tab => tab.path === joinPath(gitRoot, file.open) && tab.kind !== 'diff')) {
        if (isDirty(tab)) { setGitMsg({ kind: 'error', text: '操作期间产生了未保存修改，已保留编辑器草稿。' }); continue }
        if (result.discarded?.some(item => item.path === file.path && item.removed)) dropTab(tab.id)
        else await loadFile(tab.id, tab.path, true, undefined, tab.root || gitRoot)
      }
    }
  }

  const loadHistoryFiles = async (commit, retry = false) => {
    const scope = gitScope, previous = historyFilesRef.current.get(commit)
    if (!retry && previous?.scope === scope && !previous.error) return
    const task = { scope, loading: true, error: '', value: null }
    historyFilesRef.current.set(commit, task); setHistoryFiles(new Map(historyFilesRef.current))
    const controller = new AbortController(); controllers.current.add(controller)
    try {
      const value = await callGit('commit-files', { commit }, controller.signal)
      if (!mounted.current || gitScopeRef.current !== scope || historyFilesRef.current.get(commit) !== task) return
      historyFilesRef.current.set(commit, { scope, loading: false, value, error: '' })
      setHistoryFiles(new Map(historyFilesRef.current))
    } catch (error) {
      if (!mounted.current || gitScopeRef.current !== scope || historyFilesRef.current.get(commit) !== task) return
      historyFilesRef.current.set(commit, { scope, loading: false, value: null, error: String(error.message || error) })
      setHistoryFiles(new Map(historyFilesRef.current))
    } finally { controllers.current.delete(controller) }
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
  const changeSearchText = text => {
    // Invalidate before the debounce starts, even if the transport delivers a late reply.
    searchSeq.current++
    searchAbort.current?.abort()
    setSearchText(text)
    setSearchResult(null)
    setSearchError('')
    setSearchNotice('')
    setSearchBusy(false)
  }
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
  const searchRef = React.useRef(null)
  searchRef.current = () => performSearch(searchText, searchFlags)

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
      searchRef.current() // The query may have changed while replacement was running.
      const resultNotice = value?.replacements
        ? `已替换 ${value.replacements} 处 · ${value.fileCount} 个文件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`
        : (skipped[0] ? `没有替换：${skipped[0].reason}` : '没有可替换的内容。')
      setSearchNotice({ summary: [resultNotice, ...reloadWarnings].join('\n'),
        details: [...skipped.map(file => `${file.path}：${file.reason}`), ...reloadWarnings].join('\n') })
    } catch (cause) {
      setSearchError(String(cause?.message || cause))
    } finally {
      if (mounted.current) setReplacing(false)
    }
  }

  React.useEffect(() => {
    if (sideViewRef.current !== 'search' || !session?.id) return undefined
    const timer = window.setTimeout(() => searchRef.current(), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [searchText, searchFlags, session?.id])

  React.useEffect(() => () => { searchAbort.current?.abort() }, [])

  // 手机的抽屉只是临时状态：写回存储会把「手机上收起了侧栏」带到桌面去。
  React.useEffect(() => { if (!phone) saveSidebar({ open: desktopSidebarOpen }) }, [desktopSidebarOpen, phone])
  React.useEffect(() => { saveSidebar({ view: sideView }) }, [sideView])

  /** 点击搜索结果：确保文件已打开，然后把光标落到那一行。 */
  const revealHit = (filePath, match) => {
    const target = absolutePath(filePath)
    void openFile(target, true, undefined, undefined, 'source')
    setReveal({ path: target, line: match.line, column: match.column, nonce: ++revealSeq.current })
  }

  // Retained buttons must still use the current folder, tabs and opener when activated.
  const revealHitRef = React.useRef(revealHit)
  React.useLayoutEffect(() => { revealHitRef.current = revealHit })

  React.useEffect(() => {
    if (!reveal || !active?.document || active.path !== reveal.path) return
    if (revealedSeq.current === reveal.nonce) return
    const viewer = largeHandles.current.get(active.id)
    if (viewer) { revealedSeq.current = reveal.nonce; viewer.reveal(reveal.line, reveal.column); return }
    const node = textareaRef.current
    if (!node) return
    revealedSeq.current = reveal.nonce
    const value = node.value
    let lineStart = 0
    let actualLine = 1
    for (let line = 1; line < reveal.line; line++) {
      const next = value.indexOf('\n', lineStart)
      if (next < 0) break
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
    const lines = countLines(value, active?.document)
    const known = wrap && measured && actualLine <= lines && measured.length === lines + 1
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
    taskbarSource(focused) {
      if (minimized || pickerOpenRef.current) return null
      const shell = shellRef.current
      const code = focused?.closest?.('.cm-content, textarea.world-vscode-textarea')
      const node = code && shell.contains(code) ? code : active?.kind === 'srw-view' ? null
        : codeView(active) ? shell.querySelector('.world-vscode-pane.is-active .world-vscode-large .cm-content') : textareaRef.current
      return taskbarSource(node, designOwner?.path || active?.path, activeDirty, node?.worldLineTops?.length ? node.worldLineTops : tops)
    },
    focus() {
      const shell = shellRef.current
      if (!shell || minimizedRef.current) return false
      const current = window.document.activeElement
      if (pickerOpenRef.current) {
        const card = shell.querySelector('[data-world-error-details]') || pickerCardRef.current
        if (!card) return false
        if (!card.contains(current)) card.querySelector('input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true })
        if (!card.contains(window.document.activeElement)) return false
      } else if (!shell.contains(current)) {
        const target = currentInput() || shell
        target.focus({ preventScroll: true })
      }
      // Programmatic activation has no pointer event to update shortcut ownership.
      pointerOwnerRef.current = windowKey
      return shell.contains(window.document.activeElement)
    },
    getState: () => ({
      sessionId: session?.id || '', rootPath, activePath: designOwner?.path || (['diff', 'chat', 'app', 'srw-view'].includes(active?.kind) ? '' : active?.path || ''),
      dirty,
      loading: Boolean(busyFile), saving,
      caret: active?.document ? { line: caretLine + 1, column: caretColumn + 1 } : null,
      files: tabs.filter(tab => !['diff', 'chat', 'app', 'srw-view'].includes(tab.kind)).map(tab => ({ path: tab.path, dirty: isDirty(tab), pinned: tab.pinned,
        active: tab.id === activeId, loading: tab.kind !== 'document' && !tab.document })),
    }),
    async openFile(command, signal) {
      signal?.throwIfAborted()
      if (pickerOpenRef.current) throw desktopError(errorDetails ? '请先关闭错误详情。' : quickOpen ? '编辑器正在搜索文件，请先完成或关闭对话框。' : '编辑器正在选择文件夹，请先完成或关闭对话框。', 'WORLD_DESKTOP_BUSY')
      const path = normalizePath(command.path)
      const existing = tabsRef.current.find(tab => tab.path === path && tab.kind !== 'diff')
      if (command.refresh && isDirty(existing)) throw desktopError('文件有未保存修改，不能重新读取并覆盖草稿。', 'WORLD_DESKTOP_DIRTY')
      const opened = await openFile(path, true, signal, undefined, 'source')
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
    taskbarSource: focused => desktopHandle.current.taskbarSource(focused),
    focus: () => desktopHandle.current.focus(),
    getState: () => desktopHandle.current.getState(),
    openFile: (command, signal) => desktopHandle.current.openFile(command, signal),
  }), [windowKey, onDesktopRegister])

  const treeRoots = workspaceRoots.length ? workspaceRoots : [treeRoot]
  const toggleGroup = id => setExpanded(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next })
  const explorerActions = React.useRef(null)
  React.useLayoutEffect(() => { explorerActions.current = { toggleDir, warmDir, openFile, openProject, openFileMenu, toggleGroup } })
  const busyDir = [...expanded].some(dir => tree.get(dir)?.loading)
  // 分组与分屏判定：下面决定「主编辑区这一帧画不画」要先知道它，所以提前到这里。
  const lineCount = React.useMemo(() => countLines(tabText(active), active?.document), [active?.draft, active?.document])
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

  // 每个编辑器复用未改变的完整行；跨行注释/字符串从安全边界重新扫描。
  const highlight = React.useMemo(() => createHighlighter(), [active?.document, splitMode])
  const highlighted = React.useMemo(() => {
    // 分屏时主编辑区是空的（每个文件都在自己的 SplitSource 里画高亮），
    // 这里再扫一遍全文纯属白算——两千行的工程文件一次就是 1ms。
    if (active?.openAsDesign || splitMode || !active?.document || !language || codeView(active)) return null
    const result = highlight(active.draft || '', language)
    return result.plain ? null : result
  }, [splitMode, active?.document, active?.draft, active?.openAsDesign, language, highlight])
  const words = useNativeWord(active?.path, language)
  const starts = !splitMode && !active?.kind && !active?.openAsDesign && active?.document && !codeView(active)
    ? nativeIndex(active.draft, active.document) : null
  React.useLayoutEffect(() => {
    if (starts && textareaRef.current) { textareaRef.current.worldLineStarts = starts; textareaRef.current.worldIndexedText = active.draft }
  }, [starts, active?.draft, active?.id, active?.reload])
  const highlightRows = React.useMemo(() => starts ? Array.from({ length: visibleCount }, (_, offset) => {
    const index = firstLine + offset
    return h('div', { key: index, 'data-word-row': index, className: `world-vscode-hl-line${tops ? ' is-wrap' : ''}`,
      style: tops ? { top: `${tops[index] - scrollTop}px` } : undefined,
    }, wordRow(highlighted?.lines[index], rowText(active.draft, starts, index), words.pattern))
  }) : null, [starts, visibleCount, firstLine, tops, tops && scrollTop, highlighted, active?.draft, words.pattern])
  /**
   * 折行时只有量到前缀和才敢把 textarea 的文字变透明：没量到就透明，整篇字会凭空消失。
   * 宽度同理——没有 `wrapWidth` 那层会按容器宽折一遍，颜色整片错开一帧。
   * 输入法组字期间也退回来（候选串只在 textarea 里，透明了打字的人看不见自己在打什么）。
   */
  const highlightReady = Boolean(highlightRows) && (!wrap || Boolean(tops && wrapWidth)) && !composing

  const changedFiles = git?.files || EMPTY_FILES
  // A path can occur in both groups (partially staged). Never carry a choice across groups or repositories.
  const pick = gitPick?.scope === gitScope && gitPick.root === git?.root ? gitPick : null
  React.useEffect(() => {
    setGitPick(current => {
      if (!current || current.scope !== gitScope || current.root !== git?.root) return null
      const eligible = changedFiles.filter(file => !file.conflicted && (current.staged ? file.staged : file.unstaged || file.untracked))
      if (!eligible.length) return null
      const paths = new Set(eligible.filter(file => current.paths.has(file.path)).map(file => file.path))
      return paths.size === current.paths.size ? current : { ...current, paths }
    })
  }, [gitScope, git?.root, changedFiles])
  const beginPick = staged => setGitPick({ scope: gitScope, root: git.root, staged, paths: new Set() })
  const togglePick = (file, staged) => setGitPick(current => {
    if (!current || current.scope !== gitScope || current.root !== git?.root || current.staged !== staged || file.conflicted) return current
    const paths = new Set(current.paths)
    if (paths.has(file.path)) paths.delete(file.path); else paths.add(file.path)
    return { ...current, paths }
  })
  const applyPick = async (files, staged) => {
    if (gitOpRef.current || !files.length) return
    const dirty = !staged && files.find(dirtyGitFile)
    if (dirty) { setGitMsg({ kind: 'error', text: `「${dirty.path}」有未保存草稿。请先保存或取消勾选，未暂存任何文件。` }); return }
    const paths = [...new Set(files.flatMap(file => gitFilePaths(file, staged)))]
    const result = await runGit(staged ? 'unstage' : 'stage', { paths }, `已${staged ? '取消暂存' : '暂存'} ${files.length} 个文件`)
    if (result && mounted.current && gitScopeRef.current === gitScope) setGitPick(null)
  }
  const gitStates = React.useMemo(() => {
    const states = new Map(), labels = { M: '已修改', A: '已新增', U: '未跟踪', D: '已删除', R: '已重命名', C: '已复制', '!': '存在冲突' }
    if (boundGit) return states // Bound changes describe a different explorer.
    const priority = ['!', 'D', 'M', 'R', 'C', 'A', 'U']
    for (const file of git?.files || EMPTY_FILES) {
      if (!file.open) continue
      const letter = fileState(file, file.staged && !file.unstaged)
      const label = `${labels[letter]}${file.staged ? ' · 已暂存' : ''}`
      let path = joinPath(rootPath, file.open)
      states.set(path, { letter, label })
      while ((path = path.slice(0, path.lastIndexOf('/'))) && path !== rootPath && path.startsWith(rootPath.endsWith('/') ? rootPath : `${rootPath}/`)) {
        const previous = states.get(path)
        if (!previous || priority.indexOf(letter) < priority.indexOf(previous.letter)) states.set(path, { letter, label: `目录包含${labels[letter]}文件` })
      }
    }
    return states
  }, [git, rootPath, boundGit])
  const stagedFiles = changedFiles.filter(file => file.staged)
  const unstagedFiles = changedFiles.filter(file => file.unstaged || file.untracked)
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
          onChange: event => changeSearchText(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              performSearch(searchText, searchFlags)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              changeSearchText('')
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
      searchNotice ? h('div', { className: 'world-vscode-search-notice', role: 'status' }, searchNotice.summary, detailsButton(searchNotice.details)) : null,
      searchError ? h('div', { className: 'world-vscode-error' }, errorMessage(searchError)) : null,
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
                open ? h(SearchHits, { file, revealRef: revealHitRef }) : null)
            })))
  }

  /** 批处理运行时占满编辑器正文：输出比代码更需要空间；标签栏、状态栏仍保留。 */
  const batchPanel = () => h('section', { className: 'world-vscode-output', 'aria-label': batchRun.label ? 'PBTest 输出' : '批处理输出' },
    h('div', { className: 'world-vscode-output-head' },
      h('span', { className: 'world-vscode-output-title', title: batchRun.path }, `${batchRun.label || '输出'} · ${baseName(batchRun.path)}`),
      h('span', { className: 'world-vscode-output-state' },
        batchRun.running ? '运行中…'
          : batchRun.error ? batchRun.error
            : batchRun.cancelled ? '已停止'
              : batchRun.exitCode === null ? '已结束' : `退出码 ${batchRun.exitCode}`,
        batchRun.durationMs ? ` · ${(batchRun.durationMs / 1000).toFixed(1)}s` : ''),
      h('div', { className: 'world-vscode-output-actions' },
        !batchRun.running && (batchRun.error || (!batchRun.cancelled && batchRun.exitCode != null && batchRun.exitCode !== 0))
          ? detailsButton([batchRun.error || `退出码 ${batchRun.exitCode}`, batchRun.text].filter(Boolean).join('\n')) : null,
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
    const picking = pick?.staged === staged
    return h('div', {
      key: `${staged ? 's' : 'w'}:${file.path}`,
      'data-git-path': file.path, 'data-git-staged': String(staged),
      className: 'world-vscode-git-file', role: picking ? 'group' : 'button', tabIndex: picking ? undefined : 0,
      style: { paddingLeft: 10 + depth * 14 },
      title: `${file.from ? `${file.from} → ` : ''}${file.path} · ${picking ? '勾选文件或点击文件名查看 Diff' : '单击查看 Diff，双击打开源码'}`,
      onContextMenu: event => {
        openFileMenu(event, file.path)
        setFileMenu(menu => ({ ...menu, gitFile: file, gitStaged: staged }))
      },
      onClick: () => openGitDiff(file, staged),
      onDoubleClick: event => {
        if (event.target.closest?.('button,input')) return
        openGitFile(file)
      },
      onKeyDown: event => {
        if (event.target !== event.currentTarget || event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openGitDiff(file, staged)
      },
    },
    picking ? h('input', { type: 'checkbox', checked: pick.paths.has(file.path), disabled: Boolean(gitOp || file.conflicted),
      'aria-label': `选择${staged ? '已暂存' : '更改'}文件 ${file.path}`, title: file.conflicted ? '请单独处理冲突文件' : file.path,
      onClick: event => event.stopPropagation(), onChange: () => togglePick(file, staged),
    }) : h(TwistSpacer),
    h('span', { className: `world-vscode-tab-icon ${entryIconClass(baseName(file.path))}` }, h(FileIcon)),
    picking ? h('button', { type: 'button', className: 'world-vscode-git-name world-vscode-git-pick-diff',
      'aria-label': `查看 ${file.path} 的差异` }, baseName(file.path))
      : h('span', { className: 'world-vscode-git-name' }, baseName(file.path)),
    h('span', { className: `world-vscode-git-state ${stateClass(letter)}` }, letter),
    !picking && h('button', {
      type: 'button', className: 'world-vscode-git-act',
      title: staged ? '取消暂存' : '暂存更改', 'aria-label': `${staged ? '取消暂存' : '暂存'} ${file.path}`,
      disabled: Boolean(gitOp),
      onClick: event => {
        event.stopPropagation()
        void runGit(staged ? 'unstage' : 'stage', { paths: gitFilePaths(file, staged) }, staged ? '已取消暂存' : '已暂存')
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
    const files = gitTreeFiles(node)
    const paths = files.flatMap(file => gitFilePaths(file, staged))
    const label = `${staged ? '取消暂存' : '暂存'} ${path} 下的 ${files.length} 个更改`
    return h('div', {
      key, className: `world-vscode-git-file is-dir${open ? ' is-open' : ''}`,
      role: 'button', tabIndex: 0,
      style: { paddingLeft: 10 + depth * 14 },
      title: `${path} · ${files.length} 个更改`, 'aria-expanded': open,
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
    pick?.staged !== staged && h('button', {
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

  const gitGroup = (title, list, staged) => {
    const picking = pick?.staged === staged
    const eligible = list.filter(file => !file.conflicted)
    const selected = picking ? eligible.filter(file => pick.paths.has(file.path)) : []
    return h('div', { className: 'world-vscode-git-group', onKeyDown: event => {
      if (picking && !gitOp && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setGitPick(null) }
    } },
    h('div', { className: 'world-vscode-git-group-head' },
      h('span', { className: 'world-vscode-git-group-title' }, title),
      h('i', { className: 'world-vscode-git-count' }, picking ? `${selected.length}/${list.length}` : list.length),
      (!pick || picking) && eligible.length > 0 && h('button', { type: 'button', className: 'world-vscode-git-pick-toggle',
        disabled: Boolean(gitOp), 'aria-pressed': picking, 'aria-label': picking ? '退出多选' : `多选${title}文件`,
        onClick: () => picking ? setGitPick(null) : beginPick(staged),
      }, picking ? '退出多选' : '多选'),
      !picking && h('button', {
        type: 'button', className: 'world-vscode-git-group-act',
        title: staged ? '全部取消暂存' : '全部暂存', 'aria-label': staged ? '全部取消暂存' : '全部暂存',
        disabled: Boolean(gitOp),
        onClick: () => void runGit(staged ? 'unstage' : 'stage', { paths: list.flatMap(file => gitFilePaths(file, staged)) },
          staged ? '已取消暂存' : '已暂存'),
      }, h(StageIcon, { undo: staged }))),
    picking && h('div', { className: 'world-vscode-git-actions', 'aria-busy': Boolean(gitOp) },
      h('button', { type: 'button', disabled: Boolean(gitOp || !selected.length),
        onClick: () => void applyPick(selected, staged),
      }, `${staged ? '取消暂存' : '暂存'}所选（${selected.length}）`)),
    gitTreeRows(buildGitTree(list), staged, 0, ''))
  }

  /** Diff controls share the sidebar workflow; historical patches remain read-only. */
  const diffEditor = tab => {
    if (tab.root !== gitRoot) return h('div', { className: 'world-vscode-git-note' }, `此差异属于另一个 Git 目录：${tab.root}`)
    const file = !tab.commit && git?.files?.find(file => file.path === tab.path)
    return h(GitDiffView, { tab, limit: DIFF_RENDER_LIMIT, busy: Boolean(gitOp), dirty: dirtyGitFile(file),
      onRefresh: () => void loadGitDiff(tab.id, tab),
      onHunk: hunk => void runGit(tab.staged ? 'unstage-hunk' : 'stage-hunk',
        { paths: [tab.path], snapshot: tab.snapshot, hunk }, tab.staged ? '已取消暂存此块' : '已暂存此块'),
      onStageFile: file && !file.conflicted && (tab.staged ? file.staged : file.unstaged || file.untracked) ? () => void runGit(tab.staged ? 'unstage' : 'stage',
        { paths: gitFilePaths(file, tab.staged) }, tab.staged ? '已取消暂存' : '已暂存') : undefined,
      onDiscard: file && !tab.staged && !file.conflicted && (file.unstaged || file.untracked) ? () => void discardGitFiles([file]) : undefined,
    })
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
          : current.error ? h('div', { className: 'world-vscode-git-note', role: 'alert' }, errorMessage('读取提交历史失败：' + current.error, current.error))
            : commits.length === 0 ? h('div', { className: 'world-vscode-git-note' }, current.value?.truncated ? '提交历史输出过长，未显示不完整记录。' : '暂无提交')
              : commits.map(commit => {
                const open = historyDetails.has(commit.hash)
                const files = historyFiles.get(commit.hash)
                return h('div', { key: commit.hash, className: 'world-vscode-git-commit' },
                  h('button', {
                    type: 'button', className: 'world-vscode-git-history-row', title: commit.subject,
                    'aria-expanded': open, onClick: () => {
                      if (!open) void loadHistoryFiles(commit.hash)
                      setHistoryDetails(current => {
                      const next = new Set(current)
                      if (next.has(commit.hash)) next.delete(commit.hash)
                      else next.add(commit.hash)
                      return next
                      })
                    },
                  }, h(Twist, { open }), h('code', null, commit.shortHash),
                  h('span', { className: 'world-vscode-git-name' }, commit.subject)),
                  open ? h('div', { className: 'world-vscode-git-note world-vscode-git-history-detail' },
                    h('div', null, '作者：', commit.author),
                    h('div', null, '提交时间：', commit.date ? new Date(commit.date).toLocaleString() : '—'),
                    h('div', null, 'Hash：', h('code', null, commit.hash)),
                    h('pre', null, commit.body || commit.subject),
                    !files || files.loading ? h('div', { role: 'status' }, '正在读取改动文件…')
                      : files.error ? h('div', { role: 'alert' }, errorMessage(files.error),
                        h('button', { type: 'button', onClick: () => void loadHistoryFiles(commit.hash, true) }, '重试读取改动文件'))
                        : h('div', { className: 'world-vscode-git-commit-files', 'aria-label': `${commit.shortHash} 的改动文件` },
                          h('div', null, `${files.value.files.length} 个改动文件${files.value.merge ? ' · 与第一父提交比较' : ''}`),
                          files.value.files.map(file => h('button', {
                            key: file.path, type: 'button', className: 'world-vscode-git-history-row',
                            title: `${file.from ? `${file.from} → ` : ''}${file.path} · 查看此提交的差异`,
                            'aria-label': `查看提交 ${commit.shortHash} 中 ${file.path} 的差异`,
                            onClick: () => openGitDiff(file, false, commit.hash),
                          }, h('span', { className: 'world-vscode-git-name' }, file.from ? `${file.from} → ${file.path}` : file.path),
                          h('span', { className: `world-vscode-git-state ${stateClass(file.status)}` }, file.status))),
                          !files.value.files.length && !files.value.truncated ? h('div', null, '此提交没有文件改动。') : null,
                          files.value.truncated ? h('div', null, '改动文件过多，列表已截断。') : null)) : null)
              }),
        current?.value?.truncated && !current.busy ? h('div', { className: 'world-vscode-git-note' }, '仅显示最近 20 条提交；输出过长时只显示完整记录。') : null) : null)
  }

  const gitPanel = () => h('div', { className: 'world-vscode-git' },
    h('div', { className: 'world-vscode-git-branch' },
      h('span', { className: 'world-vscode-git-branch-icon' }, h(BranchIcon)),
      h('span', { className: 'world-vscode-git-branch-name', title: git?.root || '' },
        !rootPath ? '先打开文件夹' : !git ? '读取中…' : git.repo ? (git.branch || 'HEAD') : '未检测到仓库'),
      git?.ahead ? h('span', { className: 'world-vscode-git-track is-ahead', title: `领先上游 ${git.ahead} 个提交` }, `↑${git.ahead}`) : null,
      git?.behind ? h('span', { className: 'world-vscode-git-track is-behind', title: `落后上游 ${git.behind} 个提交` }, `↓${git.behind}`) : null),
    git?.repo ? h(React.Fragment, null,
      h(GitCommitForm, { draft: commitDraft, hasStaged: Boolean(stagedFiles.length), conflicted: git.conflicted, gitOp,
        onCommit: message => void runGit('commit', { message }, '已提交') }),
      h('div', { className: 'world-vscode-git-actions' },
        h('button', {
          type: 'button', disabled: !canPull || !canPush, 'aria-busy': gitOp === 'sync',
          title: '先 git pull，成功后再 git push',
          onClick: () => void runGit('sync', {}, '同步完成'),
        }, h(RefreshIcon, { spinning: gitOp === 'sync' }), h('span', null, gitOp === 'sync' ? '同步中…' : '同步')),
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
    boundGit && h('div', { className: 'world-vscode-git-note' }, `Git 目录：${boundGit} `,
      h('button', { type: 'button', disabled: Boolean(gitOp), onClick: () => setGitFolder('') }, '解除绑定')),
    gitMsg ? h('div', {
      className: `world-vscode-git-msg${gitMsg.kind === 'error' ? ' is-error' : ''}`, title: gitMsg.text,
      role: gitMsg.kind === 'error' ? 'alert' : 'status',
    }, gitMsg.kind === 'error' && detailsButton(gitMsg.text), gitMsg.text) : null,
    git?.repo && !git.identity?.ok && stagedFiles.length
      ? h('div', { className: 'world-vscode-git-note' }, errorMessage('未配置 Git 身份，提交前请先设置 user.name 与 user.email。'))
      : null,
    h('div', { className: 'world-vscode-git-list' },
      !git ? h('div', { className: 'world-vscode-git-empty' }, '正在读取 Git 状态…')
        : !git.repo ? h('div', { className: 'world-vscode-git-empty' },
          h('span', null, git.statusError ? errorMessage(`读取 Git 状态失败：${git.statusError}`, git.statusError) : '这个文件夹不在 Git 仓库中。'),
          h('button', { type: 'button', onClick: () => openPicker('git') }, '选择 Git 文件夹'))
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
        disabled: !ima.available, title: ima.error || 'IMA 当前不可用', error: ima.error,
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
    for (const path of recentFolders) if (/\.zip\.workspace$/i.test(path)) items.push({
      id: `zip:${path}`, kind: 'zip', label: baseName(path).slice(0, -'.workspace'.length), path, note: 'ZIP 工作目录',
    })
    return items
  }, [pluginRoots, recentFolders])

  /** 模态目录选择器：只列子目录，路径与「上一级」在顶部。 */
  const pickerDialog = () => {
    const current = picker, title = current?.forGit ? '选择 Git 文件夹' : current?.adding ? '添加文件夹到工作区' : '打开文件夹'
    const disabled = current?.forGit
      ? !pickerDraft.trim() || Boolean(current.busy) || (Boolean(current.error) && pickerDraft === current.path)
      : !current?.path || Boolean(current?.busy) || Boolean(current?.error) || (current.adding && pickerDraft !== current.path)
    const recentItems = recentFolders.filter(path => path !== rootPath)
    return h('div', {
      className: 'world-vscode-picker', role: 'dialog', 'aria-modal': true, 'aria-label': title,
      // 点空白处＝取消（和系统「打开文件夹」一致）；键盘由上面的 window 监听统一处理
      onPointerDown: event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) closePicker()
      },
    },
    h('div', { className: 'world-vscode-picker-card', ref: pickerCardRef },
      h('header', { className: 'world-vscode-picker-head' },
        h('span', { className: 'world-vscode-picker-title' }, title),
        h('button', {
          type: 'button', className: 'world-vscode-picker-close', title: '关闭', 'aria-label': `关闭${title}`,
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
              onClick: () => { if (current.forGit || current.adding) void browseTo(path); else { closePicker(); void switchRoot(path) } },
            }, h('span', { className: 'world-vscode-picker-root-icon is-recent' }, h(FolderIcon, { open: false })),
            h('span', { className: 'world-vscode-picker-root-name' }, baseName(path)),
            h('span', { className: 'world-vscode-picker-root-note' }, nativePath(dirName(path) || path)))))) : null,
        !current.forGit && pluginRootItems.length ? h('div', { className: 'world-vscode-picker-roots' },
          h('span', { className: 'world-vscode-picker-roots-head' }, '插件位置'),
          h('div', { className: 'world-vscode-picker-roots-list' },
            pluginRootItems.map(item => h(React.Fragment, { key: item.id }, h('button', {
              type: 'button',
              className: `world-vscode-picker-root is-${item.kind}`,
              disabled: item.disabled,
              title: item.disabled ? `${item.title} · ${nativePath(item.path)}` : nativePath(item.path),
              onClick: () => {
                if (item.disabled) return
                if (current.adding) { void browseTo(item.path); return }
                closePicker()
                switchRoot(item.path)
              },
            }, h('span', { className: 'world-vscode-picker-root-icon is-' + item.kind }, h(FolderIcon, { open: false })),
            h('span', { className: 'world-vscode-picker-root-name' }, item.label),
            h('span', { className: 'world-vscode-picker-root-note' }, item.note)), detailsButton(item.error))))) : null,
        h('div', { className: 'world-vscode-picker-list' },
          current?.busy && h('div', { className: 'world-vscode-picker-note' }, '正在读取…'),
          current?.error && h('div', { className: 'world-vscode-error' }, errorMessage(current.error)),
          !current?.busy && !current?.error && !current?.folders?.length
            ? h('div', { className: 'world-vscode-picker-note' }, '这个文件夹里没有子文件夹')
            : null,
          !current?.busy && current?.folders?.map(item => h('button', {
            key: item.name, type: 'button', className: 'world-vscode-picker-row',
            title: item.name, onClick: () => void browseTo(joinPath(current.path, item.name)),
          }, h(FolderIcon, { open: false }), h('span', null, item.name))),
          current?.truncated ? h('div', { className: 'world-vscode-picker-note' }, '子文件夹过多，只显示前 2000 个。') : null)),
      h('footer', { className: 'world-vscode-picker-foot' },
        h('span', { className: 'world-vscode-picker-hint' }, current.forGit ? '只更改 Git 目录，不切换工程，不同步文件。' : current.adding ? '保留现有文件夹和标签；搜索和 Git 仍使用原目录。' : '打开后资源管理器、搜索和 Git 都以这个文件夹为根。'),
        h('div', { className: 'world-vscode-picker-actions' },
          h('button', { type: 'button', onClick: closePicker }, '取消'),
          !current.forGit && !current.adding && h('button', { type: 'button', disabled, onClick: () => applyFolder('new') }, '在新窗口打开'),
          h('button', {
            type: 'button', className: 'is-primary', disabled,
            onClick: () => applyFolder('this'),
          }, current.forGit ? '绑定 Git 目录' : current.adding ? '添加' : '打开')))))
  }

  const renderWelcome = () => h('div', { className: 'world-vscode-welcome' },
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
              keyHint(['Shift', 'Tab'], '反缩进')) : null)

  // 没有分屏时就是一个组，装着所有标签；组里只有 active 那个显示内容
  // （visibleLayout / splitMode 在上面算行号时就定了，这里直接用）
  const activeGid = tabGroupOf(visibleLayout, outerActive)
  // 查找面板只属于活动格：分屏时贴在那一格的右上角，不再横贯整个编辑区
  const outerRect = paneBounds(visibleLayout).get(activeGid)
  const findParent = parents[owners.get(findTarget)]
  const findPane = findParent ? paneBounds(findParent.layout).get(tabGroupOf(findParent.layout, findTarget)) : outerRect
  const findBar = findAvailable && findTarget === activeId && h('div', {
    className: 'world-vscode-findbar-layer',
    style: { left: `${findPane?.x ?? 0}%`, width: `${findPane?.w ?? 100}%`,
      ...(findPane?.y ? { top: `calc(${findPane.y}% + var(--vscode-tabs-h, 36px) + 6px)` } : {}) },
  }, h('div', {
    className: 'world-vscode-findbar', role: 'search', 'aria-label': '当前文件查找替换',
    onKeyDown: event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind() }
      else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.target === findReplaceInputRef.current) replaceFound(event.ctrlKey || event.metaKey)
        else stepFind(event.shiftKey ? -1 : 1)
      }
    },
  },
    h('div', { className: 'world-vscode-search-box' },
      // 只读文件（含超大只读视图）永远替换不了：收起那个按钮，别展开一排点不动的控件
      isLocked(active) ? null : h('button', { type: 'button', className: 'world-vscode-search-toggle', 'aria-label': '展开替换', 'aria-expanded': findReplace,
        onClick: () => setFindReplace(value => !value) }, h(ReplaceToggleIcon, { open: findReplace })),
      h('input', { ref: findInputRef, className: 'world-vscode-search-input', 'aria-label': '当前文件查找', placeholder: '查找当前文件',
        value: findQuery, spellCheck: false, onChange: event => setFindQuery(event.target.value) }),
      h('button', { type: 'button', className: `world-vscode-search-flag${findCase ? ' is-on' : ''}`, 'aria-label': '区分大小写',
        'aria-pressed': findCase, onClick: () => setFindCase(value => !value) }, 'Aa'),
      h('span', { className: 'world-vscode-find-count', role: 'status' }, findQuery
        ? findMatches.length
          ? `${Math.max(0, findIndex) + 1}/${findMatches.length}${findMatches.length >= MAX_TEXT_MATCHES ? '+' : ''}`
          : '无匹配'
        : '输入查找内容'),
      h('button', { type: 'button', className: 'world-vscode-sidebar-act', 'aria-label': '上一处', disabled: !findMatches.length, onClick: () => stepFind(-1) }, '↑'),
      h('button', { type: 'button', className: 'world-vscode-sidebar-act', 'aria-label': '下一处', disabled: !findMatches.length, onClick: () => stepFind(1) }, '↓'),
      h('button', { type: 'button', className: 'world-vscode-sidebar-act', 'aria-label': '关闭当前文件查找', onClick: closeFind }, h(ClearIcon))),
    findReplace && !isLocked(active) && h('div', { className: 'world-vscode-search-box' },
      h('input', { ref: findReplaceInputRef, className: 'world-vscode-search-input', 'aria-label': '当前文件替换为', placeholder: '替换为',
        value: findReplacement, spellCheck: false, onChange: event => setFindReplacement(event.target.value) }),
      h('button', { type: 'button', className: 'world-vscode-find-action', disabled: !findMatches.length || isLocked(active), onClick: () => replaceFound(false) }, '替换'),
      h('button', { type: 'button', className: 'world-vscode-find-action', disabled: !findMatches.length || isLocked(active), onClick: () => replaceFound(true) }, '全部替换'))))
  const surfaceFor = (id, group) => {
    // 每个空组有独立的欢迎页宿主，不能与活动文件共享 primary。
    if (!id) return `empty:${group.gid}`
    const tab = tabs.find(item => item.id === id)
    if (batchRun && !batchCollapsed && id === activeId) return 'primary'
    if (tab?.kind === 'document') return `document:${id}`
    if (tab?.kind === 'app') return `app:${id}`
    if ((splitMode && tab?.document) || codeView(tab)) return `source:${id}`
    return id === activeId ? 'primary' : `extra:${id}`
  }
  // A parent tab moves as one editor: its destination is the outer pane even over
  // a designer's child strip or sash. Only the destination pane's own strip merges tabs.
  const tabDestination = (event, id) => {
    let pane = event.target.closest('.world-vscode-pane')
    if (!pane || pane.closest('.world-vscode-window[data-world-vscode-key]') !== shellRef.current) return null
    if (parents[id]) pane = pane.closest('.world-vscode-pane:not([data-world-scope])')
    if (!pane) return null
    const { worldScope: scope = '', worldPane: gid } = pane.dataset
    if ((owners.get(id) || '') !== scope) return null
    const strip = event.target.closest('.world-vscode-tabs')
    if (strip?.parentElement === pane) return { scope, gid, strip }
    const target = groupById(parents[scope]?.layout || visibleLayout, gid)
    if (!target) return null
    return { scope, gid, edge: target.tabs.length ? closestPaneEdge(pane.getBoundingClientRect(), event.clientX, event.clientY) : 'fill' }
  }
  const tabDragOver = event => {
    if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
    const dest = draggedTab.current && tabDestination(event, draggedTab.current)
    if (!dest) { setPaneDrop(null); return }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
    setPaneDrop(current => !dest.edge ? null : current?.tab === dest.gid && current.edge === dest.edge ? current : { tab: dest.gid, edge: dest.edge })
  }
  const tabDrop = event => {
    setPaneDrop(null)
    draggedTab.current = null
    let source
    try { source = JSON.parse(event.dataTransfer.getData(TAB_DRAG_TYPE)) } catch { return }
    if (source.windowKey !== windowKey || (!parents[source.id] && !tabsRef.current.some(tab => tab.id === source.id))) return
    const dest = tabDestination(event, source.id)
    if (!dest) return
    const { scope, gid, strip, edge } = dest
    event.preventDefault(); event.stopPropagation()
    if (strip) {
      // 落点在哪个标签的左半边就插到它前面；比所有标签都靠右就追加到末尾
      const siblings = [...strip.querySelectorAll('.world-vscode-tab')]
        .filter(node => node.dataset.tabId !== source.id)
      let index = siblings.length
      for (let at = 0; at < siblings.length; at++) {
        const rect = siblings[at].getBoundingClientRect()
        if (event.clientX < rect.left + rect.width / 2) { index = at; break }
      }
      changeLayout(scope, layout => moveTabToGroup(layout, source.id, gid, index))
    } else {
      setBatchCollapsed(true)
      changeLayout(scope, layout => edge === 'fill' ? moveTabToGroup(layout, source.id, gid)
        : splitWithTab(layout, gid, source.id, edge, makeGid()))
    }
    activateTab(source.id)
  }
  const tabActions = React.useRef(null)
  React.useLayoutEffect(() => { tabActions.current = { activateTab, closeTab, pinTab, openTabMenu, draggedTab } })
  /** 每格自己的标签栏：组内的标签都列在这里，只有 active 那个显示内容。 */
  const renderStrip = (entry, labelFor) => h('div', {
    className: 'world-vscode-tabs', role: 'tablist', 'aria-label': '已打开的编辑器',
    'data-world-group': entry.gid, 'data-world-active': entry.active,
  }, entry.tabs.map(id => {
    const tab = parents[id] || tabs.find(item => item.id === id)
    if (!tab) return null
    const parent = parents[id]
    const selected = tab.id === activeId || Boolean(parent && outerActive === id)
    // 分屏后每个组各显示一个标签；只有全局 active 那组会拿到 .active，其余组用 is-current
    // 标出自己的当前标签，否则属性栏在显示 Properties 却看不出是哪个标签。
    const current = entry.active === tab.id
    const dirtyTab = parent ? tabs.some(item => (item.designKey === id || owners.get(item.id) === id) && isDirty(item)) : isDirty(tab)
    return h(EditorTabHeader, { key: id, tab, isParent: Boolean(parent), selected, current, dirtyTab,
      pinned: parent ? designPinned(parent) : tab.pinned, customLabel: labelFor?.(id), windowKey, activeTabRef, actions: tabActions })
  }))

  const tabMenuTab = tabMenu ? parents[tabMenu.id] || tabs.find(item => item.id === tabMenu.id) : null
  const menuScope = owners.get(tabMenu?.id)
  // 设计父标签的 path 是「文件 · 设计」，新窗口要用它背后的真实文件
  const newWindowPath = parents[tabMenu?.id]?.srw
    ? tabs.find(tab => tab.designKey === tabMenu.id)?.path
    : tabMenuTab && !tabMenuTab.kind ? tabMenuTab.path : ''
  const menuDesign = parents[tabMenu?.id]?.srw ? parents[tabMenu.id] : parents[menuScope]?.srw ? parents[menuScope] : null
  const resetDesign = parent => {
    setTabMenu(null)
    const { tabs: panels, layout } = defaultSrwPanels(parent.id, [makeGid(), makeGid()], { ...designLayout(), hasLayout: parent.srw.hasLayout, isSrd: parent.srw.isSrd, isSrm: parent.srw.isSrm })
    setTabs(list => { const known = new Set(list.map(t => t.id)); return [...list, ...panels.filter(t => !known.has(t.id))] })
    setDeck(deck => editLayout(deck, parent.id, () => layout))
    setActiveId(panels[0].id)
  }
  const menuLayout = parents[menuScope]?.layout || visibleLayout
  const menuIds = tabMenuTab ? memberIds(menuLayout) : []
  const tabMenuGroup = tabMenu ? groupById(menuLayout, tabGroupOf(menuLayout, tabMenu.id)) : null
  const groupAction = dest => {
    const id = tabMenu.id
    setTabMenu(null); pinTab(id); setActiveId(id)
    if (dest === 'new') {
      const seq = ++parentSeq.current, gid = makeGid()
      setDeck(current => wrapTab(current, id, `parent-${seq}`, `标签组 ${seq}`, gid))
    } else setDeck(current => moveMember(current, id, dest))
  }
  const tabMenuRight = tabMenuGroup && tabMenuTab
    ? tabMenuGroup.tabs.slice(tabMenuGroup.tabs.indexOf(tabMenu.id) + 1)
    : []

  const tabHandlers = React.useRef(null)
  tabHandlers.current = { over: tabDragOver, drop: tabDrop }
  React.useEffect(() => {
    const shell = shellRef.current
    const over = event => tabHandlers.current.over(event)
    const drop = event => tabHandlers.current.drop(event)
    const leave = event => { if (!shell.contains(event.relatedTarget)) setPaneDrop(null) }
    const clear = () => { draggedTab.current = null; setPaneDrop(null) }
    shell.addEventListener('dragover', over, true); shell.addEventListener('drop', drop, true); shell.addEventListener('dragleave', leave)
    window.addEventListener('dragend', clear); window.addEventListener('blur', clear)
    return () => { shell.removeEventListener('dragover', over, true); shell.removeEventListener('drop', drop, true); shell.removeEventListener('dragleave', leave)
      window.removeEventListener('dragend', clear); window.removeEventListener('blur', clear) }
  }, [])
  return h(ErrorDetailsContext.Provider, { value: setErrorDetails }, h('section', {
    className: `world-vscode-window${isActive ? ' is-active' : ''}${maximized ? ' is-max' : ''}${minimized ? ' is-min' : ''}${phone ? ' is-phone' : ''}`,
    'data-world-vscode-key': windowKey,
    ref: shellRef,
    // 窗口自己也能拿焦点：没有打开文件时，点标题栏激活后键盘也有落点
    tabIndex: -1,
    onPointerDown: activate,
    style: {
      // 保留还原矩形；最大化只切换壳的 CSS，不让整棵文件树继承一组新的尺寸变量。
      '--vscode-x': `${rect.x}vw`, '--vscode-y': `${rect.y}vh`,
      '--vscode-w': `${rect.w}vw`, '--vscode-h': `${rect.h}vh`,
      zIndex,
    },
    // 多开时两个窗口的无障碍名字不能一样，否则分不清读的是哪个文件夹
    'aria-label': displayName ? `Visual Studio Code — ${displayName}` : 'Visual Studio Code',
  },
  !replaySearch && toolHistory,
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
        type: 'button', className: 'world-vscode-title-btn', title: '搜索文件 (Ctrl+P)',
        'aria-label': '搜索文件', onClick: openQuick,
      }, h(SearchIcon)),
      !collectionMode && h('button', {
        type: 'button', className: 'world-vscode-title-btn',
        title: rootPath ? '对话 · 与当前文件夹的 dsh 会话聊天' : '先打开一个文件夹',
        'aria-label': '打开对话', disabled: !rootPath, onClick: openChatTab,
      }, h(ChatIcon)),
      testRows.size > 0 && h('button', { type: 'button', className: 'world-vscode-title-btn',
        title: '文件内单元测试', 'aria-label': '文件内单元测试', onClick: () => showView('run') }, h(RunIcon)),
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
      pbProject && activityButton('run', h(RunIcon, { size: 20 }), '运行', 0, 'F5'),
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
    (sidebarOpen || replaySearch)
      ? h('aside', { className: 'world-vscode-sidebar', style: { width: `${sidebarWidth}px` } },
        h('header', { className: 'world-vscode-sidebar-head' },
          h('span', { className: 'world-vscode-sidebar-title' }, replaySearch ? SIDE_TITLES.search : SIDE_TITLES[sideView]),
          h('div', { className: 'world-vscode-sidebar-actions' },
            sideView === 'files' ? h(React.Fragment, null,
              !collectionMode && h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '打开文件夹', 'aria-label': '打开文件夹',
                onClick: openPicker,
              }, h(FolderIcon, { open: true })),
              !collectionMode && h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '添加文件夹到工作区', 'aria-label': '添加文件夹到工作区',
                onClick: () => openPicker('add'),
              }, h(StageIcon)),
              h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '刷新目录', 'aria-label': '刷新目录',
                onClick: () => void refreshTree(),
              }, h(RefreshIcon, { spinning: Boolean(busyDir) })),
              h('button', {
                type: 'button', className: 'world-vscode-sidebar-act', title: '全部折叠', 'aria-label': '全部折叠',
                onClick: () => setExpanded(new Set(treeRoots)),
              }, h(CollapseIcon))) : null,
            sideView === 'search' && searchResult?.files.length ? h('button', {
              type: 'button', className: 'world-vscode-sidebar-act',
              title: searchAllOpen ? '全部折叠' : '全部展开', 'aria-label': searchAllOpen ? '全部折叠' : '全部展开',
              onClick: toggleAllSearchFiles,
            }, searchAllOpen ? h(CollapseIcon) : h(ExpandIcon)) : null,
            sideView === 'search' && (searchText || searchResult) ? h('button', {
              type: 'button', className: 'world-vscode-sidebar-act', title: '清空搜索', 'aria-label': '清空搜索', onClick: () => changeSearchText(''),
            }, h(ClearIcon)) : null)),
        replaySearch ? h('div', { className: 'world-vscode-search', 'data-world-tool-search': true }, toolHistory)
          : sideView === 'run' && canShowRun ? h(React.Fragment, null,
            testRows.size > 0 && h('section', { className: 'world-vscode-pb-panel', 'aria-label': '文件内单元测试' },
              h('strong', null, baseName(active.path)), testHint && h('small', { role: 'status' }, testHint), testButton(),
              [...testRows].map(([line, target]) => h('div', { key: line }, testButton(target), h('small', null, ` · L${line}`)))),
            pbProject && h(PbRunPanel, { key: pbProject.id, project: pbProject, job: pbJob }))
          : sideView === 'git' ? gitPanel()
          : sideView === 'search' ? searchPanel()
            : h('div', { className: 'world-vscode-explorer-list' },
              treeRoots.map(root => {
                const open = expanded.has(root), note = open ? dirNote(tree.get(root)) : ''
                return h(React.Fragment, { key: root }, h('button', {
                  type: 'button', className: `world-vscode-root${open ? ' is-open' : ''}`,
                  'aria-expanded': open, title: collectionMode ? displayName : root,
                  onClick: () => root ? toggleDir(root) : openPicker(),
                  onContextMenu: collectionMode || !root ? undefined : event => openFileMenu(event, root),
                }, h(Twist, { open }), h(FolderIcon, { open }),
                h('span', { className: 'world-vscode-root-name' }, collectionMode ? displayName.toUpperCase() : baseName(root))),
                open && h(ExplorerRows, { treeRoot: root, collectionMode, tree, expanded, selected: active?.path, gitStates,
                  pbLibraries: root === rootPath ? pbLibraries : EMPTY_LIBRARIES,
                  application: root === rootPath ? pbProject?.application : null, actions: explorerActions }),
                note && h('div', { className: 'world-vscode-file-note', role: 'status' }, note))
              }),
              busyFile && h('div', { className: 'world-vscode-file-note' }, '正在打开文件…'),
              error && h(ErrorNote, {
                text: error, onDismiss: () => setError(''),
                onCopied: copied => copied ? flashNotice('错误原文已复制') : setErrorDetails({ text: error, trigger: document.activeElement }),
              }),
              !rootPath && !collectionMode && !error && h('div', { className: 'world-vscode-file-note' }, '尚未选择文件夹'),
              pluginRootItems.length && !collectionMode ? h('div', { className: 'world-vscode-roots' },
                h('div', { className: 'world-vscode-roots-head' }, '插件位置'),
                pluginRootItems.map(item => h(React.Fragment, { key: item.id }, h('button', {
                  type: 'button',
                  className: `world-vscode-root-entry is-${item.kind}${item.disabled ? ' is-disabled' : ''}${!item.disabled && item.path === rootPath ? ' is-current' : ''}`,
                  title: item.disabled ? `${item.title || '当前不可用'} · ${nativePath(item.path)}` : nativePath(item.path),
                  disabled: item.disabled,
                  onClick: () => { setError(''); switchRoot(item.path) },
                },
                h('span', { className: `world-vscode-root-icon is-${item.kind}` }, h(FolderIcon, { open: false })),
                h('span', { className: 'world-vscode-file-name' }, item.label),
                h('span', { className: 'world-vscode-root-note' }, item.note)), detailsButton(item.error)))) : null),
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
    h('main', { className: 'world-vscode-editor',
      onContextMenu: e => {
        if (!e.target.closest('.world-vscode-editor-content')) return
        const pane = e.target.closest('.world-vscode-pane'), id = pane?.querySelector(':scope > .world-vscode-tabs')?.dataset.worldActive
        const tab = tabs.find(t => t.id === id), input = largeHandles.current.get(id) || e.target.closest('textarea')
        if (!tab || !input || input.selectionStart === input.selectionEnd) return
        const range = {from: input.selectionStart, to: input.selectionEnd}
        if (input.multiline ? !input.multiline(range.from, range.to) : !input.value.slice(range.from, range.to).includes('\n')) return
        openFileMenu(e, tab.path)
        setFileMenu(menu => ({ ...menu, fold: () => foldSource(id, range) }))
      },
      onPointerDownCapture: event => {
        const pane = event.target.closest('.world-vscode-pane')
        if (!pane?.dataset.worldPane || pane.closest('.world-vscode-window[data-world-vscode-key]') !== shellRef.current) return
        const scope = pane.dataset.worldScope
        // A click in a horizontally scrolled painter strip selects its own tab. Activating
        // the old pane here would scroll that old tab into view between pointerdown and click.
        if (parents[scope]?.srw && event.target.closest('.world-vscode-tabs')) return
        const entry = groupById(parents[scope]?.layout || visibleLayout, pane.dataset.worldPane)
        if (entry && !scope) focusedGroup.current = entry.group
        if (entry && !parents[entry.active] && entry.active !== activeId) setActiveId(entry.active)
      },
    },
      h('div', { className: `world-vscode-panes${splitMode ? ' is-split' : ''}` }, h(PaneLayout, {
        layout: visibleLayout, mounts: paneMounts, surface: surfaceFor, active: outerActive, preview: paneDrop,
        nested: id => {
          const parent = parents[id]
          if (!parent) return null
          const panes = (body, labelFor) => h('div', { className: `world-vscode-panes is-split${parent.srw ? ' world-srw-panes' : ''}`, 'data-parent-content': id,
            onContextMenu: parent.srw ? e => openDesignMenu(e, parent) : undefined }, h(PaneLayout, {
            scope: id, layout: parent.layout, mounts: paneMounts, surface: surfaceFor, active: parent.active, preview: paneDrop, nested: body,
            strip: entry => renderStrip(entry, labelFor), onRatio: (path, ratio) => changeLayout(id, layout => setPaneRatio(layout, path, ratio)),
            // 双击分隔条：根层回到「按当前宽度算出的默认比例」，用户自己拖出来的子层回 50:50
            onReset: path => changeLayout(id, layout => setPaneRatio(layout, path, path.length ? .5 : designLayout().ratio)),
          }), id === findParent?.id ? findBar : null)
          if (parent.srw) return h(SrwDesigner, { key: id, parent, wrap, applicationFor, activeId: isActive && !minimized ? activeId : null, render: panes, onDirty: () => designDirtyChanged(parent.srw), openView: view => openDesignView(parent, view) })
          // 组里最后一个文件被设计视图接管后会留下一个空组：说清楚它还在、怎么用，别点开一片空白。
          return h(React.Fragment, null, panes(), memberIds(parent.layout).length ? null : h('div', { className: 'world-vscode-pane-empty' },
            h('p', null, '这个分组里没有标签了'),
            h('button', { type: 'button', onClick: () => closeTab(id) }, '关闭分组')))
        },
        strip: renderStrip,
        // 分隔条只改这一层的分配比例，树结构和标签一个都不动
        onRatio: (path, ratio) => changeLayout('', layout => setPaneRatio(layout, path, ratio)),
      }),
      !findParent && findBar),
      ...groupsOf(visibleLayout).filter(group => !group.tabs.length).map(group => h(TabSurface, {
        key: `empty:${group.gid}`, manager: paneMounts, id: `empty:${group.gid}`,
      }, renderWelcome())),
      ...tabs.filter(tab => tab.kind === 'app').map(tab => h(TabSurface, { key: tab.id, manager: paneMounts, id: `app:${tab.id}` },
        h(DockSlot, { manager: docking, id: tab.appId, visible: visibleSet.has(tab.id) && isActive && !minimized }))),
      ...tabs.filter(tab => !tab.openAsDesign && (codeView(tab) || splitMode && visibleSet.has(tab.id)) && tab.document && !tab.kind).map(tab => {
        const rows = visibleSet.has(tab.id) ? fileTests(tab).gutter : null
        const testProps = rows?.size ? {testRows: rows, runTest: target => runTest(target, tab),
          testsDisabled: Boolean(isDirty(tab) || tab.stale || batchStarting || batchRun?.running)} : null
        return h(TabSurface, {key: `source:${tab.id}`, manager: paneMounts, id: `source:${tab.id}`},
          codeView(tab) ? h(LargeSource, { tab, locked: isLocked(tab), ...testProps, publishTests, visible: visibleSet.has(tab.id), phone, wrap, handles: largeHandles,
            onActivate: () => setActiveId(tab.id), onCaret: (line, column) => {
              setCaretLine(line); setCaretColumn(column)
              const handle = largeHandles.current.get(tab.id)
              if (handle?.context) {
                const ctx = handle.context()
                editorContext.current = { path: tab.path, line: line + 1, column: column + 1,
                  selection: ctx.selection, dirty: isDirty(tab) }
              }
            },
            // 打字只走 CodeMirror，不经过 React：第一次变脏时给标签挂上标记，之后连 setState 都不需要
            // （返回同一个数组引用，React 直接跳过整次渲染）。
            onEdit: (draft, state) => setTabs(current => {
              if (draft !== undefined) return current.map(t => t.id === tab.id ? { ...t, draft, pinned: true, editHistory: {text: draft, state} } : t)
              const target = current.find(item => item.id === tab.id)
              if (!target || target.edited) return current
              return current.map(item => item.id === tab.id ? { ...item, edited: true, pinned: true } : item)
            }),
          }) : h(SplitSource, { tab, ...testProps, onFold: foldSource, phone, wrap, bookmarks: bookmarks.current, active: activeId === tab.id, inputRef: textareaRef,
            onFocus: () => setActiveId(tab.id),
            onCaret: syncCaret,
            onChange: change => { setTabs(current => current.map(item => item.id === tab.id ? applyNativeEdit(item, change) : item)); setNotice('') },
          }))
      }),
      ...tabs.filter(tab => tab.kind === 'diff' && tab.id !== activeId).map(tab => h(TabSurface, {
        key: `extra:${tab.id}`, manager: paneMounts, id: `extra:${tab.id}`,
      }, diffEditor(tab))),
      ...tabs.filter(tab => tab.kind === 'chat' && tab.id !== activeId).map(tab => h(TabSurface, {
        key: `extra:${tab.id}`, manager: paneMounts, id: `extra:${tab.id}`,
      }, h(VscodeChat, { active: isActive && visibleSet.has(tab.id), sessionId: tab.sessionId, boundSessionId: session?.id, rootPath, rpc,
        sessions, SessionProvider, renderSlot, conversationSeat, onSelectSession: selectChatSession, editorContext: editorContext.current }))),
      ...tabs.filter(tab => tab.kind === 'document').map(tab => h(TabSurface, {
        key: `document:${tab.id}:${tab.path}:${tab.previewRevision || 0}`, manager: paneMounts, id: `document:${tab.id}`,
      }, h(NativeErrorScope, { className: 'world-vscode-document', 'data-world-document': tab.path, visible: visibleSet.has(tab.id) && isActive && !minimized,
      }, h(NativeDocument, {
        path: tab.path, sessionId: session?.id, sessions, SessionProvider, renderSlot,
        visible: visibleSet.has(tab.id) && isActive && !minimized,
        onOpen: path => openFile(path, true), onClose: () => closeTab(tab.id),
      })))),
      h(TabSurface, { manager: paneMounts, id: 'primary' },
      batchRun && !batchCollapsed ? batchPanel()
        : active?.openAsDesign ? h('p', { className: 'world-srw-note', role: 'status' }, '正在打开设计视图…')
        : active?.kind === 'app' || codeView(active) || (splitMode && active?.document && !active.kind) ? null
        : active?.kind === 'document' || active?.kind === 'srw-view' ? null
        : active?.kind === 'chat'
        ? h(VscodeChat, {
          active: isActive, sessionId: active.sessionId, boundSessionId: session?.id, rootPath, rpc,
          sessions, SessionProvider, renderSlot, conversationSeat,
          onSelectSession: selectChatSession, editorContext: editorContext.current,
        })
        : active?.kind === 'diff'
        ? diffEditor(active)
        : active?.document
          ? h('div', {
          className: `world-vscode-editor-content${wrap ? ' is-wrap' : ''}`,
          style: {
            ...gutterStyle(gutterWidth, folds, activeTestGutter, phone),
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
          h('div', { className: 'world-vscode-gutter', 'aria-hidden': !folds?.size && !(activeTestGutter.size && !phone) },
            tops
              ? h('div', { className: 'world-vscode-gutter-rows is-absolute' },
                wrapLines.map(index => h('div', {
                  key: index,
                  className: `world-vscode-gutter-row is-absolute${index === caretLine ? ' is-active' : ''}`,
                  // 折行的行各自顶边不同：逐条绝对定位，数字仍然贴在各自第一行视觉行上
                  style: { top: `${tops[index] - scrollTop}px`, height: `${tops[index + 1] - tops[index]}px` },
                }, gutterLabel(index + 1))))
              // 折行但还没量到（刚切文件那一帧）：槽留着、不画数字，正文就不会左右跳一下
              : wrap
                ? null
                : h('div', {
                  className: 'world-vscode-gutter-rows',
                  style: { transform: `translateY(${gutterOffset}px)` },
                }, gutterRows.map(number => h('div', {
                  key: number,
                  className: `world-vscode-gutter-row${number === caretLine + 1 ? ' is-active' : ''}`,
                }, gutterLabel(number))))),
          // 折行时得有个不可见的镜像层来量「每行折成几行」（见上面的测量 effect）
          wrap ? h('div', { ref: measureRef, className: 'world-vscode-measure', 'aria-hidden': true }) : null,
          highlightReady
            ? h('div', {
              ref: highlightRef,
              className: `world-vscode-highlight${wrap ? ' is-wrap' : ''}${highlighted ? '' : ' is-word-mirror'}`, 'aria-hidden': true,
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
            key: `${active.id}:${active.path}:${active.reload || 0}`, ref: textareaRef, 'data-source-tab': active.id,
            className: `world-vscode-textarea${highlightReady && highlighted ? ' is-highlight' : ''}${wrap ? ' is-wrap' : ''}`,
            'aria-label': `编辑 ${baseName(active.path)}`,
            readOnly: isLocked(active),
            spellCheck: false, wrap: wrap ? 'soft' : 'off', defaultValue: active.draft,
            onScroll: onEditorScroll,
            // 组字期间退回原生文字（高亮层同时让位），否则中文候选串是透明的
            onCompositionStart: () => { words.clear(); setComposing(true) },
            onCompositionEnd: () => setComposing(false),
            onSelect: event => { rememberTextPosition(bookmarks.current, active.document, event.currentTarget); syncCaret(event.currentTarget) },
            onFocus: event => { setEditing(true); syncCaret(event.currentTarget) },
            onBlur: () => { words.clear(); setEditing(false) },
            onClick: event => syncCaret(event.currentTarget),
            onMouseUp: event => words.click(event, active.draft, starts),
            onChange: event => {
              if (isLocked(active)) return
              words.clear()
              const change = nativeInput(event)
              // 一旦改动就锁定标签，避免下一次点文件时被预览标签顶掉、还弹一次确认
              setTabs(list => list.map(tab => tab.id === active.id ? applyNativeEdit(tab, change) : tab))
              // 打字后光标也动了：不跟一下，状态栏的行列会停在打字前
              syncCaret(event.target)
              setNotice('')
            },
            onKeyDown: event => {
              if (isLocked(active) || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
                // Alt+↑ / Alt+↓ 移动行，Shift+Alt+↓ 复制行；Ctrl+/ 切换行注释（都是 VSCode 的键位）
              } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing
                && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault()
                applyLineEdit(input, event.shiftKey
                  ? duplicateLineBlock(input.value, input.selectionStart, input.selectionEnd)
                  : moveLineBlock(input.value, input.selectionStart, input.selectionEnd, event.key === 'ArrowUp' ? -1 : 1))
                syncCaret(input)
                setNotice('')
              } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '/') {
                event.preventDefault()
                applyLineEdit(input, toggleCommentBlock(input.value, input.selectionStart, input.selectionEnd,
                  commentPrefixOf(languageOf(active.path))))
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
          : null)),
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
          pbProject && phoneMenuRow('run', h(RunIcon, { size: 18 }), '运行', 0),
          !collectionMode && phoneMenuRow('git', h(SourceControlIcon, { size: 18 }), '源代码管理', changedFiles.length),
          // 标签栏上那个放大镜已经去掉；手机上仍要能进当前文件查找（对着标签点没地方按 Ctrl+F）
          findAvailable && h('button', {
            type: 'button', className: 'world-vscode-phone-row', role: 'menuitem',
            onClick: () => { setPhoneMenuOpen(false); openFind(false) },
          },
          h('span', { className: 'world-vscode-phone-row-icon' }, h(SearchIcon, { size: 18 })),
          h('span', { className: 'world-vscode-phone-row-label' }, '当前文件查找')),
          // 设计组在手机上只能靠这个入口复位：触屏没有右键菜单
          designOwner && parents[designOwner.designKey] && h('button', {
            type: 'button', className: 'world-vscode-phone-row', role: 'menuitem',
            onClick: () => { setPhoneMenuOpen(false); resetDesign(parents[designOwner.designKey]) },
          },
          h('span', { className: 'world-vscode-phone-row-icon' }, h(RefreshIcon)),
          h('span', { className: 'world-vscode-phone-row-label' }, '恢复默认布局'))))
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
      title: `${batchRun.label || (batchRun.running ? '批处理运行中' : '批处理输出')}：${batchRun.path} · 点击展开输出`,
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
    !collectionMode && rootPath ? h('button', {
      type: 'button', className: 'world-vscode-git-refresh world-vscode-status-branch', title: '刷新 Git 状态',
      'aria-label': '刷新 Git 状态', 'aria-busy': gitOp === 'status', disabled: Boolean(gitOp),
      onClick: () => { void refreshGit(); void refreshTree() },
    }, h(RefreshIcon, { spinning: gitOp === 'status' })) : null,
    pendingProject ? h('span', { className: 'world-vscode-status-msg is-active', role: 'status', title: projectOpeningText(pendingProject) }, projectOpeningText(pendingProject)) : error
      ? h(React.Fragment, null, h('span', { className: 'world-vscode-status-error' }, error), detailsButton(error))
      // 手机上这段被挤到只剩 15px，「未保存」会截成「未..」：改成一个符号，
      // 完整文字留在 title 里（桌面仍然是完整文字，宽着）。
      : h('span', {
        className: `world-vscode-status-msg${notice || saving || activeDirty ? ' is-active' : ''}${readOnlyLabel ? ' is-readonly' : ''}`,
        title: notice || (saving ? '正在保存…' : activeDirty ? '未保存' : readOnlyLabel || ''),
      }, phone
        ? (notice ? '✓' : saving ? '…' : activeDirty ? '●' : readOnlyLabel || '')
        : (notice || (saving ? '正在保存…' : activeDirty ? '未保存' : readOnlyLabel || ''))),
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
      }, active.kind === 'chat' ? '对话' : active.commit ? `Diff · 提交 ${active.commit.slice(0, 7)}`
        : active.staged ? 'Diff · 已暂存' : active.untracked ? 'Diff · 未跟踪' : 'Diff · 工作区')
      : null,
    designFile(active) && active.document && h('button', { type: 'button', onClick: () => openDesign(active), title: '用设计组替换源码标签，保留未保存修改' }, '设计视图'),
    designOwner && h('button', { type: 'button', disabled: saving, onClick: () => restoreSource(designOwner) }, '返回源码'),
    designOwner && h('span', { className: 'world-vscode-status-meta' }, `${designOwner.document.encoding || 'UTF-8'} · ${designOwner.srw.readOnly ? '只读' : 'PB 设计'}`),
    active?.kind === 'diff' || active?.kind === 'chat' || active?.kind === 'document' ||
    (active?.kind === 'srw-view' && active.view !== 'script' && active.view !== 'variables') ? null : h('button', {
      type: 'button', className: `world-vscode-status-wrap${wrap ? ' is-on' : ''}`,
      title: wrap ? '自动换行：开（点击关闭，Alt+Z）' : '自动换行：关（点击打开，Alt+Z）',
      'aria-pressed': wrap, onClick: () => setWrap(value => !value),
    }, phone ? '换行' : '自动换行'),
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: `换行符 ${active.document.eol || 'LF'}` },
      active.document.eol || 'LF') : null,
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: '文件编码' },
      active.document.encoding && active.document.encoding !== 'UTF-8' ? active.document.encoding : active.document.bom ? 'UTF-8 BOM' : 'UTF-8') : null,
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: '语言模式' },
      language ? languageLabel(language) : extension) : null,
    active?.document && !phone ? h('span', { className: 'world-vscode-status-meta', title: '文件行数' }, `${lineCount} 行`) : null,
    (active?.stale || designOwner?.stale) ? h('button', {
      type: 'button', className: 'world-vscode-status-stale',
      disabled: saving || (active?.stale ? activeDirty : isDirty(designOwner)),
      title: '磁盘上的文件已被外部修改；重新读取会放弃当前草稿',
      onClick: () => void reloadStale(active?.stale ? active : designOwner),
    }, phone ? '磁盘已更新' : '磁盘已更新 · 重新加载') : null,
    (designOwner || active?.document) ? h('button', { type: 'button', disabled: !activeDirty || saving, title: '保存 (Ctrl+S)', onClick: () => void saveFile() },
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
    currentPath: designOwner?.path || (findAvailable ? active.path : null),
    onOpen: async (file, position) => {
      setQuickOpen(false)
      const path = file ? absolutePath(file) : designOwner?.path || active?.path
      if (!path) return
      if (!position) { await openFile(path, true); return }
      if (isDocumentPreviewPath(path)) { setError('此文件使用文档预览，不支持按源码行号跳转。'); return }
      // A local jump stays in this exact pane/draft. SRW design views use their backing source.
      if ((file || designOwner) && !await openFile(path, true, undefined, undefined, 'source')) return
      setReveal({ path, ...position, nonce: ++revealSeq.current })
    } }) : null,
  tabMenu && tabMenuTab && (!tabMenu.script || tabMenu.objectIndex === objectIndex) ? h('div', {
    ref: tabMenuRef, className: 'world-context-menu world-vscode-menu world-vscode-tab-menu', role: 'menu',
    style: { left: tabMenu.x, top: tabMenu.y },
    onPointerDown: event => event.stopPropagation(),
    onContextMenu: event => event.preventDefault(),
  },
  h('div', { className: 'world-context-title', title: tabMenuTab.path }, baseName(tabMenuTab.path)),
  tabMenu.script?.actions ? tabMenu.script.actions.map(([label, enabled, run]) => h('button', {
    key: label, type: 'button', role: 'menuitem', disabled: !enabled, onClick: async () => {
      setTabMenu(null)
      try { await tabMenu.script.run(run) } catch (error) { setError(error.message) }
    },
  }, label)) : h(React.Fragment, null,
  menuDesign && h(React.Fragment, null,
    h('button', { type: 'button', role: 'menuitem', disabled: saving, onClick: () => {
      const owner = tabsRef.current.find(t => t.designKey === menuDesign.id)
      setTabMenu(null); if (owner && !savingRef.current) restoreSource(owner)
    } }, '切换回源代码'),
    h('button', { type: 'button', role: 'menuitem', onClick: () => resetDesign(menuDesign) }, '恢复默认布局')),
  h('button', {
    type: 'button', role: 'menuitem', autoFocus: true,
    onClick: () => { setTabMenu(null); void closeTab(tabMenu.id) },
  }, '关闭'),
  h('button', {
    type: 'button', role: 'menuitem', disabled: menuIds.length < 2,
    onClick: () => { const id = tabMenu.id; setTabMenu(null); void closeTabs(menuIds.filter(key => key !== id)) },
  }, '关闭其他'),
  h('button', {
    type: 'button', role: 'menuitem', disabled: !tabMenuRight.length,
    onClick: () => { const ids = tabMenuRight; setTabMenu(null); void closeTabs(ids) },
  }, '关闭右侧'),
  h('button', {
    type: 'button', role: 'menuitem',
    onClick: () => { setTabMenu(null); void closeTabs(menuIds) },
  }, '关闭全部'),
  designFile(tabMenuTab) && h('button', { type: 'button', role: 'menuitem', disabled: !tabMenuTab.document, onClick: () => openDesign(tabMenuTab) }, '打开设计视图'),
  // 折叠/「折叠选中文本」会把普通标签切到 CodeMirror：这里给出回到轻量文本视图的出口。
  !tabMenuTab.kind && tabMenuTab.foldEditor && !largeSource(tabMenuTab) && h('button', {
    type: 'button', role: 'menuitem',
    onClick: () => { const id = tabMenuTab.id; setTabMenu(null); setTabs(list => list.map(t => t.id === id ? { ...t, foldEditor: null } : t)) },
  }, '切回文本编辑'),
  newWindowPath && !collectionMode && h('button', { type: 'button', role: 'menuitem', onClick: () => {
    setTabMenu(null); onOpenInNewWindow?.(newWindowPath, { file: true, newWindow: true })
  } }, '在新窗口打开'),
  !tabMenuTab.kind && [
    !menuScope && h('button', { key: 'new', type: 'button', role: 'menuitem', onClick: () => groupAction('new') }, '创建父标签组'),
    ...Object.values(parents).filter(parent => !parent.srw && parent.id !== menuScope).map(parent => h('button', {
      key: parent.id, type: 'button', role: 'menuitem', onClick: () => groupAction(parent.id),
    }, `移入${parent.path}`)),
    menuScope && h('button', { key: 'out', type: 'button', role: 'menuitem', onClick: () => groupAction(undefined) }, '移出父标签组'),
  ]),
  tabMenu.objectNote && h('div', { className: 'world-context-note' }, tabMenu.objectNote),
  tabMenu.matches?.map(path => h('button', { key: path, type: 'button', role: 'menuitem', title: path, style: { overflowWrap: 'anywhere' },
    onClick: () => { setTabMenu(null); void openFile(joinPath(rootPath, path), true) },
  }, `打开 ${baseName(path).replace(/\.[^.]+$/, '')}${tabMenu.matches.length > 1 ? `（${path}）` : ''}`))) : null,
  // 菜单留在窗口里：portal 到 body 会被 world 的 inert 逻辑锁住（host 窗口关闭时），
  // 也会被窗口的 stacking context 压在下面；fixed 定位本身不受 overflow 裁剪。
  fileMenu ? h('div', {
    ref: fileMenuRef, className: 'world-context-menu world-vscode-menu', role: 'menu',
    style: { left: fileMenu.x, top: fileMenu.y },
    onPointerDown: event => event.stopPropagation(),
    onContextMenu: event => event.preventDefault(),
  },
  h('div', { className: 'world-context-title', title: fileMenu.path }, baseName(fileMenu.path)),
  fileMenu.fold ? h('button', {type: 'button', role: 'menuitem', autoFocus: true, onClick: () => { fileMenu.fold(); setFileMenu(null) }}, '折叠选中文本') : fileMenu.gitFile ? h(React.Fragment, null,
    h('button', { type: 'button', role: 'menuitem', autoFocus: true,
      onClick: () => { openGitDiff(fileMenu.gitFile, fileMenu.gitStaged); setFileMenu(null) } }, '查看差异'),
    h('button', { type: 'button', role: 'menuitem', disabled: Boolean(gitOp),
      onClick: () => {
        const file = fileMenu.gitFile, staged = fileMenu.gitStaged; setFileMenu(null)
        void runGit(staged ? 'unstage' : 'stage', { paths: gitFilePaths(file, staged) }, staged ? '已取消暂存' : '已暂存')
      } }, fileMenu.gitStaged ? '取消暂存' : '暂存更改'),
    !fileMenu.gitStaged ? h('button', { type: 'button', role: 'menuitem', disabled: Boolean(gitOp || fileMenu.gitFile.conflicted),
      onClick: () => { const file = fileMenu.gitFile; setFileMenu(null); void discardGitFiles([file]) } }, '放弃更改') : null,
  ) : h(React.Fragment, null,
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
  }, '复制绝对路径'))) : null,
  errorDetails && h(ErrorDetailsDialog, { details: errorDetails, onClose: () => setErrorDetails(null) })))
}
