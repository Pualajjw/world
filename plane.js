/**
 * 3D 地面模型：桌面图标与卡通机器人共用这一块平面。
 *
 * 用一套简化的针孔相机代替逐点求交，但结论和透视一致：
 *
 *   horizon = 视口高度 × HORIZON_RATIO        地面网格往上淡出（地平线）
 *   near    = 视口高度 − 任务栏 − 缝隙         脚尖能踩到的最前面一行
 *   scale(y) = MIN_SCALE + (1 − MIN_SCALE) × (y − horizon) / (near − horizon)
 *
 * 地面上「横向离屏幕中心 u、深度落在屏幕 y」的点，投影到屏幕就是
 *
 *   x = 视口宽 / 2 + u × scale(y)
 *
 * 越远越小、越靠屏幕中心收敛——和侧面那面网格同一个方向。
 *
 * 因为鼠标指针本身就在屏幕上，它和地面的交点就是 (clientX, clientY)：
 * 角色只要把脚底走到这个点、再按 scale(y) 缩放，看上去就站在平面上；
 * 指针换了地方，交点就换，角色跟着重新走过去。
 */

const DEFAULT_TASKBAR = 48
const HORIZON_RATIO = .46     // 地平线在视口高度中的位置
const MIN_SCALE = .34         // 贴地平线（最远）处的大小
const EDGE_GAP = 6            // 地面前沿与任务栏之间的缝

/** 任务栏高度以 CSS 变量为准，取不到就按 48px 兜底。 */
export function readTaskbarHeight() {
  if (typeof window === 'undefined' || !window.document) return DEFAULT_TASKBAR
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--world-taskbar-height')
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TASKBAR
}

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * 建一块地面。
 * @param {number} width  视口宽
 * @param {number} height 视口高
 * @param {number} [taskbar] 任务栏高度，默认读 CSS 变量
 */
export function groundOf(width, height, taskbar = readTaskbarHeight()) {
  const w = width || 1280
  const hgt = height || 800
  const horizon = hgt * HORIZON_RATIO
  const near = Math.max(horizon + 96, hgt - taskbar - EDGE_GAP)
  const span = near - horizon

  const scaleAt = y => MIN_SCALE + (1 - MIN_SCALE) * clamp01((y - horizon) / span)
  const yAt = scale => horizon + span * clamp01((scale - MIN_SCALE) / (1 - MIN_SCALE))
  // 地平线下方的可用深度范围：交给调用方做 clamp
  const clampY = y => (y < horizon ? horizon : y > near ? near : y)

  return { width: w, height: hgt, horizon, near, scaleAt, yAt, clampY }
}

// ── 桌面图标在地面上的摆位 ────────────────────────────────────────────────
export const ICON_SIZE = 96           // 基准边长，与 styles.css 的 --world-icon-size 一致
const ICON_GAP = 4                    // 图标之间的呼吸
const ICON_ROWS = [.95, .78, .64]     // 每一行的缩放：底行最近最大，往上越小
const ICON_MARGIN = 12                // 第一列左边缘距屏幕左边
const ICON_CONVERGE = .5              // 0 = 不向消失点收敛，1 = 完全按透视收敛
// 名字是反向放大回 12px 的，不跟着行缩小，所以列距有下限。
const ICON_PITCH_MIN = 104
// 名字在缩放后仍占约 30px 高，盒子底部会被撑出一点：行距得把它算进去。
const LABEL_ROOM = 30
const ROW_GAP = 6
// 最近一行不贴着任务栏停，留出一点桌面边缘的呼吸。
const FLOOR_GAP = 14
const SIZE_STEPS = [96, 84, 72]

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))

// 名字在盒子里从 62px 处开始，反向放大后底边落在 62 × scale + LABEL_ROOM 上；
// 图标盒底是 96 × scale，两者之差就是溢出量。
const LABEL_ANCHOR = 62 / ICON_SIZE
const labelOverflow = scale => Math.max(0, LABEL_ROOM - (ICON_SIZE - 62) * scale)

/** 这一行实际要占的垂直空间：图标视觉高度 + 名字溢出 + 行间呼吸。 */
export function rowHeight(scale) {
  return ICON_SIZE * scale + labelOverflow(scale) + ROW_GAP
}

/**
 * 平面模式：左侧常规网格。列数先按容器宽度封顶，装不下就整体降一档图标尺寸，
 * 直到装得下为止——不然超出的那一列会被夹到右边界，直接压在邻列上。
 */
