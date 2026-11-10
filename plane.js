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
const ICON_SIZE = 96          // 与 styles.css 的 .world-desktop-icon 一致
const ICON_GAP = 4            // 与 .world-icons 的 gap 一致
const ICON_ROWS = [.95, .78, .64]  // 每一行的缩放：底行最近最大，往上越小
const ICON_PITCH = 118        // 最近一行的列距
const ICON_MARGIN = 12        // 最近一行左边缘距屏幕左边
const ICON_CONVERGE = .5      // 0 = 不向消失点收敛，1 = 完全按透视收敛

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))

/**
 * 把图标摆到地面上。depth 关掉时退回左侧常规网格（同样是绝对定位，方便拖动记住位置）。
 * 图标本身仍是平面（不透视、不挤出厚度），只是站在平面上并按深度缩放。
 * positions 是用户拖过的位置：平铺模式存容器内 left/top，3D 存脚底视口坐标。
 */
export function layoutDeskIcons(container, depth, positions = {}) {
  if (!container) return
  const icons = [...container.children].filter(node => node.classList?.contains('world-desktop-icon'))
  if (!depth) {
    container.classList.remove('is-plane')
    const width = container.clientWidth || 0
    const height = container.clientHeight || 0
    const rows = Math.max(1, Math.floor((height + ICON_GAP) / (ICON_SIZE + ICON_GAP)))
    icons.forEach((icon, index) => {
      const saved = positions[icon.dataset.worldIconId]
      const column = Math.floor(index / rows), row = index % rows
      const x = clamp(saved ? saved.x : column * (ICON_SIZE + ICON_GAP), 0, width - ICON_SIZE)
      const y = clamp(saved ? saved.y : row * (ICON_SIZE + ICON_GAP), 0, height - ICON_SIZE)
      icon.style.position = 'absolute'
      icon.style.left = `${x.toFixed(1)}px`
      icon.style.top = `${y.toFixed(1)}px`
      icon.style.transform = ''
      icon.style.zIndex = ''
    })
    return
  }

  container.classList.add('is-plane')
  const width = window.innerWidth || 1280
  const height = window.innerHeight || 800
  const ground = groundOf(width, height)
  const origin = container.getBoundingClientRect()
  const centerX = width / 2

  icons.forEach((icon, index) => {
    const saved = positions[icon.dataset.worldIconId]
    const scale = saved ? ground.scaleAt(ground.clampY(saved.y)) : ICON_ROWS[index % ICON_ROWS.length]
    const y = saved ? ground.clampY(saved.y) : ground.yAt(scale)
    // 越远越向屏幕中心收敛；ICON_CONVERGE 用来收敛得温和一些，图标仍留在左边
    const u = ICON_MARGIN + ICON_SIZE / 2 + Math.floor(index / ICON_ROWS.length) * ICON_PITCH - centerX
    const x = saved ? clamp(saved.x, ICON_SIZE / 2 * scale, width - ICON_SIZE / 2 * scale)
      : centerX + u * (1 - (1 - scale) * ICON_CONVERGE)

    icon.style.position = 'absolute'
    icon.style.left = `${(x - ICON_SIZE / 2 - origin.left).toFixed(1)}px`
    icon.style.top = `${(y - ICON_SIZE - origin.top).toFixed(1)}px`
    icon.style.transform = `scale(${scale.toFixed(3)})`
    // 近的压远的（同一行由 DOM 顺序决定）
    icon.style.zIndex = String(Math.round(y))
  })
}
