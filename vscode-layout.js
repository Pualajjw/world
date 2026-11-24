/**
 * Binary editor layout.
 *
 * 叶节点是「编辑器组」：一个组里可以挂多个标签，只有 `active` 那个显示内容。
 * 分割节点带 `ratio`（第一个子节点的份额），拖动分隔条时改它。
 */

const ratioOf = layout => {
  const value = Number(layout?.ratio)
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export const isGroup = node => Boolean(node) && node.group !== undefined

/** 新建一个组（`active` 缺省取第一个标签）。 */
export function makeGroup(group, tabs, active) {
  const list = Array.isArray(tabs) ? tabs : [tabs]
  return { group, tabs: list, active: active && list.includes(active) ? active : list[0] }
}

function walkGroups(layout, result = []) {
  if (!layout) return result
  if (isGroup(layout)) { result.push(layout); return result }
  walkGroups(layout.children[0], result)
  walkGroups(layout.children[1], result)
  return result
}

/** 组的 id 列表（树序）。 */
export function paneIds(layout) {
  return walkGroups(layout).map(node => node.group)
}

export function groupsOf(layout) {
  return walkGroups(layout).map(node => ({ gid: node.group, tabs: node.tabs, active: node.active }))
}

/** 真正在显示内容的标签 = 各组的 active。 */
export function visibleTabs(layout) {
  return walkGroups(layout).map(node => node.active)
}

/** 某个标签所在的组；不在任何组里返回 null。 */
export function tabGroupOf(layout, tabId) {
  const hit = walkGroups(layout).find(node => node.tabs.includes(tabId))
  return hit ? hit.group : null
}

export function groupById(layout, gid) {
  return walkGroups(layout).find(node => node.group === gid) || null
}

export function paneBounds(layout, rect = { x: 0, y: 0, w: 100, h: 100 }, result = new Map()) {
  if (!layout) return result
  if (isGroup(layout)) { result.set(layout.group, rect); return result }
  const horizontal = layout.axis === 'row'
  const ratio = ratioOf(layout)
  const first = horizontal ? { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h } : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio }
  const second = horizontal
    ? { x: rect.x + first.w, y: rect.y, w: rect.w - first.w, h: rect.h }
    : { x: rect.x, y: rect.y + first.h, w: rect.w, h: rect.h - first.h }
  paneBounds(layout.children[0], first, result)
  paneBounds(layout.children[1], second, result)
  return result
}

/** 每个内部节点加上它的矩形，分隔条照着它画。 */
export function splitBounds(layout, rect = { x: 0, y: 0, w: 100, h: 100 }, path = [], result = []) {
  if (!layout || isGroup(layout)) return result
  const horizontal = layout.axis === 'row'
  const ratio = ratioOf(layout)
  result.push({ path, axis: layout.axis, rect, ratio })
  const first = horizontal ? { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h } : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio }
  const second = horizontal
    ? { x: rect.x + first.w, y: rect.y, w: rect.w - first.w, h: rect.h }
    : { x: rect.x, y: rect.y + first.h, w: rect.w, h: rect.h - first.h }
  splitBounds(layout.children[0], first, [...path, 0], result)
  splitBounds(layout.children[1], second, [...path, 1], result)
  return result
}

/** 不可变地改某一层的比例；`path` 来自 `splitBounds`。 */
export function setPaneRatio(layout, path, ratio) {
  if (!layout || isGroup(layout)) return layout
  const value = Math.min(0.95, Math.max(0.05, ratio))
  if (!path || !path.length) return { ...layout, ratio: value }
  const [head, ...rest] = path
  return { ...layout, children: layout.children.map((child, index) => index === head ? setPaneRatio(child, rest, value) : child) }
}

/** 两边都要能读：不小于 `minPx`，小边不低于 10%。 */
export function paneRatioLimit(sizePx, minPx = 180) {
  if (!Number.isFinite(sizePx) || sizePx <= 0) return 0.5
  return Math.min(0.45, Math.max(0.1, minPx / sizePx))
}

/** 把某个组从树里摘掉；组没了之后父节点塌缩成另一个孩子。 */
export function removeGroup(layout, gid) {
  if (!layout) return null
  if (isGroup(layout)) return layout.group === gid ? null : layout
  const children = layout.children.map(child => removeGroup(child, gid)).filter(Boolean)
  return children.length === 2 ? { ...layout, children } : children[0] || null
}

