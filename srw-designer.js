import React from 'react'
import { errorMessage } from './vscode-error-details.js'
import { makeGroup } from './vscode-layout.js'
import { SrmLayout } from './srm-layout.js'
import { SrdLayout, SrdProperties } from './srd-layout.js'
import { SrwCodeEditor } from './srw-code-editor.js'
import { declarationBounds } from './srw-declarations.js'
import { createEdits, editBounds } from './srw-edits.js'
import { createSrwIndexLookup, srwPaintCandidates } from './srw-canvas-index.js'
import { pbX, pbY, parsePainter } from './srw-model.js'

const h = React.createElement
export const srwViews = { layout: 'Layout', script: 'Script', events: 'Event List', functions: 'Function List', variables: 'Variables', properties: 'Properties', controls: 'Control List', nonvisual: 'Non-Visual Object List' }
const visualSides = [['layout', 'script', 'events', 'functions', 'variables'], ['properties', 'controls', 'nonvisual']]
const menuSides = visualSides.map(side => side.filter(view => view !== 'variables'))
// 右栏是属性/对象清单，太窄就读不成行；默认比例由调用方按编辑器可用宽度算（见 designLayout）。
export function defaultSrwPanels(key, gids, { ratio = .68, axis = 'row', hasLayout = true, isSrd = false, isSrm = false } = {}) {
  const sides = isSrd ? [['layout'], ['properties']] : isSrm ? menuSides : hasLayout ? visualSides : [['script', 'events', 'functions', 'variables'], ['properties', 'nonvisual']]
  const tabs = sides.flat().map(view => ({ id: `${key}:${view}`, view, path: `${key}/${srwViews[view]}`, kind: 'srw-view', pinned: true }))
  const share = Math.min(.82, Math.max(.5, Number(ratio) || .68))
  const layout = { axis: axis === 'column' ? 'column' : 'row', ratio: share, children: sides.map((views, i) => makeGroup(gids[i], views.map(view => `${key}:${view}`))) }
  return { tabs, layout }
}
const LAYOUT_KEY = 'world.srw.layout', ZOOM_KEY = 'world.srw.zoom'
let memoryZoom = null
/** 画布缩放是全局偏好：所有 SRW 设计组共用同一个比例。 */
export function readSrwZoom() {
  if (memoryZoom != null) return memoryZoom
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY))
    return Number.isFinite(value) && value >= .5 && value <= 2 ? Math.round(value * 10) / 10 : 1
  } catch { return 1 }
}
export function saveSrwZoom(value) {
  const zoom = Math.round(Number(value) * 10) / 10
  if (!Number.isFinite(zoom)) return
  memoryZoom = Math.min(2, Math.max(.5, zoom))
  try { localStorage.setItem(ZOOM_KEY, String(memoryZoom)) } catch { /* 内存里已经记下 */ }
}
const viewNames = new Set(Object.keys(srwViews))
// about:blank / 隐私模式下 localStorage 会抛错：退回模块内存，至少同一会话里能记住。
const memoryLayouts = new Map()
// 整个 store 只解析一次；此后读写都在这份对象上，拖分隔条时才不会每帧 JSON.parse。
let layoutStore = null
const writtenLayouts = new Map()
function allLayouts() {
  if (layoutStore) return layoutStore
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')
    layoutStore = value && typeof value === 'object' ? value : {}
  } catch { layoutStore = {} }
  return layoutStore
}
const srdViewNames = new Set(['layout', 'properties'])
const srmViewNames = new Set(menuSides.flat())
const validTree = (node, allowed, depth = 0) => {
  if (!node || typeof node !== 'object' || depth > viewNames.size) return false
  if (Array.isArray(node.views)) return node.views.length > 0 && node.views.every(view => allowed.has(view)) && (!node.active || node.views.includes(node.active))
  return (node.axis === 'row' || node.axis === 'column') && Array.isArray(node.children) && node.children.length === 2 && node.children.every(child => validTree(child, allowed, depth + 1))
}
const perFile = path => /\.sr[waum](?::visual|:script)?$/i.test(path)
function storageKey(path) {
  const name = path.replaceAll('\\', '/')
  return `${LAYOUT_KEY}.file:${/^(?:[a-z]:\/|\/\/)/i.test(name) ? name.toLowerCase() : name}`
}
function readStoredLayout(path, allowed) {
  if (perFile(path)) {
    const key = storageKey(path)
    let tree = memoryLayouts.get(key)
    try {
      const text = localStorage.getItem(key)
      if (text) { tree = JSON.parse(text); writtenLayouts.set(key, text) }
    } catch { /* unavailable storage */ }
    if (validTree(tree, allowed)) return tree
  }
  const tree = memoryLayouts.get(path) ?? allLayouts()[path]
  return validTree(tree, allowed) ? tree : null
}
/** 把运行中的 layout（带 key 前缀的标签 id）压成与本次打开无关的树。 */
export function packSrwLayout(layout, key) {
  const name = id => typeof id === 'string' && id.startsWith(`${key}:`) ? id.slice(key.length + 1) : ''
  if (Array.isArray(layout?.tabs)) {
    const views = layout.tabs.map(name).filter(Boolean)
    return views.length ? { views, active: name(layout.active) || views[0] } : null
  }
  if (!Array.isArray(layout?.children)) return null
  const children = layout.children.map(child => packSrwLayout(child, key)).filter(Boolean)
  if (children.length !== 2) return children[0] || null
  return { axis: layout.axis === 'column' ? 'column' : 'row', ratio: layout.ratio, children }
}
export function saveSrwLayout(path, tree, focus) {
  if (!path || !tree) return
  // 拖动分隔条每帧都会调到这里：先按序列化结果去重，再改缓存对象，避免重复 stringify 整个 store。
  if (perFile(path)) {
    const key = storageKey(path), value = { ...tree, focus }, text = JSON.stringify(value)
    if (writtenLayouts.get(key) !== text) {
      try { localStorage.setItem(key, text) } catch { /* retain the in-memory fallback */ }
      writtenLayouts.set(key, text); memoryLayouts.set(key, value)
    }
    return
  }
  const text = JSON.stringify(tree)
  if (writtenLayouts.get(path) === text) return
  writtenLayouts.set(path, text)
  memoryLayouts.set(path, tree)
  const all = allLayouts()
  all[path] = tree
  const keys = Object.keys(all)
  if (keys.length > 300) for (const key of keys.slice(0, keys.length - 200)) { delete all[key]; writtenLayouts.delete(key); memoryLayouts.delete(key) }
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(all)) } catch { /* 内存里已经记下 */ }
}
function rebuildLayout(tree, key, nextGid, out) {
  if (Array.isArray(tree.views)) {
    const tabs = tree.views.map(view => ({ id: `${key}:${view}`, view, path: `${key}/${srwViews[view]}`, kind: 'srw-view', pinned: true }))
    out.tabs.push(...tabs)
    out.active ||= `${key}:${tree.active || tree.views[0]}`
    return makeGroup(nextGid(), tabs.map(tab => tab.id), `${key}:${tree.active || tree.views[0]}`)
  }
  const children = tree.children.map(child => rebuildLayout(child, key, nextGid, out))
  return { axis: tree.axis === 'column' ? 'column' : 'row', ratio: Math.min(.95, Math.max(.05, Number(tree.ratio) || .5)), children }
}
/** 上次打开这个文件时的分组与比例会还原；没有记录（或记录损坏）才用默认两栏。 */
export function srwPreset(key, path, text, nextGid, { readOnly = true, dirty = false, model = null, readBase, pinned = false, ...space } = {}) {
  const isSrd = /\.srd$/i.test(path), isSrm = /\.srm$/i.test(path), hasLayout = !/\.sra$/i.test(path) && model?.hasLayout !== false
  const layoutKey = /\.sru$/i.test(path) ? `${path}:${hasLayout ? 'visual' : 'script'}` : path
  const stored = readStoredLayout(layoutKey, isSrd ? srdViewNames : isSrm ? srmViewNames : viewNames)
  let tabs, layout, active
  if (stored) {
    const out = { tabs: [], active: '' }
    layout = rebuildLayout(stored, key, nextGid, out)
    tabs = out.tabs
    active = (isSrd ? tabs.find(tab => tab.view === 'layout') : tabs.find(tab => tab.view === stored.focus))?.id || out.active
  } else {
    ({ tabs, layout } = defaultSrwPanels(key, [nextGid(), nextGid()], { ...space, hasLayout, isSrd, isSrm }))
    active = tabs[0].id
  }
  return { tabs, parent: { id: key, kind: 'tab-group', pinned, path: `${path.split(/[\\/]/).pop()} · 设计`, active, layout,
    srw: { path, layoutKey, hasLayout, isSrd, isSrm, model, readBase, text, readOnly, edits: createEdits(dirty), state: { positions: {}, pages: {}, category: 'General', declare: 'instance', scrolledTo: '', zoom: readSrwZoom(), selection: [] } } } }
}
// React's previous render or a pending event can retain a closed tab's metadata. Release
// the large snapshot/index explicitly after commit; never clear a still-open hidden group.
export function useSrwLifetime(parents) {
  const owned = React.useRef(new Set()), mounted = React.useRef(false)
  const release = session => { session.text = ''; session.model = null; session.edits.patches.clear(); session.edits.saved.clear(); session.edits.different.clear() }
  React.useLayoutEffect(() => {
    const next = new Set(Object.values(parents).map(p => p.srw).filter(Boolean))
    for (const session of owned.current) if (!next.has(session)) release(session)
    owned.current = next
  }, [parents])
  React.useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; queueMicrotask(() => {
      if (!mounted.current) { for (const session of owned.current) release(session); owned.current.clear() }
    }) }
  }, [])
}
function useModel(session) {
  const [, ready] = React.useReducer(n => n + 1, 0)
  React.useLayoutEffect(() => {
    if (session.model) return
    return parsePainter(session.text, session.path, model => { session.model = model; ready() }, session.readBase)
  }, [session])
  return session.model
}
const isEvent = s => s.kind === 'event' || s.kind === 'on'
const preferred = obj => obj.scripts.find(s => s.name.toLowerCase() === (obj.within ? 'clicked' : 'open')) || obj.scripts[0]
const note = text => h('p', { className: 'world-srw-note' }, text)
// 空属性要给占位符：空的 dd 比有字的一行矮 3px，整列看着像少了一块。
// 注意 0 / false 是有效值，不能用 `value || '—'` 吞掉。
const blank = value => value === '' || value == null
const showValue = value => blank(value) ? '—' : value
// 布尔属性画成只读复选框，其余直接显示值；两个设计器（窗体 / 用户对象）共用同一套
const propValue = (key, value) => /^(true|false)$/i.test(value)
  ? h('input', { type: 'checkbox', checked: String(value).toLowerCase() === 'true', disabled: true, 'aria-label': key })
  : showValue(value)
