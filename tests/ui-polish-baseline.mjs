/**
 * UI polish check: measure geometry / computed colors for the three areas we touch
 * (designer view tabs, properties panel, desktop launcher icons) in dark + light themes,
 * write tmp/ui-polish/baseline.json, and assert the thresholds below. Exit code 1 on regression.
 */
import { card } from './srw-fixture.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// WCAG: 4.5 for text, 3 for UI components. Wall proxy keeps the glyph check honest in both tones.
const TEXT_MIN = 4.5
const ICON_MIN = 3
const WALL = { dark: 'rgb(46, 46, 46)', light: 'rgb(240, 240, 240)' }
const parseColor = text => (text?.match(/[\d.]+/g) ?? []).map(Number)
const luminance = rgb => {
  const [r, g, b] = rgb.slice(0, 3).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
  return .2126 * r + .7152 * g + .0722 * b
}
const contrastOf = (a, b) => {
  const l1 = luminance(parseColor(a)), l2 = luminance(parseColor(b))
  return Math.round(((Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05)) * 100) / 100
}

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
const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
const shots = join(root, 'tmp/ui-polish')
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const out = { tabs: {}, props: {}, canvas: {}, rows: {}, gutter: {}, launcher: {} }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(html)
  await page.evaluate(source => {
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source,version:'t',eol:'LF',encoding:'UTF-8'}})
    window.__worldWorkspaceList = async ({path}) => ({ok:true,value:{path,parent:'',entries:['w_dk.srw'].map(name=>({name,type:'file'}))}})
  }, card)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole('button', {name:'开始', exact:true}).click()
  await page.locator('[data-world-app-card="vscode"] .world-app-install').click()
  await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  await editor.waitFor()
  await editor.getByRole('button', {name:'w_dk.srw', exact:true}).dblclick()
  await editor.locator('.world-srw-panes').waitFor()
  await page.waitForTimeout(300)

  const measure = () => page.evaluate(() => {
    const px = n => Math.round(n * 100) / 100
    const cs = el => el ? getComputedStyle(el) : null
    const rect = el => { const r = el.getBoundingClientRect(); return {x:px(r.x),y:px(r.y),w:px(r.width),h:px(r.height)} }
    const parse = c => { const m = c.match(/[\d.]+/g)?.map(Number) ?? []; return m }
    const lum = rgb => { const [r,g,b] = rgb.slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4}); return .2126*r+.7152*g+.0722*b }
    const contrast = (a,b) => { const l1=lum(parse(a)),l2=lum(parse(b)); return px((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)) }
    const res = {}

    // designer view tabs (bottom strip inside a design group)
    const strip = document.querySelector('.world-srw-panes .world-vscode-tabs')
    const tabs = [...document.querySelectorAll('.world-srw-panes .world-vscode-tab')]
    if (strip) {
      const s = cs(strip)
      res.tabs = { stripH: px(strip.getBoundingClientRect().height), bg: s.backgroundColor,
        count: tabs.length,
        items: tabs.map(t => { const ts = cs(t); return {name:t.textContent.trim().slice(0,14), active:t.classList.contains('active'),
          h:px(t.getBoundingClientRect().height), w:px(t.getBoundingClientRect().width),
          fontSize:ts.fontSize, color:ts.color, bg:ts.backgroundColor, borderTop:ts.borderTopColor,
          contrast: contrast(ts.color, ts.backgroundColor)} }) }
    }

    // properties panel
    const props = document.querySelector('.world-srw-view.is-properties')
    if (props) {
      const dl = props.querySelector('dl'), dt = props.querySelector('dt'), dd = props.querySelector('dd')
      const grp = props.querySelector('.world-srw-group'), sum = props.querySelector('.world-srw-group > summary')
      const nav = props.querySelector('nav')
      res.props = {
        view: {bg:cs(props).backgroundColor, color:cs(props).color},
        nav: nav ? {pad:cs(nav).padding, border:cs(nav).borderBottomColor} : null,
        dl: dl ? {cols:cs(dl).gridTemplateColumns, gap:cs(dl).gap} : null,
        dt: dt ? {color:cs(dt).color, fontSize:cs(dt).fontSize, w:px(dt.getBoundingClientRect().width)} : null,
        dd: dd ? {color:cs(dd).color, bg:cs(dd).backgroundColor, border:cs(dd).borderColor,
          fontSize:cs(dd).fontSize, h:px(dd.getBoundingClientRect().height),
          contrast: contrast(cs(dd).color, cs(dd).backgroundColor)} : null,
        // 布尔属性行画的是复选框：行内元素下沿的空白会把这一行顶高 4px，整列就这一行不齐
        ddHeights: [...props.querySelectorAll('dd')].map(d => px(d.getBoundingClientRect().height)),
        group: grp ? {border:cs(grp).borderColor, radius:cs(grp).borderRadius} : null,
        summary: sum ? {color:cs(sum).color, fontSize:cs(sum).fontSize, bg:cs(sum).backgroundColor} : null,
      }
    }

    // desktop launcher icons
    const icons = [...document.querySelectorAll('.world-desktop-icon')]
    res.launcher = { count: icons.length, items: icons.map(ic => {
      const label = ic.querySelector('.world-icon-label'), glyph = ic.querySelector('.world-glyph')
      const ls = cs(label), box = ic.getBoundingClientRect()
      return {label:label?.textContent.trim().slice(0,18), glyphBg:glyph?cs(glyph).backgroundColor:null,
        glyphColor:glyph?cs(glyph).color:null, glyphStroke:glyph?.querySelector('svg')?.getAttribute('stroke'),
        labelColor:ls?.color, labelShadow:ls?.textShadow, labelFont:ls?.fontSize,
        box:px(box.width), glyphBox:glyph?px(glyph.getBoundingClientRect().width):null}
    }) }
    return res
  })

  // 列表行：行高、首行离视图顶边的距离、行距、选中行的左侧强调条
  const measureRows = () => page.evaluate(() => {
    const view = document.querySelector('.world-srw-panes [data-srw-view=controls]')
    const items = view ? [...view.querySelectorAll('.world-srw-row')] : []
    if (!items.length) return null
    const first = items[0], box = first.getBoundingClientRect(), top = view.getBoundingClientRect()
    const selected = view.querySelector('.world-srw-row[aria-pressed=true]')
    return {
      count: items.length,
      h: Math.round(box.height),
      inset: Math.round(box.top - top.top),
      pad: getComputedStyle(first).padding,
      gap: getComputedStyle(first.parentElement).gap,
      listPad: getComputedStyle(first.parentElement).paddingTop,
      selectedShadow: selected ? getComputedStyle(selected).boxShadow : null,
    }
  })
  // 声明视图里 CodeMirror 的行号槽：必须是透明底，否则浅色主题里是一条黑带
  const measureGutter = () => page.evaluate(() => {
    const gutter = document.querySelector('.world-srw-panes .cm-gutters')
    if (!gutter) return null
    const style = getComputedStyle(gutter)
    return { bg: style.backgroundColor, color: style.color }
  })
  // 画布控件的凸起斜面：`outset #eee` 是从边框色自己推明暗的，底色和画布一样时亮面直接消失
  const measureCanvas = () => page.evaluate(() => {
    const el = document.querySelector('.world-srw-view.is-layout .world-srw-control[data-type=commandbutton]')
    if (!el) return null
    const s = getComputedStyle(el)
    return { top: s.borderTopColor, bottom: s.borderBottomColor, left: s.borderLeftColor, right: s.borderRightColor,
      width: s.borderTopWidth, style: s.borderTopStyle, bg: s.backgroundColor }
  })
  const show = name => editor.locator('.world-srw-panes .world-vscode-tab').filter({hasText: name}).first().click()

  for (const theme of ['dark', 'light']) {
    // 上一轮最后停在 Variables 上，右栏已经换过内容：先恢复「画布 + 属性栏」的默认视图
    await show('Layout')
    await show('Properties')
    await page.waitForTimeout(160)
    await page.evaluate(t => { document.body.dataset.worldTheme = t; document.body.dataset.worldWallTone = t }, theme)
    await page.waitForTimeout(120)
    const seen = await measure()
    out.tabs[theme] = seen.tabs
    out.props[theme] = seen.props
    out.canvas[theme] = await measureCanvas()
    await page.screenshot({ path: join(shots, `srw-${theme}.png`) })
    // 列表行与声明编辑器各有自己的视图：切过去量完再切回画布
    await show('Control List')
    await page.waitForTimeout(160)
    out.rows[theme] = await measureRows()
    await show('Variables')
    await page.waitForTimeout(160)
    out.gutter[theme] = await measureGutter()
    await show('Layout')
    await page.waitForTimeout(120)
  }
  // launcher captured from the desktop root (window covers it, hide vscode for a clean shot)
  await page.evaluate(() => { document.querySelector('.world-vscode-window').style.visibility = 'hidden' })
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.body.dataset.worldTheme = t; document.body.dataset.worldWallTone = t }, theme)
    await page.waitForTimeout(120)
    out.launcher[theme] = (await measure()).launcher
    await page.screenshot({ path: join(shots, `launcher-${theme}.png`) })
  }
  out.errors = errors
  writeFileSync(join(shots, 'baseline.json'), JSON.stringify(out, null, 2))

  const failures = errors.map(message => 'pageerror: ' + message)
  for (const theme of ['dark', 'light']) {
    const tabs = out.tabs[theme], items = tabs?.items ?? [], icons = out.launcher[theme]?.items ?? []
    if (!items.length) failures.push(theme + ' 设计视图标签缺失')
    for (const tab of items) {
      if (tab.contrast < TEXT_MIN) failures.push(`${theme} 标签「${tab.name}」对比度 ${tab.contrast} < ${TEXT_MIN}`)
    }
    const dd = out.props[theme]?.dd
    if (!dd) failures.push(theme + ' 属性面板缺失')
    else if (dd.contrast < TEXT_MIN) failures.push(`${theme} 属性值对比度 ${dd.contrast} < ${TEXT_MIN}`)
    // 复选框那一行原来高 4px：一列属性里就它不齐
    const hs = out.props[theme]?.ddHeights ?? []
    if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 1) failures.push(`${theme} 属性值行高不齐：${hs.join('/')}`)
    // 画布控件的斜面必须上/下不同色且能分辨，否则只剩半条边框
    const canvas = out.canvas[theme]
    if (!canvas) failures.push(theme + ' 画布控件缺失')
    else {
      const bevel = contrastOf(canvas.top, canvas.bottom)
      if (canvas.top === canvas.bottom) failures.push(`${theme} 画布控件没有斜面（四边同色 ${canvas.top}）`)
      else if (bevel < 1.4) failures.push(`${theme} 画布控件斜面只有 ${bevel} 对比（${canvas.top} vs ${canvas.bottom}）`)
    }
    if (!icons.length) failures.push(theme + ' 桌面图标缺失')
    for (const icon of icons) {
      // Glyph color is the inherited `color`; an outline-only icon (trash) disappears without it.
      if (!icon.glyphColor) { failures.push(`${theme} 图标「${icon.label}」没有前景色`); continue }
      const visible = contrastOf(icon.glyphColor, WALL[theme])
      if (visible < ICON_MIN) failures.push(`${theme} 图标「${icon.label}」前景 ${icon.glyphColor} 在壁纸上只有 ${visible} < ${ICON_MIN}`)
    }
    const rows = out.rows[theme], gutter = out.gutter[theme]
    if (!rows) failures.push(theme + ' 控件列表为空')
    else {
      if (rows.h < 20) failures.push(`${theme} 列表行高 ${rows.h} < 20`)
      if (rows.inset < 4) failures.push(`${theme} 首行离视图顶边只有 ${rows.inset}px`)
      if (parseFloat(rows.listPad) < 2) failures.push(`${theme} 列表容器没有内边距（${rows.listPad}）`)
      if (!/inset/.test(rows.selectedShadow || '')) failures.push(`${theme} 选中行没有强调条：${rows.selectedShadow}`)
    }
    // 行号槽透明：用深色底会在浅色主题里变成一条黑带
    if (!gutter) failures.push(theme + ' 声明编辑器缺失')
    else if (gutter.bg !== 'rgba(0, 0, 0, 0)') failures.push(`${theme} CodeMirror 行号槽底色 ${gutter.bg}（应为透明）`)
    console.log(`[${theme}] tabs ` + items.map(t => `${t.active ? '*' : ''}${t.name}:${t.contrast}`).join('  ') +
      `  | props dd:${dd?.contrast} rows ${hs.join('/')}  | bevel ${canvas ? contrastOf(canvas.top, canvas.bottom) : '-'}  | icons ` +
      icons.map(i => `${i.label}:${contrastOf(i.glyphColor, WALL[theme])}`).join('  ') +
      `  | rows ${rows?.h}px inset ${rows?.inset}  | gutter ${gutter?.bg}`)
  }
  if (failures.length) {
    console.log('\nFAIL')
    for (const line of failures) console.log(' - ' + line)
    process.exitCode = 1
  } else {
    console.log(`\nPASS: 标签/属性 ≥ ${TEXT_MIN}、图标 ≥ ${ICON_MIN}，两套主题都达标（图见 tmp/ui-polish/）`)
  }
  await page.close()
} finally {
  await browser.close()
}