export function planFlatGrid(count, width, height) {
  const total = Math.max(1, count)
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  let fallback = null
  for (const size of SIZE_STEPS) {
    const gap = size >= 72 ? ICON_GAP : 2
    const cols = Math.max(1, Math.floor((w + gap) / (size + gap)))
    const rows = Math.max(1, Math.floor((h + gap) / (size + gap)))
    const plan = { size, gap, cols, rows, capacity: cols * rows }
    fallback = plan
    if (plan.capacity >= total) return plan
  }
  return fallback
}

/**
 * 3D 模式：从最近一行往上堆，每行的间距按它自己的视觉高度给足，
 * 所以行数会随可用空间自动减少（3 → 2 → 1），而不是硬摆三行压在一起。
 * 连一行都摆不下、或列数放不下时返回 null，交给平面网格兜底。
 */
export function planDepthGrid(count, width, height, taskbar) {
  const total = Math.max(1, count)
  const ground = groundOf(width, height, taskbar)
  const availW = Math.max(1, width - ICON_MARGIN * 2)
  const availH = ground.near - FLOOR_GAP - ground.horizon

  for (let rows = Math.min(ICON_ROWS.length, total); rows >= 1; rows--) {
    // 只允许在 10% 以内微调缩放：再往下缩，图标就只剩小蝌蚪了。
    // 缩不下就少排一行——两行大图标比三行小图标好读得多。
    for (let k = 1; k >= .9 - 1e-9; k -= .02) {
      const scales = ICON_ROWS.slice(0, rows).map(scale => scale * k)
      const needH = scales.reduce((sum, scale) => sum + rowHeight(scale), 0)
      if (needH > availH) continue
      const pitch = Math.max(ICON_SIZE * scales[0] + ICON_GAP * 2, ICON_PITCH_MIN)
      const cols = Math.max(1, Math.floor(availW / pitch))
      if (rows * cols >= total) return { ground, rows, cols, scales, pitch }
    }
  }
  return null
}

/**
 * 把图标摆到地面上。depth 关掉时退回左侧常规网格（同样是绝对定位，方便拖动记住位置）。
 * 图标本身仍是平面（不透视、不挤厚度），只是站在平面上并按深度缩放。
 * positions 是用户拖过的位置：平铺模式存容器内 left/top，3D 存脚底视口坐标。
 * options.resolveCollisions：重排时让开被别的图标占住的格子（窗口缩小后才需要）。
 */
export function layoutDeskIcons(container, depth, positions = {}, options = {}) {
  if (!container) return
  const icons = [...container.children].filter(node => node.classList?.contains('world-desktop-icon'))
  if (!icons.length) return

  const width = container.clientWidth || 0
  const height = container.clientHeight || 0

  // 3D 想摆在地面上，但窗口缩到摆不下时退回平面网格——宁可平一点，也不能让图标叠成一堆。
  const plan = depth
    ? planDepthGrid(icons.length, window.innerWidth || 1280, window.innerHeight || 800)
    : null
  if (!plan) return layoutFlatIcons(container, icons, positions, width, height, options)
  return layoutGroundIcons(container, icons, positions, plan, options)
}

/**
 * 保存位置时记下了当时的视口尺寸；换了尺寸就按比例搬，
 * 否则拖到右下角的图标在窗口缩小后仍停在原像素坐标上，直接压住网格里的图标。
 */
export function rescaleSaved(saved, width, height) {
  if (!saved) return null
  const vw = Number(saved.vw), vh = Number(saved.vh)
  const ratioX = Number.isFinite(vw) && vw > 0 ? width / vw : 1
  const ratioY = Number.isFinite(vh) && vh > 0 ? height / vh : 1
  return { x: saved.x * ratioX, y: saved.y * ratioY }
}

const overlapsBy = (a, b, slack = 2) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > slack &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > slack

/** 摆完之后，把压在别人身上的自定义位置让回网格——窗口小了装不下用户原来挑的地方。 */
function yieldCollisions(slots) {
  if (slots.length < 2) return
  // 容器还没量出尺寸时（首帧、面板隐藏）所有 rect 都是 0，这时候做碰撞判断会误伤位置记忆。
  const probe = slots[0].icon.getBoundingClientRect()
  if (probe.width < 8 || probe.height < 8) return
  const taken = slots.filter(slot => !slot.saved).map(slot => slot.icon.getBoundingClientRect())
  for (const slot of slots) {
    if (!slot.saved) continue
    const rect = slot.icon.getBoundingClientRect()
    if (taken.some(other => overlapsBy(rect, other))) {
      slot.applyGrid()
      taken.push(slot.icon.getBoundingClientRect())
    } else {
      taken.push(rect)
    }
  }
}

