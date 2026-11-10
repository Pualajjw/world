/**
 * 桌面壁纸：内置渐变预设与纯色。
 *
 * 普通桌面和 3D 桌面各有一份配置；`linked` 为 true 时 3D 跟随普通桌面。
 * 配置只存 localStorage，不涉及图片文件。
 */

export const WALLPAPER_STORAGE_KEY = 'dsh.world.wallpaper'

/** 预设只改色相，明暗仍由 --world-surface 系列变量决定，所以浅色/深色主题都成立。 */
export const WALLPAPER_PRESETS = [
  { id: 'aurora', label: '极光', tint: '#4cc2ff', swatch: 'linear-gradient(135deg, #7fd8ff, #1b5fa8)' },
  { id: 'ocean', label: '深海', tint: '#2f7dd1', swatch: 'linear-gradient(135deg, #6fb6ff, #123a68)' },
  { id: 'dusk', label: '暮色', tint: '#9b6bff', swatch: 'linear-gradient(135deg, #c0a8ff, #3b2a72)' },
  { id: 'forest', label: '森野', tint: '#3fae7a', swatch: 'linear-gradient(135deg, #8fe0b8, #14503a)' },
  { id: 'sand', label: '暖沙', tint: '#d9a45b', swatch: 'linear-gradient(135deg, #f3d09a, #7a5224)' },
  { id: 'rose', label: '晨曦', tint: '#e0709a', swatch: 'linear-gradient(135deg, #ffb2cb, #7a2748)' },
  { id: 'graphite', label: '石墨', tint: '#8b97a8', swatch: 'linear-gradient(135deg, #ccd4df, #3a4350)' },
  { id: 'solid', label: '纯色', tint: null, swatch: null },
]

const PRESET_IDS = new Set(WALLPAPER_PRESETS.map(preset => preset.id))
const DEFAULT_COLOR = '#eef3fc'
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu

export const DEFAULT_WALLPAPER = Object.freeze({
  linked: true,
  flat: Object.freeze({ preset: 'aurora', color: DEFAULT_COLOR, dim: 0, bloom: 1, grid: 1 }),
  depth: Object.freeze({ preset: 'aurora', color: DEFAULT_COLOR, dim: 0, bloom: 1, grid: 1 }),
})

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

/** 单份配置：非法字段逐项回退，坏数据不会把桌面刷黑。 */
function parseConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const color = String(config.color ?? '')
  return {
    preset: PRESET_IDS.has(config.preset) ? config.preset : 'aurora',
    color: COLOR_PATTERN.test(color) ? color.toLowerCase() : DEFAULT_COLOR,
    dim: clampNumber(config.dim, 0, .6, 0),
    bloom: clampNumber(config.bloom, 0, 1, 1),
    grid: clampNumber(config.grid, 0, 1, 1),
  }
}

const clone = value => JSON.parse(JSON.stringify(value))

/** 解析存储值或旧版本留下的残缺对象；跟随模式下 3D 直接复制普通桌面。 */
export function parseWallpaper(value) {
  const raw = typeof value === 'string' ? safeParse(value) : value
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const flat = parseConfig(source.flat)
  const linked = source.linked !== false
  return { linked, flat, depth: linked ? { ...flat } : parseConfig(source.depth) }
}

function safeParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

export function readWallpaper() {
  try { return parseWallpaper(window.localStorage.getItem(WALLPAPER_STORAGE_KEY)) }
  catch { return clone(DEFAULT_WALLPAPER) }
}

export function saveWallpaper(value) {
  try { window.localStorage.setItem(WALLPAPER_STORAGE_KEY, JSON.stringify(value)) } catch {}
}

/** 当前生效的配置：跟随时永远取普通桌面那份。 */
export function wallpaperFor(value, depth) {
  return value.linked || !depth ? value.flat : value.depth
}

/** 纯色壁纸需要知道底色明暗，才能把桌面图标文字换成深色或浅色。 */
export function wallpaperTone(config) {
  if (config.preset !== 'solid') return ''
  const channels = [1, 3, 5].map(index => Number.parseInt(config.color.slice(index, index + 2), 16) / 255)
  const linear = channels.map(value => (value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4))
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
  return luminance > .45 ? 'light' : 'dark'
}

/** 写进 `.world-wall` 的 CSS 变量；预设色相、纯色底色和各滑杆都在这里汇合。 */
export function wallpaperStyle(config) {
  const preset = WALLPAPER_PRESETS.find(item => item.id === config.preset)
  const style = {
    '--wall-dim': `${Math.round(config.dim * 100)}%`,
    '--wall-bloom': String(config.bloom),
    '--wall-grid': String(config.grid),
  }
  if (preset?.tint) style['--wall-tint'] = preset.tint
  if (config.preset === 'solid') style['--wall-solid'] = config.color
  return style
}
