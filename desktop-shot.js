/**
 * DOM → SVG foreignObject → canvas. The host exposes no window-capture API, so the
 * desktop page rasterizes its own DOM. Browser guests (webview) and embedded iframes
 * are replaced by placeholders: their content is never part of the snapshot.
 */
const MAX_SIDE = 8192

function stylesheetText() {
  let text = ''
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) text += `${rule.cssText}\n`
    } catch { /* cross-origin sheets are skipped */ }
  }
  return text
}

function customProperties() {
  const seen = new Map()
  for (const element of [document.documentElement, document.body]) {
    const style = getComputedStyle(element)
    for (const name of style) {
      if (name.startsWith('--') && !seen.has(name)) seen.set(name, style.getPropertyValue(name))
    }
  }
  return [...seen].map(([name, value]) => `${name}:${value}`).join(';')
}

function placeholderFor(original, text) {
  const rect = original.getBoundingClientRect()
  const node = document.createElement('div')
  node.setAttribute('style', [
    'position:fixed', `left:${rect.left}px`, `top:${rect.top}px`, `width:${rect.width}px`, `height:${rect.height}px`,
    'box-sizing:border-box', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#151b22', 'color:#8fa6bb', 'border:1px dashed #43566a',
    'font:12px/18px system-ui,sans-serif', 'z-index:2147483647', 'pointer-events:none',
  ].join(';'))
  node.textContent = text
  return node
}

/** Replace guest surfaces, mirror live input values, and drop active scripts/links. */
function sanitize(root) {
  const originals = [document.body, ...document.body.querySelectorAll('*')]
  const copies = [root, ...root.querySelectorAll('*')]
  const redacted = new Set()
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index], copy = copies[index]
    if (!copy) continue
    const tag = original.tagName
    if (tag === 'SCRIPT' || tag === 'LINK' || tag === 'META' || tag === 'BASE') { copy.remove(); continue }
    if (tag === 'TEXTAREA') { copy.textContent = original.value; continue }
    if (tag === 'INPUT') {
      copy.setAttribute('value', original.value ?? '')
      if (original.checked) copy.setAttribute('checked', '')
      continue
    }
    if (tag === 'SELECT') {
      for (const [i, option] of [...copy.querySelectorAll('option')].entries())
        if (original.options[i]?.selected) option.setAttribute('selected', '')
      continue
    }
    if (tag === 'CANVAS') {
      try {
        const image = document.createElement('img')
        image.setAttribute('src', original.toDataURL())
        image.setAttribute('style', copy.getAttribute('style') || '')
        copy.replaceWith(image)
      } catch { copy.replaceWith(placeholderFor(original, '画布内容无法截图')) }
      continue
    }
    if (tag === 'WEBVIEW') {
      copy.replaceWith(placeholderFor(original, '浏览器网页内容不纳入截图'))
      redacted.add('webview')
      continue
    }
    if (tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') {
      copy.replaceWith(placeholderFor(original, '内嵌页面内容不纳入截图'))
      redacted.add('iframe')
    }
  }
  return [...redacted]
}

function serializer() {
  try { return new XMLSerializer() } catch { return null }
}

function blobToImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('桌面截图渲染失败。'))
    image.src = url
  })
}

/** Capture the world desktop area (the native titlebar is cropped away). */
export async function captureDesktopScreenshot({ maxWidth = 0, format = 'png', quality = .9 } = {}) {
  const width = window.innerWidth || 1280
  const height = window.innerHeight || 800
  if (width > MAX_SIDE || height > MAX_SIDE) throw new Error('视口过大，无法生成桌面截图。')
  const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--world-desktop-top')) || 0
  const area = Math.max(1, Math.round(height - top))

  const root = document.body.cloneNode(true)
  for (const attribute of document.documentElement.attributes)
    if (attribute.name.startsWith('data-') && !root.hasAttribute(attribute.name)) root.setAttribute(attribute.name, attribute.value)
  const inline = root.getAttribute('style') || ''
  root.setAttribute('style', `${inline};margin:0;width:${width}px;height:${height}px;overflow:hidden;position:relative;${customProperties()}`)
  const redacted = sanitize(root)

  const css = stylesheetText()
  const style = document.createElement('style')
  style.textContent = css
  root.prepend(style)

  const xml = serializer()
  if (!xml) throw new Error('当前环境不支持桌面截图。')
  const bodyXml = xml.serializeToString(root)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<foreignObject x="0" y="0" width="${width}" height="${height}">${bodyXml}</foreignObject></svg>`
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const image = await blobToImage(url)

  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const fullContext = full.getContext('2d')
  fullContext.drawImage(image, 0, 0)

  const cropped = document.createElement('canvas')
  cropped.width = width
  cropped.height = area
  const context = cropped.getContext('2d')
  if (format === 'jpeg') { context.fillStyle = '#0b1420'; context.fillRect(0, 0, cropped.width, cropped.height) }
  context.drawImage(full, 0, -top)

  let output = cropped
  const scale = maxWidth > 0 ? Math.min(1, maxWidth / width) : 1
  if (scale < 1) {
    output = document.createElement('canvas')
    output.width = Math.max(1, Math.round(cropped.width * scale))
    output.height = Math.max(1, Math.round(cropped.height * scale))
    output.getContext('2d').drawImage(cropped, 0, 0, output.width, output.height)
  }
  const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  let dataUrl
  try { dataUrl = output.toDataURL(mediaType, quality) }
  catch (error) {
    const detail = `${error?.name || ''} ${error?.message || error}`
    throw new Error(/SecurityError|Tainted/iu.test(detail)
      ? '桌面截图失败：页面包含无法序列化的外部资源。'
      : `桌面截图失败：${String(error?.message || error)}`)
  }
  return { dataUrl, mediaType, width: output.width, height: output.height, scale,
    region: { x: 0, y: Math.round(top), width, height: area }, redacted, capturedAt: Date.now() }
}