function layoutFlatIcons(container, icons, positions, width, height, options = {}) {
  container.classList.remove('is-plane')
  const plan = planFlatGrid(icons.length, width, height)
  container.classList.toggle('is-compact', plan.size < ICON_SIZE)
  container.style.setProperty('--world-icon-size', `${plan.size}px`)
  container.style.setProperty('--world-icon-font', plan.size >= 72 ? '12px' : '11px')
  const step = plan.size + plan.gap
  const slots = icons.map((icon, index) => {
    const column = Math.floor(index / plan.rows), row = index % plan.rows
    const saved = rescaleSaved(positions[icon.dataset.worldIconId], width, height)
    // 先按网格占位，再放用户拖过的位置；网格本身保证列数不超宽。
    const grid = () => {
      icon.style.position = 'absolute'
      icon.style.left = `${clamp(column * step, 0, Math.max(0, width - plan.size)).toFixed(1)}px`
      icon.style.top = `${clamp(row * step, 0, Math.max(0, height - plan.size)).toFixed(1)}px`
      icon.style.transform = ''
      icon.style.zIndex = ''
      icon.style.setProperty('--label-scale', '1')
    }
    const applyGrid = () => grid()
    if (saved) {
      icon.style.position = 'absolute'
      icon.style.left = `${clamp(saved.x, 0, Math.max(0, width - plan.size)).toFixed(1)}px`
      icon.style.top = `${clamp(saved.y, 0, Math.max(0, height - plan.size)).toFixed(1)}px`
      icon.style.transform = ''
      icon.style.zIndex = ''
      icon.style.setProperty('--label-scale', '1')
    } else {
      grid()
    }
    return { icon, saved, applyGrid }
  })
  if (options.resolveCollisions) yieldCollisions(slots)
}

function layoutGroundIcons(container, icons, positions, plan, options = {}) {
  container.classList.add('is-plane')
  container.classList.remove('is-compact')
  container.style.setProperty('--world-icon-size', `${ICON_SIZE}px`)
  container.style.setProperty('--world-icon-font', '12px')
  const { ground, rows, scales, pitch } = plan
  const origin = container.getBoundingClientRect()
  const centerX = ground.width / 2
  const baseHalf = ICON_SIZE * scales[0] / 2

  const slots = icons.map((icon, index) => {
    const saved = rescaleSaved(positions[icon.dataset.worldIconId], ground.width, ground.height)
    const row = index % rows
    const column = Math.floor(index / rows)
    const scale = scales[row] ?? scales[scales.length - 1]
    // 每行从最近一行往上堆，间距按该行视觉高度给足，所以任意两行都不会压住。
    let y = ground.near - FLOOR_GAP
    for (let line = 0; line < row; line++) y -= rowHeight(scales[line] ?? scale)
    // 越远越向屏幕中心收敛；ICON_CONVERGE 用来收敛得温和一些，图标仍留在左边
    const u = ICON_MARGIN + baseHalf + column * pitch - centerX
    const x = centerX + u * (1 - (1 - scale) * ICON_CONVERGE)

    const paint = (left, foot, liveScale) => {
      icon.style.position = 'absolute'
      icon.style.left = `${(left - ICON_SIZE / 2 - origin.left).toFixed(1)}px`
      icon.style.top = `${(foot - ICON_SIZE - origin.top).toFixed(1)}px`
      icon.style.transform = `scale(${liveScale.toFixed(3)})`
      // 图标随深度变小是景深的一部分，但名字不能跟着缩到读不出来：
      // 把整块的反向系数交给 CSS，只让标签按比例长回去（渲染后大约仍是 12px）。
      icon.style.setProperty('--label-scale', Math.min(1 / liveScale, 1.7).toFixed(3))
      // 近的压远的（同一行由 DOM 顺序决定）
      icon.style.zIndex = String(Math.round(foot))
    }
    const applyGrid = () => paint(x, y, scale)
    if (saved) {
      // 拖过的图标保持用户放的位置；只重新夹回地面范围内。
      const sx = clamp(saved.x, baseHalf, ground.width - baseHalf)
      const sy = ground.clampY(saved.y)
      paint(sx, sy, ground.scaleAt(sy))
    } else {
      applyGrid()
    }
    return { icon, saved, applyGrid }
  })
  if (options.resolveCollisions) yieldCollisions(slots)
}
