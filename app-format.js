/**
 * .worldapp 应用包的纯数据层：格式常量、校验、本地注册表与窗口几何。
 * 不依赖 React / DOM 模块之外的运行时，方便单独测试；组件在 external-apps.js。
 */
import { fitSavedDesktopRect } from './responsive.js'

export const APP_FORMAT = 'dsh-world-app/1'
export const APP_FILE_PATTERN = /\.worldapp$/i
export const RESERVED_IDS = ['dsh', 'vscode', 'lanchat', 'browser']
export const MAX_APP_FILE = 64 * 1024

const APPS_KEY = 'dsh.world.external-apps'
const RECT_PREFIX = 'dsh.world.external.'

function clean(value, max) { return String(value == null ? '' : value).trim().slice(0, max) }

function desktopTop() {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
}

/** 解析并校验应用包；只读数据，不执行任何包内逻辑。 */
export function parseWorldApp(text, size = 0) {
  if (size > MAX_APP_FILE) return { ok: false, error: '应用包超过 64 KB' }
  let data
  try { data = JSON.parse(text) } catch { return { ok: false, error: '不是有效的 JSON 文件' } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '应用包内容必须是对象' }
  if (data.format !== APP_FORMAT) return { ok: false, error: `format 必须是 ${APP_FORMAT}` }

  const id = clean(data.id, 40).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(id)) return { ok: false, error: 'id 不合法（小写字母/数字/.-_，2~32 位）' }
  if (RESERVED_IDS.includes(id)) return { ok: false, error: `id「${id}」是内置应用，不能覆盖` }
  const name = clean(data.name, 24)
  if (!name) return { ok: false, error: '缺少应用名称' }

  let url
  try { url = new URL(clean(data.url, 500)) } catch { return { ok: false, error: 'url 不是合法地址' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'url 只支持 http / https' }

  const color = clean(data.color, 7)
  const width = Number(data.size?.w)
  const height = Number(data.size?.h)
  return {
    ok: true,
    app: {
      format: APP_FORMAT,
      id, name,
      description: clean(data.description, 60),
      icon: clean(data.icon, 8) || '🧩',
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4c86ff',
      url: url.href,
      size: {
        w: Number.isFinite(width) ? Math.min(100, Math.max(30, width)) : 80,
        h: Number.isFinite(height) ? Math.min(100, Math.max(30, height)) : 80,
      },
    },
  }
}

export function readExternalApps() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(APPS_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    const apps = []
    for (const item of raw) {
      const parsed = parseWorldApp(JSON.stringify(item))
      if (parsed.ok) apps.push(parsed.app)
    }
    return apps
  } catch { return [] }
}

export function saveExternalApps(apps) {
  try { window.localStorage.setItem(APPS_KEY, JSON.stringify(apps)) } catch {}
}

export function clampAppRect(rect) {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const top = desktopTop()
  const minW = Math.min(width, 720) / width * 100
  const minH = Math.min(Math.max(0, height - top - 48), 480) / height * 100
  const w = Math.min(100, Math.max(minW, Number(rect?.w) || minW))
  const h = Math.min(Math.max(0, (height - top - 48) / height * 100), Math.max(minH, Number(rect?.h) || minH))
  const x = Math.min(100 - w, Math.max(0, Number(rect?.x) || 0))
  const minY = top / height * 100
  const maxY = Math.max(minY, (height - 48 - height * h / 100) / height * 100)
  return { x, y: Math.min(maxY, Math.max(minY, Number(rect?.y) || minY)), w, h }
}

export function defaultAppRect(index = 0, size) {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  const top = desktopTop()
  const available = Math.max(0, height - top - 48)
  const windowWidth = Math.min(width, Math.max(Math.min(720, width), width * (size?.w || 80) / 100))
  const windowHeight = Math.min(available, Math.max(Math.min(480, available), height * (size?.h || 80) / 100))
  const offset = (index % 5) * 2.2
  return clampAppRect({
    x: (Math.max(0, (width - windowWidth) / 2) + offset * width / 100) / width * 100,
    y: (top + Math.max(0, (available - windowHeight) / 2) + offset * height / 100) / height * 100,
    w: windowWidth / width * 100,
    h: windowHeight / height * 100,
  })
}

export function readExternalRect(id, index = 0, size) {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECT_PREFIX + id + '.window') || 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return fitSavedDesktopRect(value, clampAppRect)
  } catch {}
  return defaultAppRect(index, size)
}

export function saveExternalRect(id, rect) {
  try { window.localStorage.setItem(RECT_PREFIX + id + '.window', JSON.stringify(rect)) } catch {}
}

export function removeExternalRect(id) {
  try { window.localStorage.removeItem(RECT_PREFIX + id + '.window') } catch {}
}