const propList = list => h('dl', null, list.map(([key, value]) => h('div', { key }, h('dt', null, key), h('dd', null, propValue(key, value)))))
const number = val => val != null && /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : undefined
function boxGeometry(p, root) {
  const style = {}
  for (const [key, axis] of [['width', pbX], ['height', pbY], ['x', pbX], ['y', pbY]]) {
    if (root && (key === 'x' || key === 'y')) continue
    const n = number(p[key]); if (n !== undefined) style[{ x:'left', y:'top' }[key] || key] = axis(n)
  }
  return style
}
const hiddenDw = o => o.base.toLowerCase() === 'datawindow' && o.props.visible?.toLowerCase() === 'false'
const canvasBounds = o => o.nonvisual || hiddenDw(o) ? null : boxGeometry(o.props, false)
function boxStyle(obj, root) {
  const p = obj.props, style = boxGeometry(p, root)
  // PB RGB longs store the red component in the low byte; leave system colors to the painter theme.
  const rgb = v => { const n = number(v); return n >= 0 && n <= 0xffffff ? `rgb(${n & 255},${n >> 8 & 255},${n >> 16 & 255})` : undefined }
  style.backgroundColor = rgb(p.backcolor); style.color = rgb(p.textcolor)
  const align = { 'left!':'left', 'right!':'right', 'center!':'center' }
  if (Object.hasOwn(align, p.alignment)) style.textAlign = align[p.alignment]
  return style
}
function paintMeta(o) {
  const type = o.base.toLowerCase(), p = o.props
  return { type, style: boxStyle(o, false), hidden: hiddenDw(o), muted: p.visible === 'false' || p.enabled === 'false',
    // A groupbox without text is only a frame in PB.
    text: type === 'groupbox' ? p.text ?? '' : p.text ?? (/(edit|datawindow|listbox)$/.test(type) ? p.dataobject || '' : o.name) }
}
function Canvas({ model, indexFor, obj, select, script, state, zoom = 1, onZoom, selection = [], toggle }) {
  const root = model.root, client = React.useRef(null)
  const zoomRef = React.useRef(zoom), zoomTo = React.useRef(onZoom)
  zoomRef.current = zoom; zoomTo.current = onZoom
  // Ctrl+滚轮缩放画布。必须用原生监听：React 的 wheel 是被动的，preventDefault 拦不住页面缩放。
  React.useLayoutEffect(() => {
    const node = client.current
    if (!node) return
    const wheel = event => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const now = zoomRef.current || 1
      const next = Math.min(2, Math.max(.5, Math.round(now * 10 + (event.deltaY < 0 ? 1 : -1)) / 10))
      if (next !== now) zoomTo.current?.(next)
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])
  // 从 Control List 选中的控件常常在视口外；画布是虚拟化的，querySelector 找不到未挂载的节点，
  // 只能按 PB 坐标算出内容位置再滚。已经滚到过的对象不重复抢滚动位置。
  React.useLayoutEffect(() => {
    const node = client.current, view = node?.closest('[data-srw-view]'), target = model.objects.get(obj.id)
    if (!node || !view || !target || state.scrolledTo === obj.id) return
    state.scrolledTo = obj.id
    const frame = requestAnimationFrame(() => {
      const py = Number(target.props.y), ph = Number(target.props.height)
      if (!Number.isFinite(py)) return
      const top = node.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop + pbY(py) * zoom
      const height = Number.isFinite(ph) ? pbY(ph) * zoom : 0
      if (top < view.scrollTop + 4 || top + height > view.scrollTop + view.clientHeight - 4) view.scrollTop = Math.max(0, top - 32)
    })
    return () => cancelAnimationFrame(frame)
  }, [obj.id])
  const [viewport, setViewport] = React.useState(null)
  // 方向键在相邻控件之间移动：把选中当作画布里的光标，roving tabindex 只留一个 Tab 落点。
  const pendingFocus = React.useRef('')
  const firstControl = React.useMemo(() => root.children.find(c => !c.nonvisual && !hiddenDw(c))?.id, [root])
  const roving = obj !== root ? obj.id : firstControl
  const navigate = (from, key) => {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key]
    const px = Number(from.props.x) || 0, py = Number(from.props.y) || 0
    const cx = pbX(px) + pbX(Number(from.props.width) || 0) / 2, cy = pbY(py) + pbY(Number(from.props.height) || 0) / 2
    let best = null, score = Infinity
    for (const o of model.objects.values()) {
      if (o === from || o === root || o.nonvisual) continue
      const type = o.base.toLowerCase()
      if (type === 'datawindow' && o.props.visible?.toLowerCase() === 'false') continue
      const ox = pbX(Number(o.props.x) || 0) + pbX(Number(o.props.width) || 0) / 2
      const oy = pbY(Number(o.props.y) || 0) + pbY(Number(o.props.height) || 0) / 2
      const dx = ox - cx, dy = oy - cy
      if (dir[0] ? Math.sign(dx) !== dir[0] : Math.sign(dy) !== dir[1]) continue
      const along = Math.abs(dir[0] ? dx : dy), across = Math.abs(dir[0] ? dy : dx)
      if (along < 1) continue
      const value = along + across * 2
      if (value < score) { score = value; best = o }
    }
    if (!best) return
    pendingFocus.current = best.id
    select(best)
  }
  React.useLayoutEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    const node = client.current?.querySelector(`[data-srw-object="${id}"]`)
    if (node) { pendingFocus.current = ''; node.focus() }
  }, [viewport, obj.id])
  // Small windows need no listeners. For dense windows mount only the controls in view.
  React.useLayoutEffect(() => {
    if (!indexFor) return
    const node = client.current, scroller = node.closest('[data-srw-view]')
    let frame = 0
    const measure = () => {
      frame = 0
      const view = scroller.getBoundingClientRect(), origin = node.getBoundingClientRect(), scale = zoom || 1
      setViewport({ x: (view.left - origin.left) / scale, y: (view.top - origin.top) / scale,
        right: (view.right - origin.left) / scale, bottom: (view.bottom - origin.top) / scale })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure(); scroller.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule); observer.observe(scroller)
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', schedule); cancelAnimationFrame(frame) }
  }, [indexFor, zoom])
  // Keep paint metadata only for visited candidates and only while Layout is mounted.
  const prepared = React.useMemo(() => new Map(), [model])
  const pickedSet = React.useMemo(() => new Set(selection), [selection])
  const dense = Boolean(indexFor)
  const drawChildren = (parent, depth, x, y) => {
    if (!parent.children.length || depth > 48 || (dense && !viewport)) return null
    const index = indexFor?.(parent)
    return index ? srwPaintCandidates(index, viewport, x, y).map(i => draw(parent.children[i], depth, x, y))
      : parent.children.map(c => draw(c, depth, x, y))
  }
  const draw = (c, depth, x, y) => {
    if (c.nonvisual) return null
    let meta = prepared.get(c.id)
    if (!meta) { meta = paintMeta(c); prepared.set(c.id, meta) }
    // Canvas only: a hidden DataWindow is still inspectable in the Control List.
    if (meta.hidden) return null
    const type = meta.type, style = meta.style, left = x + (style.left || 0), top = y + (style.top || 0)
    if (dense && (!viewport || left > viewport.right || top > viewport.bottom ||
      (style.width != null && left + style.width < viewport.x) || (style.height != null && top + style.height < viewport.y))) return null
    const pickedControl = c !== obj && pickedSet.has(c.id)
    return h('div', { key: c.id, role: 'button', tabIndex: c.id === roving ? 0 : -1, 'aria-label': c.name, 'aria-pressed': c === obj,
      'data-srw-object': c.id, 'data-type': type, title: `${c.name} : ${c.base}`,
      className: `world-srw-control${meta.muted ? ' is-muted' : ''}${pickedControl ? ' is-picked' : ''}`, style,
      onClick: e => { e.stopPropagation(); (e.ctrlKey || e.metaKey) ? toggle?.(c) : select(c) }, onDoubleClick: e => { e.stopPropagation(); script(c) },
      onKeyDown: e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); e.key === 'Enter' ? script(c) : select(c) }
        else if (e.key.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); navigate(c, e.key) }
      },
    }, meta.text ? h('span', null, (type === 'checkbox' ? '☐ ' : type === 'radiobutton' ? '○ ' : '') + meta.text) : null, drawChildren(c, depth + 1, left, top))
  }
  // 多选时把包围盒读出来：设计时量一组控件的整体尺寸，不必逐个加。
  const picked = selection.map(id => model.objects.get(id)).filter(o => o && o !== root)
  const box = picked.length > 1 ? picked.reduce((acc, o) => {
    const x = Number(o.props.x) || 0, y = Number(o.props.y) || 0
    return { left: Math.min(acc.left, x), top: Math.min(acc.top, y),
      right: Math.max(acc.right, x + (Number(o.props.width) || 0)), bottom: Math.max(acc.bottom, y + (Number(o.props.height) || 0)) }
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }) : null
  // 适应窗口：窗口 PB 尺寸换算成像素后按画布可视区缩放，最多 100%。
  const fit = () => {
    const view = client.current?.closest('[data-srw-view]')
    const width = pbX(Number(root.props.width) || 0), height = pbY(Number(root.props.height) || 0)
    if (!view || !width) return
    const scale = Math.min(1, (view.clientWidth - 16) / width, height ? (view.clientHeight - 16) / height : 1)
    if (Number.isFinite(scale)) onZoom?.(Math.min(2, Math.max(.5, Math.round(scale * 10) / 10)))
  }
  return h(React.Fragment, null,
    h(ZoomBar, { zoom, onZoom, onFit: fit, obj, picked: box ? { count: picked.length, ...box } : null }),
    model.partial && note('片段预览：仅显示本文件显式声明的属性，不展开模板或依赖。'),
    h('div', { className: 'world-srw-window', 'aria-label': `窗口 ${root.name}`, style: zoom === 1 ? boxStyle(root, true) : { ...boxStyle(root, true), zoom }, onClick: () => select(root) },
      root.props.titlebar?.toLowerCase() === 'true' && h('div', { className: 'world-srw-caption' }, root.props.title || root.name),
      h('div', { ref: client, className: 'world-srw-client' }, drawChildren(root, 0, 0, 0))),
    (!root.props.width || !root.props.height) && note('窗口尺寸未在本文件中完整声明；继承和运行时布局不展开。'))
}
function ZoomBar({ zoom, onZoom, onFit, obj, picked }) {
  const step = delta => onZoom(Math.min(2, Math.max(.5, Math.round((zoom + delta) * 10) / 10)))
  const p = obj?.props || {}
  const size = p.width != null && p.height != null ? `${p.width}×${p.height}` : ''
  const label = picked ? `${picked.count} 个 · ${picked.right - picked.left}×${picked.bottom - picked.top}` : size ? `${obj.name} ${size}` : ''
  const title = picked ? `选中 ${picked.count} 个控件 · x ${picked.left}, y ${picked.top} · ${picked.right - picked.left}×${picked.bottom - picked.top}`
    : [obj?.name, p.x != null || p.y != null ? `x ${p.x ?? 0}, y ${p.y ?? 0}` : '', size].filter(Boolean).join(' · ')
  return h('div', { className: 'world-srw-zoom', role: 'toolbar', 'aria-label': '画布缩放' },
    h('button', { type: 'button', onClick: () => step(-.1), disabled: zoom <= .5, 'aria-label': '缩小画布', title: '缩小（Ctrl+滚轮）' }, '−'),
    h('button', { type: 'button', onClick: () => onZoom(1), title: '恢复 100%' }, `${Math.round(zoom * 100)}%`),
    h('button', { type: 'button', onClick: () => step(.1), disabled: zoom >= 2, 'aria-label': '放大画布', title: '放大（Ctrl+滚轮）' }, '+'),
    h('button', { type: 'button', onClick: onFit, title: '把整个窗口缩到画布可见范围内' }, '适应'),
    label ? h('span', { className: 'world-srw-zoom-size', title }, label) : null)
}
const categories = ['General', 'Scroll', 'Toolbar', 'Other']
const categoryOf = key => /scroll/i.test(key) ? 'Scroll' : /toolbar/i.test(key) ? 'Toolbar' : /^(title|text|tag|menuname|visible|enabled|titlebar|controlmenu|minbox|maxbox|center|border|borderstyle|windowtype|windowstate|backcolor|icon|x|y|width|height|resizable|dataobject|fontface|fontsize|fontweight|italic|underline|alignment|moveable)$/.test(key) ? 'General' : 'Other'
// General 里几十条属性平铺太长：按 PB 的语义再分四段，每段可折叠。
const propGroups = [
  ['标识', /^(name|from|tag|menuname)$/i],
  ['外观', /^(title|text|backcolor|textcolor|fontface|fontsize|fontweight|fontcharset|italic|underline|alignment|border|borderstyle|icon|picturename|graphicname)$/i],
  ['位置与大小', /^(x|y|width|height|center|resizable|moveable)$/i],
  ['状态', /^(visible|enabled|titlebar|controlmenu|minbox|maxbox|windowtype|windowstate|displayonly|readonly|taborder)$/i],
]
const groupOf = key => propGroups.find(([, re]) => re.test(key))?.[0] || '其它'
function Properties({ obj, state, change, scriptOnly, application }) {
  if (scriptOnly) {
    const { easerverproject = '', ...values } = { ...obj.instanceProps, ...obj.props }
    // 用户对象没有可视窗体，属性比 srw 少；但也不能是一张没分组的裸表。
    // 沿用 srw 的 details/summary 分组版式，字段仍是 dt+dd（测试按相邻兄弟读值）。
    const buckets = [
      application ? ['应用程序', [['Name', obj.name], ['From', obj.base]]] : ['用户对象', [
        ['AutoInstantiate', h('input', { type: 'checkbox', 'aria-label': 'AutoInstantiate', disabled: true, checked: Boolean(obj.autoInstantiate) })],
        ['EAServer Project', easerverproject],
      ]],
      ['属性', Object.entries(application ? obj.props : values)],
    ]
    return h(React.Fragment, null, h('nav', { 'aria-label': '属性分类' }, h('button', { 'aria-pressed': true }, 'General')),
      buckets.filter(([, list]) => list.length).map(([label, list]) => h('details', { key: label, className: 'world-srw-group', open: true },
        h('summary', null, label, h('i', null, ` ${list.length}`)),
        propList(list))))
  }
  const rows = Object.entries(obj.props).filter(([key]) => categoryOf(key) === state.category)
  if (state.category === 'General') rows.unshift(['Name', obj.name], ['From', obj.base])
  const buckets = new Map()
  for (const row of rows) {
    const label = state.category === 'General' ? groupOf(row[0]) : '属性'
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label).push(row)
  }
  return h(React.Fragment, null, h('nav', { 'aria-label': '属性分类' }, categories.map(cat => h('button', { key: cat, 'aria-pressed': cat === state.category,
    onClick: () => change({ category: cat }) }, cat))),
    rows.length ? [...buckets].map(([label, list]) => h('details', { key: label, className: 'world-srw-group', open: true },
      h('summary', null, label, h('i', null, ` ${list.length}`)),
      propList(list)))
      : note('没有显式声明的属性。'))
}
// The parsed object list is immutable. Build its native options off-DOM and insert
// them together; ordinary selection/dirty-state updates only need to change value.
function ScriptObjectSelect({ objects, value, onChange }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    const select = ref.current, doc = select.ownerDocument, options = doc.createDocumentFragment()
    for (const o of objects.values()) {
      const option = doc.createElement('option')
      option.value = o.id; option.textContent = o.name; options.appendChild(option)
    }
    select.replaceChildren(options)
  }, [objects])
  React.useLayoutEffect(() => { ref.current.value = value }, [objects, value])
  return h('select', { ref, 'aria-label': '脚本对象', onChange })
}
const ScriptOptions = React.memo(function ScriptOptions({ members }) {
  return members.map(s => h('option', { key: s.id, value: s.id }, s.signature))
})
function ScriptMemberSelect({ obj, current, events, choose }) {
  const ref = React.useRef(null)
  const members = React.useMemo(() => events === undefined ? obj.scripts : obj.scripts.filter(s => isEvent(s) === events), [obj.scripts, events])
  // A controlled select walks the native options on each update. A user change is
  // already selected; only synchronize a different member chosen elsewhere in the UI.
  React.useLayoutEffect(() => {
    const select = ref.current, value = current?.id || ''
    if (select.value !== value) select.value = value
  }, [members, current])
  return h('select', { ref, 'aria-label': '事件或函数', title: current?.signature, onChange: e => {
    const member = members[e.currentTarget.selectedIndex]
    if (member) choose(obj, member)
  } }, h(ScriptOptions, { members }))
}
function ObjectScriptHeader({ obj, current, choose }) {
  const events = current ? isEvent(current) : false
  const kind = events ? 'events' : 'functions'
  return h('nav', null,
    h('select', { 'aria-label': '脚本类别', value: kind, onChange: e => choose(obj, obj.scripts.find(s => isEvent(s) === (e.target.value === 'events'))) },
      h('option', { value: 'functions', disabled: !obj.scripts.some(s => !isEvent(s)) }, '(Functions)'),
      h('option', { value: 'events', disabled: !obj.scripts.some(isEvent) }, '(Events)')),
    h(ScriptMemberSelect, { obj, current, events, choose }))
}
function EditableRange({ session, range, label, active, onDirty, wrap }) {
  const bounds = editBounds(range, session.text)
  if (bounds && !session.readOnly) return h(SrwCodeEditor, { session, bounds, script: range, label, active, wrap, inline: Boolean(range.inline), onDirty })
  return h(React.Fragment, null, h(SrwCodeEditor, { session, bounds: { key: range.id || `vars:${range.start}`, start: range.start, end: range.end }, script: range, label, wrap, inline: Boolean(range.inline), readOnly: true, active: false }),
    !session.readOnly && !bounds && note(errorMessage('此段缺少完整边界或包含混合指令，请切换回源代码编辑。')))
}
const declareKinds = [
  ['global', 'Global', 'Global Variables'],
  ['shared', 'Shared', 'Shared Variables'],
  ['instance', 'Instance', 'Instance Variables'],
  ['globalExternal', 'Global External', 'Global External Functions'],
  ['localExternal', 'Local External', 'Local External Functions'],
]
// The same SRA session backs its own painter and each object's two application declaration pages.
function ApplicationDeclares({ file, kind, label, wrap, active }) {
  const [error, setError] = React.useState(''), attach = React.useRef(file.attach)
  attach.current = file.attach
  const owner = file.owner
  React.useEffect(() => {
    if (owner?.document || file.saving) return
    const controller = new AbortController()
    setError('')
    file.read(file.path, controller.signal).then(doc => {
      if (controller.signal.aborted) return
      if (typeof doc?.source !== 'string') throw new Error('未返回应用程序源码。')
      attach.current(doc)
    }).catch(e => { if (!controller.signal.aborted) setError(String(e?.message || e)) })
    return () => controller.abort()
  }, [file.path, file.read, owner?.document, file.saving])
  if (owner?.srw) return h(ApplicationBody, { session: owner.srw, kind, label, wrap, active, onDirty: file.changed })
  if (owner?.document) return h('button', { type: 'button', disabled: file.saving, onClick: () => file.attach() }, '使用已打开的 .sra 源码草稿编辑声明')
  return error ? note(errorMessage('无法读取应用程序声明。', `${file.path}：${error}`)) : note('正在读取应用程序声明…')
}
function ApplicationBody({ session, kind, label, wrap, active, onDirty }) {
  const model = useModel(session)
  const bounds = React.useMemo(() => model && declarationBounds(model, kind, session.text), [model, kind, session.text])
  if (!model) return note('正在解析应用程序声明…')
  const readOnly = session.readOnly || bounds?.readOnly, source = session.path.split(/[\\/]/).pop()
  return h(React.Fragment, null,
    h('p', { className: 'world-srw-declare-hint world-srw-application-source', title: session.path }, `应用程序 · ${source}（${readOnly ? '只读' : '保存到此文件'}）`),
    bounds ? h(SrwCodeEditor, { session, bounds, label: `${source} · ${label}`, wrap, readOnly, active: active && !readOnly, onDirty })
      : note(`没有可安全编辑的 ${label} 源码段。`))
}
function Declares({ session, model, state, change, activeId, parentId, onDirty, wrap, applicationFor }) {
  const kind = model.declares[state.declare] ? state.declare : 'instance'
  const label = declareKinds.find(([id]) => id === kind)[2]
  const applicationOnly = !model.isApplication && (kind === 'global' || kind === 'globalExternal')
  const bounds = React.useMemo(() => applicationOnly ? null : declarationBounds(model, kind, session.text), [applicationOnly, model, kind, session.text])
  const nav = h('nav', { 'aria-label': '声明分类' }, declareKinds.map(([id, text, title]) => h('button', {
    key: id, type: 'button', title, 'aria-pressed': id === kind, onClick: () => { change({ declare: id }); onDirty() },
  }, text)))
  if (applicationOnly) {
    const file = applicationFor(session.path)
    return h(React.Fragment, null, nav, file
      ? h(ApplicationDeclares, { key: file.path, file, kind, label, wrap, active: activeId === `${parentId}:variables` })
      : note('未找到对应的应用程序 .sra。'))
  }
  const hint = kind === 'globalExternal' ? '应用程序的 type prototypes 均为全局外部函数，无需 global 前缀。'
    : kind === 'localExternal' && !model.isApplication ? '当前对象的局部外部函数，来自 type prototypes 段。' : null
  return h(React.Fragment, null, nav,
    hint && h('p', { className: 'world-srw-declare-hint' }, hint),
    bounds ? h(SrwCodeEditor, { key: kind, session, bounds, wrap, label: `编辑 ${label}`, active: !session.readOnly && !bounds.readOnly && activeId === `${parentId}:variables`,
      readOnly: session.readOnly || bounds.readOnly, onDirty }) : model.isApplication && kind === 'localExternal' ? note('应用程序没有局部外部函数，请查看 Global External。') : note(errorMessage(`没有可安全编辑的 ${label} 源码段。`)),
    bounds?.readOnly && !session.readOnly && note(errorMessage('此段缺少完整边界，请切换回源代码编辑。')))
}
// 签名里把名字切出来：`public function integer wf_count ()` → 修饰段 + `wf_count ()`。
// 名字要能加粗、在手机上单独占一行；按标识符边界找最后一次出现，重载/同名返回类型都不会切错位置。
const reEscape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function splitSignature(signature, name) {
  if (!name) return { kind: '', gap: '', name: signature }
  const pattern = new RegExp(`(^|[^\\w$#-])${reEscape(name)}(?=\\s|$|\\()`, 'gi')
  let match, last = null
  while ((match = pattern.exec(signature))) last = match
  if (!last) return { kind: '', gap: '', name: signature }
  const at = last.index + last[1].length, head = signature.slice(0, at)
  // 修饰段与名字之间原来隔着什么就补什么：`event open` 是空格，`on sailjson.create` 是点号。
  return { kind: head.trimEnd(), gap: /\s$/.test(head) ? ' ' : '', name: signature.slice(at) }
}
/** 列表行：owner / 修饰 / 名字 / 行号各占一个 span，文字顺序不变，方便视觉上分层和手机上折行。 */
function ScriptRow({ item, pressed, onClick }) {
  const { kind, gap, name } = splitSignature(item.signature, item.name)
  return h('button', { type: 'button', className: 'world-srw-row is-script', 'aria-pressed': pressed,
    title: `${item.owner}.${item.name} — ${item.signature}`, onClick },
  h('span', { className: 'world-srw-owner' }, `${item.owner} · `),
  kind ? h('span', { className: 'world-srw-kind' }, kind) : null,
  gap || null,
  h('span', { className: 'world-srw-name' }, name),
  h('span', { className: 'world-srw-line' }, ` (L${item.line})`))
}
function controlRow(obj, pressed, onClick) {
  return h('button', { key: obj.id, type: 'button', className: 'world-srw-row is-control', 'aria-pressed': pressed, onClick },
    h('span', { className: 'world-srw-name' }, obj.name), h('span', { className: 'world-srw-kind' }, ` : ${obj.base}`))
}
function Rows({ items, render, state, view, current }) {
  const size = 100, count = Math.ceil(items.length / size)
  // 从画布选中的控件可能在第八页；进列表先翻到它那一页，而不是永远停在第 1 页。
  const [page, setPage] = React.useState(() => {
    const index = current ? items.indexOf(current) : -1
    return index >= 0 ? Math.min(Math.floor(index / size), count - 1) : Math.min(state.pages[view] || 0, count - 1)
  })
  const at = Math.min(page, count - 1), go = n => { state.pages[view] = n; setPage(n) }
  const list = React.useRef(null)
  // 选中行可能在本页下方：等 Frame 恢复完滚动位置（rAF）再把它带进视口。
  React.useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const view = list.current?.closest('[data-srw-view]'), node = list.current?.querySelector('[aria-pressed="true"]')
      if (!view || !node) return
      // 直接算目标容器的 scrollTop：scrollIntoView 会连外层一起滚，停在哪里取决于祖先布局。
      const top = node.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop
      const bottom = top + node.offsetHeight
      if (top < view.scrollTop + 2 || bottom > view.scrollTop + view.clientHeight - 2) view.scrollTop = Math.max(0, top - 32)
    })
    return () => cancelAnimationFrame(frame)
  }, [view, current, at])
  return h('div', { ref: list }, count > 1 && h('nav', null, h('button', { disabled: !at, onClick: () => go(at - 1) }, '上一页'), `${at + 1}/${count}`,
    h('button', { disabled: at === count - 1, onClick: () => go(at + 1) }, '下一页')), items.slice(at * size, (at + 1) * size).map(render))
}
function Frame({ view, state, children }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => { const p = state.positions[view]; if (p) { ref.current.scrollLeft = p[0]; ref.current.scrollTop = p[1] } }, [view, state])
  return h('div', { ref, 'data-srw-view': view, 'data-srw-declare': view === 'variables' ? state.declare : undefined, className: `world-srw-view is-${view}`, onScroll: e => {
    state.positions[view] = [e.currentTarget.scrollLeft, e.currentTarget.scrollTop]
  } }, children)
}
export function SrwDesigner(props) {
  const session = props.parent.srw, model = useModel(session)
  return session.isSrd ? h(SrdDesigner, { ...props, model }) : h(ObjectDesigner, { ...props, model })
}
function SrdDesigner({ parent, render, model }) {
  const state = parent.srw.state, [, redraw] = React.useReducer(n => n + 1, 0)
  const selected = model?.objects.get(state.object) || model?.root
  const revealRef = React.useRef(null)
  const select = obj => { state.object = obj.id; redraw() }
  // Only a user choice in Properties should scroll. Canvas clicks, file refreshes
  // and restoring a saved layout keep their scroll position.
  const selectFromPicker = obj => { select(obj); revealRef.current?.(obj) }
  const draw = view => {
    if (!model || !model.root) return note(model ? errorMessage('未找到 DataWindow 声明，可切换回源代码查看。') : '正在解析数据窗口…')
    return view === 'layout'
      ? h(SrdLayout, { model, selected, select, revealRef, overflow: state.overflow, onOverflow: value => { state.overflow = value; redraw() } })
      : h(SrdProperties, { model, selected, select: selectFromPicker, propList })
  }
  return render(id => { const view = id.slice(parent.id.length + 1); return h(Frame, { key: id, view, state }, draw(view)) }, () => null)
}
function ObjectDesigner({ parent, openView, render, onDirty, activeId, model, wrap, applicationFor }) {
  const session = parent.srw, state = session.state
  const indexFor = React.useMemo(() => model?.objects.size > 200 ? createSrwIndexLookup(canvasBounds) : null, [model])
  const [, redraw] = React.useReducer(n => n + 1, 0)
  const change = patch => { Object.assign(state, patch); redraw() }
  const obj = model?.objects.get(state.object) || model?.root
  const scriptOnly = !session.hasLayout
  const application = /\.sra$/i.test(session.path)
  const firstScript = o => (scriptOnly && !application && o.scripts.find(s => !isEvent(s))) || preferred(o)
  const current = obj && (obj.scripts.find(s => s.id === state.script) || firstScript(obj))
  const choose = (target, item = firstScript(target)) => change({ object: target.id, script: item?.id, selection: [target.id] })
  // Ctrl/Cmd 点击把控件加进选择集合；再点一次移出。主选中仍是最后点的那个。
  const toggle = target => {
    const list = state.selection?.length ? state.selection : [obj.id]
    const next = list.includes(target.id) ? list.filter(id => id !== target.id) : [...list, target.id]
    change({ object: target.id, script: preferred(target)?.id, selection: next.length ? next : [target.id] })
  }
  const goto = (target, item) => { choose(target, item); openView('script') }
  const draw = view => {
    if (!model || !obj) return note(!model ? '正在解析对象源码…' : errorMessage('未找到静态类型声明。可右键切换回源代码。'))
    switch (view) {
      case 'layout': {
        const script = target => goto(target, preferred(target))
        if (session.isSrm) return h(SrmLayout, { model, obj, select: choose, state, script })
        return h(Canvas, { model, indexFor, obj, select: choose, toggle, script, state,
          selection: state.selection || [], zoom: state.zoom || 1, onZoom: value => { saveSrwZoom(value); change({ zoom: value }) } })
      }
      case 'properties': return h(Properties, { obj, state, change, scriptOnly, application: application && obj === model.root })
      case 'controls': case 'nonvisual': {
        const items = [...model.objects.values()].filter(o => (!scriptOnly || o !== model.root) && Boolean(o.nonvisual) === (view === 'nonvisual'))
        return items.length
          ? h(Rows, { key: view, items, state, view, current: view === 'controls' ? obj : null,
            render: o => controlRow(o, obj === o, () => choose(o)) })
          : note(view === 'controls' ? '本文件未声明可视控件。' : '本文件未声明可识别的非可视对象。')
      }
      case 'events': case 'functions': {
        const items = model.scripts.filter(s => isEvent(s) === (view === 'events'))
        const hit = current && items.includes(current) ? current : null
        return items.length ? h(Rows, { key: view, items, state, view, current: hit,
          render: s => h(ScriptRow, { key: s.id, item: s, pressed: s === hit, onClick: () => goto(model.objects.get(s.owner), s) }) }) : note('本文件中没有相应的脚本实现。')
      }
      case 'variables': return h(Declares, { session, model, state, change, activeId, parentId: parent.id, onDirty, wrap, applicationFor })
      case 'script': return h(React.Fragment, null, scriptOnly ? h(ObjectScriptHeader, { obj, current, choose }) : h('nav', null,
        h(ScriptObjectSelect, { objects: model.objects, value: obj.id, onChange: e => choose(model.objects.get(e.target.value)) }),
        h(ScriptMemberSelect, { obj, current, choose })),
        current ? h(EditableRange, { key: current.id, range: current, session, wrap, active: activeId === `${parent.id}:script`, label: `编辑 ${obj.name}.${current.name}`, onDirty }) : note('此对象没有已实现的事件或函数。'))
    }
  }
  return render(id => { const view = id.slice(parent.id.length + 1); return h(Frame, { key: id, view, state }, draw(view)) },
    id => id === `${parent.id}:script` ? current?.name || 'Script' : null)
}