/** 关掉一个标签：从它的组里移除；组空了就连组一起塌缩。 */
export function removeTab(layout, tabId) {
  if (!layout) return null
  if (isGroup(layout)) {
    if (!layout.tabs.includes(tabId)) return layout
    const tabs = layout.tabs.filter(id => id !== tabId)
    if (!tabs.length) return null
    const index = layout.tabs.indexOf(tabId)
    const active = layout.active === tabId ? tabs[Math.min(index, tabs.length - 1)] : layout.active
    return { ...layout, tabs, active }
  }
  const children = layout.children.map(child => removeTab(child, tabId)).filter(Boolean)
  return children.length === 2 ? { ...layout, children } : children[0] || null
}

/** 往组里加标签（默认追加到末尾并激活）。 */
export function addTab(layout, gid, tabId, { activate = true, index } = {}) {
  if (!layout) return layout
  if (isGroup(layout)) {
    if (layout.group !== gid) return layout
    if (layout.tabs.includes(tabId)) return { ...layout, active: activate ? tabId : layout.active }
    const tabs = [...layout.tabs]
    tabs.splice(index === undefined ? tabs.length : Math.max(0, Math.min(tabs.length, index)), 0, tabId)
    return { ...layout, tabs, active: activate ? tabId : layout.active }
  }
  return { ...layout, children: layout.children.map(child => addTab(child, gid, tabId, { activate, index })) }
}

/** 组内切到某个标签；不在这个组里就原样返回。 */
export function setGroupActive(layout, gid, tabId) {
  if (!layout) return layout
  if (isGroup(layout)) return layout.group === gid && layout.tabs.includes(tabId) ? { ...layout, active: tabId } : layout
  return { ...layout, children: layout.children.map(child => setGroupActive(child, gid, tabId)) }
}

function setGroupTabs(layout, gid, tabs, active) {
  if (!layout) return layout
  if (isGroup(layout)) return layout.group === gid ? { ...layout, tabs, active } : layout
  return { ...layout, children: layout.children.map(child => setGroupTabs(child, gid, tabs, active)) }
}

/**
 * 把标签挪到目标组（跨组拖动 / 组内排序）。
 * 源组被搬空时整组塌缩；目标组接收并激活它。
 */
export function moveTabToGroup(layout, tabId, targetGid, index) {
  const source = tabGroupOf(layout, tabId)
  if (!source) return layout
  if (source === targetGid) {
    const node = groupById(layout, targetGid)
    if (!node) return layout
    const tabs = node.tabs.filter(id => id !== tabId)
    const at = index === undefined ? tabs.length : Math.max(0, Math.min(tabs.length, index))
    tabs.splice(at, 0, tabId)
    return setGroupTabs(layout, targetGid, tabs, tabId)
  }
  const pruned = removeTab(layout, tabId)
  if (!pruned) return layout
  if (!groupById(pruned, targetGid)) return addTab(pruned, paneIds(pruned)[0], tabId)
  return addTab(pruned, targetGid, tabId, { index })
}

/** 拖到某一格的边缘：在那一格旁边新开一个组放这个标签。 */
export function splitWithTab(layout, targetGid, tabId, edge, newGid) {
  // 先把它从原组摘下来：摘完源组没了（原本就只有这一个标签），说明整组都搬到这边了
  const pruned = removeTab(layout, tabId)
  const fresh = makeGroup(newGid, [tabId])
  const target = pruned ? groupById(pruned, targetGid) : null
  if (!target) {
    // 拖的是某一格唯一的标签、目标又是那一格自己：没有可分的对象，什么都不做
    // （否则整格被搬进新组，旁边那些组一起消失）
    if (layout && tabGroupOf(layout, tabId) === targetGid) return layout
    return fresh
  }
  const axis = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const children = edge === 'left' || edge === 'top' ? [fresh, target] : [target, fresh]
  return replaceGroup(pruned, targetGid, { axis, children })
}

/** 用新节点替换某个组。 */
export function replaceGroup(layout, gid, next) {
  if (!layout) return next
  if (isGroup(layout)) return layout.group === gid ? next : layout
  return { ...layout, children: layout.children.map(child => replaceGroup(child, gid, next)) }
}

/** 最近的归一化边缘：宽格竖格都能用同一个手势。 */
export function closestPaneEdge(rect, x, y) {
  const edges = { left: (x - rect.left) / rect.width, right: (rect.right - x) / rect.width,
    top: (y - rect.top) / rect.height, bottom: (rect.bottom - y) / rect.height }
  return Object.keys(edges).reduce((best, edge) => edges[edge] < edges[best] ? edge : best, 'left')
}
