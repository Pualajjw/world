import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { card } from './srw-fixture.js'

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
const shots = join(root, 'tmp/vscode-refresh')
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(html)
  await page.evaluate(source => {
    window.__files = { 'main.js': 'const value = 1\n', 'w_dk.srw': source }
    window.__versions = new Map()
    const bump = name => window.__versions.set(name, `v${(Number(window.__versions.get(name)?.slice(1)) || 1) + 1}`)
    window.__worldSourceOpen = async ({ path }) => {
      const name = path.split('/').pop()
      return { ok: true, value: { path, source: window.__files[name], version: window.__versions.get(name) || 'v1', eol: 'LF', encoding: 'UTF-8' } }
    }
    window.__worldSourceVersions = async ({ paths }) => ({ ok: true, value: {
      versions: paths.filter(path => window.__files[path.split('/').pop()] !== undefined)
        .map(path => ({ path, version: window.__versions.get(path.split('/').pop()) || 'v1' })),
    } })
    window.__touch = (name, text) => { window.__files[name] = text; bump(name) }
    window.__worldSourceSave = async payload => {
      const name = payload.path.split('/').pop()
      window.__files[name] = payload.source; bump(name)
      return { ok: true, value: { path: payload.path, source: payload.source, version: window.__versions.get(name), eol: 'LF', encoding: 'UTF-8' } }
    }
    window.__worldWorkspaceList = async ({ path }) => ({ ok: true, value: { path, parent: '',
      entries: Object.keys(window.__files).map(name => ({ name, type: 'file' })) } })
  }, card)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  await editor.waitFor()
  await page.waitForTimeout(300)

  // 普通文件：外部改版本 → 只重读这一个标签
  await editor.getByRole('button', { name: 'main.js', exact: true }).dblclick()
  const input = editor.getByRole('textbox', { name: '编辑 main.js', exact: true })
  await input.waitFor()
  assert.equal(await input.inputValue(), 'const value = 1\n')
  await page.evaluate(() => window.__touch('main.js', 'const value = 42\n'))
  await page.waitForFunction(() => document.querySelector('[aria-label="编辑 main.js"]')?.value === 'const value = 42\n', null, { timeout: 8000 })
  assert.equal(await editor.locator('.world-vscode-tab.is-stale').count(), 0, '无草稿时自动重读，不留提示')

  // 同一路径的外部重读会替换 textarea。扩大窗口并滚到中间，行号必须覆盖新正文的整屏。
  const updated = Array.from({ length: 240 }, (_, i) => `// line ${i + 1}`).join('\n')
  const gutter = editor.locator('.world-vscode-row-number')
  await page.evaluate(source => window.__touch('main.js', source), updated)
  await page.waitForFunction(source => document.querySelector('[aria-label="编辑 main.js"]')?.value === source, updated, { timeout: 8000 })
  await editor.getByRole('button', { name: '最大化 Visual Studio Code' }).click()
  await page.setViewportSize({ width: 1280, height: 1200 })
  const visible = await input.evaluate(async node => {
    const height = parseFloat(getComputedStyle(node).lineHeight)
    node.scrollTop = 80 * height
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { first: 1 + Math.floor(node.scrollTop / height), last: Math.floor((node.scrollTop + node.clientHeight) / height) }
  })
  const numbers = (await gutter.allTextContents()).map(Number)
  for (let n = visible.first; n <= visible.last; n++) assert.ok(numbers.includes(n), `外部更新后可见第 ${n} 行没有行号：${numbers[0]}–${numbers.at(-1)}`)
  const maxOffset = await input.evaluate(node => {
    const style = getComputedStyle(node), top = node.getBoundingClientRect().top + parseFloat(style.paddingTop)
    return Math.max(...Array.from(node.parentElement.querySelectorAll('.world-vscode-row-number'), number => {
      const expected = top + (Number(number.textContent) - 1) * parseFloat(style.lineHeight) - node.scrollTop
      return Math.abs(number.getBoundingClientRect().top - expected)
    }))
  })
  assert.ok(maxOffset <= 1, `行号和正文错位 ${maxOffset}px`)
  console.log('外部重读后可见行', visible, '行号最大偏差(px)', maxOffset)
  await editor.screenshot({ path: join(shots, 'external-refresh-lines.png') })
  await page.evaluate(() => window.__touch('main.js', 'one\ntwo\nthree'))
  await page.waitForFunction(() => document.querySelector('[aria-label="编辑 main.js"]')?.value === 'one\ntwo\nthree', null, { timeout: 8000 })
  assert.deepEqual(await gutter.allTextContents(), ['1', '2', '3'])
  await input.focus(); await input.press('Control+End')
  await editor.getByTitle('光标位置：行 3, 列 6', { exact: true }).waitFor()
  await page.setViewportSize({ width: 1280, height: 860 })
  await editor.getByRole('button', { name: '还原 Visual Studio Code' }).click()

  // 有草稿：不覆盖，只打 stale，并给状态栏重载入口
  await input.fill('const draft = 7\n')
  await page.evaluate(() => window.__touch('main.js', 'const value = 99\n'))
  await page.waitForFunction(() => document.querySelector('.world-vscode-tab.is-stale') !== null, null, { timeout: 8000 })
  assert.equal(await input.inputValue(), 'const draft = 7\n', '草稿不能被外部内容覆盖')
  assert.match(await editor.locator('.world-vscode-status-stale').innerText(), /磁盘已更新/)
  // 自己保存写盘不能被轮询当成外部修改再重读一遍
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-tab.is-stale') === null, null, { timeout: 4000 })
  const savedOpens = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/open').length)
  await page.waitForTimeout(4200)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/open').length), savedOpens,
    '保存后不重读自己的写盘结果')

  // 版本没变时只发批量版本查询，不重读文件
  const before = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/open').length)
  await page.waitForTimeout(4200)
  const after = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/open').length)
  assert.equal(after, before, '空闲轮询不能重读文件')
  assert.ok(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-source/versions')))

  // 设计组：重读并重解析，保留当前视图
  await editor.getByRole('button', { name: 'w_dk.srw', exact: true }).dblclick()
  const grp = editor.locator('.world-srw-panes')
  await grp.locator('[data-srw-view=layout]').waitFor()
  const first = grp.locator('[data-srw-object="cb_1"]')
  assert.equal(await first.textContent(), 'none')
  await grp.getByRole('tab', { name: 'Variables' }).click()
  await grp.locator('[data-srw-view=variables]').waitFor()
  await page.evaluate(source => window.__touch('w_dk.srw', source), card.replaceAll('string text = "none"', 'string text = "外部修改后"'))
  await page.waitForTimeout(4200)
  assert.equal(await grp.locator('[data-srw-view=variables]').isVisible(), true, '刷新后当前视图不能丢')
  assert.deepEqual(await grp.locator('.world-vscode-tab-name').allTextContents(),
    ['Layout', 'open', 'Event List', 'Function List', 'Variables', 'Properties', 'Control List', 'Non-Visual Object List'])
  await grp.getByRole('tab', { name: 'Layout' }).click()
  await page.waitForFunction(() => document.querySelector('[data-srw-object="cb_1"]')?.textContent === '外部修改后', null, { timeout: 4000 })
  await editor.screenshot({ path: join(shots, 'design-refresh.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', shots }))
} finally {
  await browser.close()
}
