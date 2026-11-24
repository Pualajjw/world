/**
 * 手机视口（360×700）下的列表自检 + 出图：
 *  - Event List / Function List 折成两段（名字独占一行、来源与行号在下一行），行高够拇指点
 *  - Control List 单行行高一致
 *  - 设计组标签：只有当前标签显示关闭键，且文字不被关闭键压住
 * 图落到 tmp/ui-phone/，失败时 exitCode=1。
 */
import { card } from './srw-fixture.js'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let build
try { ({ build } = await import('esbuild')) } catch {
  ({ build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js'))))
}
const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) { console.log('no browser'); process.exit(0) }

const bundle = await build({
  absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife', platform: 'browser',
  target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')],
  loader: { '.css': 'text' }, legalComments: 'none',
})
const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:0px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%}#host-ui{position:absolute;inset:0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
const shots = join(root, 'tmp/ui-phone')
mkdirSync(shots, { recursive: true })

// WCAG 相对亮度对比度，够判断「名字读得清 / 次要信息还在」就行。
// color-mix() 的计算值会写成 color(srgb 0.9 0.9 0.9)，分量是 0~1，不能当 0~255 用。
const rgb = text => {
  const nums = (text.match(/[\d.]+/g) || []).map(Number)
  const scale = /^color\(/i.test(text) ? 255 : 1
  return nums.slice(0, 3).map(v => Math.min(255, v * scale))
}
const lum = text => rgb(text).map(v => { const c = v / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 })
  .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
const contrast = (fg, bg) => { const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return Math.round(((a + .05) / (b + .05)) * 100) / 100 }
// 次要信息是用 opacity 压的：对比度要把透明度混进背景色再算，否则量出来总是和正文一样
const fade = (fg, bg, alpha) => {
  const f = rgb(fg), b = rgb(bg)
  return `rgb(${f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha))).join(',')})`
}
const failures = []
const ROLE_MIN = 4.5, META_MIN = 3, ROW_MIN = 44

const width = Number(process.env.WORLD_PHONE_WIDTH || 360)
const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(html)
  await page.evaluate(source => {
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source,version:'t',eol:'LF',encoding:'UTF-8'}})
    window.__worldWorkspaceList = async ({path}) => ({ok:true,value:{path,parent:'',entries:['w_dk.srw'].map(name=>({name,type:'file'}))}})
  }, card)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
  await page.getByRole('button', { name: '全部应用', exact: true }).tap()
  const vscodeCard = page.locator('[data-world-app-card="vscode"]')
  if (await vscodeCard.locator('.world-app-install').count()) await vscodeCard.locator('.world-app-install').tap()
  await page.waitForTimeout(200)
  await vscodeCard.locator('.world-app-open').tap()
  const editor = page.locator('[data-world-vscode-key]')
  await editor.waitFor()
  // 手机上侧栏是抽屉：先点视图菜单，再选资源管理器
  await editor.getByRole('button', { name: '视图菜单', exact: true }).tap()
  await editor.locator('.world-vscode-phone-row').filter({ hasText: '资源管理器' }).tap()
  await editor.locator('.world-vscode-sidebar').waitFor()
  await editor.getByRole('button', { name: 'w_dk.srw', exact: true }).dblclick()
  const panes = editor.locator('.world-srw-panes')
  await panes.waitFor()
  await page.waitForTimeout(400)

  const views = { 'Event List': 'events', 'Function List': 'functions', 'Control List': 'controls' }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.body.dataset.worldTheme = t; document.body.dataset.worldWallTone = t }, theme)
    await page.waitForTimeout(150)
    for (const [label, key] of Object.entries(views)) {
      const tab = panes.locator('.world-vscode-tab').filter({ hasText: label }).first()
      if (!(await tab.count())) { failures.push(`${theme} 缺少「${label}」标签`); continue }
      await tab.tap()
      await page.waitForTimeout(200)
      const box = await panes.boundingBox()
      if (box) await page.screenshot({ path: join(shots, `phone-${theme}-${label.replace(/ /g, '-')}.png`), clip: box })
      const view = panes.locator(`[data-srw-view="${key}"]:visible`).first()
      if (!(await view.count())) { failures.push(`${theme} ${label} 视图没出现`); continue }
      const m = await view.evaluate(node => {
        const cs = n => getComputedStyle(n), rect = n => n.getBoundingClientRect()
        // 视图本身常常是透明底，选中行还是 9% 半透明强调色：只有 alpha=1 的祖先才是文字真正的背景
        const alphaOf = s => {
          if (s.startsWith('rgba')) return Number(s.split(',')[3])
          const slash = s.match(/\/\s*([\d.]+)\s*\)$/)
          return slash ? Number(slash[1]) : 1
        }
        const solid = n => { for (let cur = n; cur; cur = cur.parentElement) { const c = cs(cur).backgroundColor; if (c && alphaOf(c) === 1) return c } return 'rgb(255, 255, 255)' }
        const rows = [...node.querySelectorAll('.world-srw-row')]
        const base = rect(node)
        if (!rows.length) return { rows: 0 }
        const [first, second] = rows
        const name = first.querySelector('.world-srw-name'), owner = first.querySelector('.world-srw-owner'), line = first.querySelector('.world-srw-line')
        if (!name) return { rows: rows.length, broken: first.textContent }
        return {
          rows: rows.length,
          h: Math.round(rect(first).height), w: Math.round(rect(first).width),
          gap: second ? Math.round(rect(second).top - rect(first).bottom) : null,
          padLeft: cs(first).paddingLeft, radius: cs(first).borderTopLeftRadius,
          nameSize: parseFloat(cs(name).fontSize), nameWeight: Number(cs(name).fontWeight),
          nameTop: Math.round(rect(name).top - base.top), ownerTop: owner ? Math.round(rect(owner).top - base.top) : null,
          nameColor: cs(name).color, ownerColor: owner ? cs(owner).color : null, lineColor: line ? cs(line).color : null,
          ownerAlpha: owner ? Number(cs(owner).opacity) : 1, lineAlpha: line ? Number(cs(line).opacity) : 1,
          bg: solid(name),
          overflow: node.scrollWidth - node.clientWidth,
          text: first.textContent,
        }
      })
      if (!m.rows) { failures.push(`${theme} ${label} 没有列表行`); continue }
      if (m.broken) { failures.push(`${theme} ${label} 行里没有名字段：${m.broken}`); continue }
      if (m.h < ROW_MIN) failures.push(`${theme} ${label} 行高 ${m.h} < ${ROW_MIN}`)
      if (m.overflow > 1) failures.push(`${theme} ${label} 横向溢出 ${m.overflow}px`)
      if (key !== 'controls') {
        if (m.nameWeight < 600) failures.push(`${theme} ${label} 名字字重 ${m.nameWeight} < 600`)
        if (m.ownerTop == null || m.ownerTop <= m.nameTop + 6) failures.push(`${theme} ${label} 名字没有单独成行（名字 ${m.nameTop}px / 来源 ${m.ownerTop}px）`)
        if (m.nameSize < 14) failures.push(`${theme} ${label} 名字字号 ${m.nameSize} < 14`)
        if (contrast(m.nameColor, m.bg) < ROLE_MIN) failures.push(`${theme} ${label} 名字对比度 ${contrast(m.nameColor, m.bg)} < ${ROLE_MIN}`)
        const ownerContrast = contrast(fade(m.ownerColor, m.bg, m.ownerAlpha), m.bg)
        if (ownerContrast < META_MIN) failures.push(`${theme} ${label} 来源对比度 ${ownerContrast} < ${META_MIN}`)
        const lineContrast = m.lineColor ? contrast(fade(m.lineColor, m.bg, m.lineAlpha), m.bg) : null
        if (lineContrast != null && lineContrast < META_MIN) failures.push(`${theme} ${label} 行号对比度 ${lineContrast} < ${META_MIN}`)
      } else if (m.padLeft !== '10px') failures.push(`${theme} ${label} 行内边距 ${m.padLeft}`)
      console.log(`[${theme}] ${label} rows:${m.rows} ${m.w}×${m.h} gap:${m.gap} name:${m.nameSize}px/${m.nameWeight} `
        + `contrast name ${contrast(m.nameColor, m.bg)} owner ${m.ownerColor ? contrast(fade(m.ownerColor, m.bg, m.ownerAlpha), m.bg) : '-'}  « ${m.text}`)
    }
    // 标签条：非当前标签必须没有可见关闭键，当前标签的文字不能压到关闭键下面
    const strip = await panes.evaluate(el => {
      const bars = [...el.querySelectorAll('.world-vscode-tabs')]
      return bars.map(bar => [...bar.querySelectorAll('.world-vscode-tab')].map(tab => {
        const close = tab.querySelector('.world-vscode-tab-close'), name = tab.querySelector('.world-vscode-tab-name')
        const shown = close ? getComputedStyle(close).display !== 'none' : false
        return { active: tab.classList.contains('active'), shown, label: name?.textContent ?? '',
          labelRight: name ? name.getBoundingClientRect().right : null,
          closeLeft: shown ? close.getBoundingClientRect().left : null }
      }))
    })
    for (const bar of strip) {
      for (const tab of bar) {
        if (!tab.active && tab.shown) failures.push(`${theme} 标签「${tab.label}」不是当前标签却显示关闭键`)
        if (tab.active && !tab.shown) failures.push(`${theme} 当前标签「${tab.label}」没有关闭键`)
        if (tab.shown && tab.labelRight > tab.closeLeft - 1) failures.push(`${theme} 标签「${tab.label}」文字压住关闭键`)
      }
    }
  }
  if (errors.length) failures.push('pageerror: ' + errors[0])
  await page.close()
} finally { await browser.close() }

if (failures.length) {
  console.log('\nFAIL')
  for (const line of failures) console.log(' - ' + line)
  process.exitCode = 1
} else {
  console.log(`\nPASS: 手机行高 ≥ ${ROW_MIN}、名字分层、标签关闭键只在当前标签（图见 tmp/ui-phone/）`)
}
