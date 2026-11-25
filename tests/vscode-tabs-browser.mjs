import assert from 'node:assert/strict'
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
const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
const shots = join(root, 'tmp/vscode-tabs')
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const url = 'http://127.0.0.1/world-vscode-default'
  await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
  const boot = async () => {
    await page.goto(url); await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  }
  await boot()
  const icon = page.locator('[data-world-icon-id="vscode"]'), card = page.locator('[data-world-app-card="vscode"]')
  await icon.waitFor()
  await page.getByRole('button', { name: '开始' }).click()
  await card.locator('.world-app-open').waitFor(); await card.hover()
  await page.screenshot({ path: join(shots, 'default-installed.png') })
  // 升级已保存的旧配置：只补 VSCode，不恢复已经卸载的浏览器和终端。
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', '["lanchat"]'); localStorage.removeItem('dsh.world.vscode.migrated')
  })
  await boot(); await icon.waitFor()
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.apps')).sort()), ['lanchat', 'vscode'])
  await page.getByRole('button', { name: '开始' }).click(); await card.locator('.world-app-uninstall').click()
  await boot(); assert.equal(await icon.count(), 0)
  await page.getByRole('button', { name: '开始' }).click(); await card.locator('.world-app-install').click()
  await icon.waitFor(); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  await editor.waitFor()
  await page.waitForTimeout(400)
  await editor.getByRole('button', { name: 'src', exact: true }).click()
  for (const name of ['main.js', 'README.md', 'build.bat']) {
    await editor.getByRole('button', { name, exact: true }).dblclick()
    await page.waitForTimeout(350)
  }

  const order = () => editor.locator('.world-vscode-tabs .world-vscode-tab-name').allTextContents()
  assert.deepEqual(await order(), ['main.js', 'README.md', 'build.bat'], '新开的文件追加到组尾')
  const groupCount = await editor.locator('.world-vscode-tabs').count()
  assert.equal(groupCount, 1, '还没分屏时只有一条标签栏')

  // 拖到某个标签的左半边 = 插到它前面；右半边 = 插到它后面
  await editor.getByRole('tab', { name: 'build.bat' }).dragTo(editor.getByRole('tab', { name: 'main.js' }), { targetPosition: { x: 6, y: 18 } })
  await page.waitForTimeout(300)
  assert.deepEqual(await order(), ['build.bat', 'main.js', 'README.md'], '落点在左半边插到它前面')
  await editor.getByRole('tab', { name: 'build.bat' }).dragTo(editor.getByRole('tab', { name: 'main.js' }), { targetPosition: { x: 120, y: 18 } })
  await page.waitForTimeout(300)
  assert.deepEqual(await order(), ['main.js', 'build.bat', 'README.md'], '落点在右半边插到它后面')

  // 右键菜单
  await editor.getByRole('tab', { name: 'build.bat' }).click({ button: 'right' })
  const menu = editor.locator('.world-vscode-tab-menu')
  await menu.waitFor()
  assert.deepEqual(await menu.locator('button').allTextContents(), ['关闭', '关闭其他', '关闭右侧', '关闭全部', '在新窗口打开', '创建父标签组'])
  assert.equal(await menu.locator('.world-context-title').textContent(), 'build.bat')
  const menuBox = await menu.boundingBox()
  assert.ok(menuBox.width > 120 && menuBox.height > 100)
  await page.screenshot({ path: join(shots, 'tab-menu.png') })

  // 关闭右侧：只作用于这一组，并且是自己右边那些
  await menu.getByRole('menuitem', { name: '关闭右侧', exact: true }).click()
  await page.waitForTimeout(300)
  assert.deepEqual(await order(), ['main.js', 'build.bat'], '关闭右侧关掉 README.md，自己和左边的留下')
  assert.equal(await editor.locator('.world-vscode-tab-menu').count(), 0, '点完菜单自己收起')

  // Esc 关闭菜单
  await editor.getByRole('tab', { name: 'main.js' }).click({ button: 'right' })
  await menu.waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert.equal(await editor.locator('.world-vscode-tab-menu').count(), 0, 'Esc 能关掉菜单')

  // 关闭其他：只剩当前这个
  await editor.getByRole('tab', { name: 'main.js' }).click({ button: 'right' })
  await menu.waitFor()
  await menu.getByRole('menuitem', { name: '关闭其他', exact: true }).click()
  await page.waitForTimeout(300)
  assert.deepEqual(await order(), ['main.js'])

  // The parent hosts real strips/sashes; no duplicate document model.
  const tab = name => editor.locator('.world-vscode-tab').filter({ has: page.getByText(name, { exact: true }) })
  const action = async (name, command) => {
    await tab(name).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: command, exact: true }).click()
  }
  const open = name => editor.getByRole('button', { name, exact: true }).dblclick()
  const group = editor.locator('[data-parent-content]')
  const text = name => editor.getByRole('textbox', { name: `编辑 ${name}`, exact: true })
  await open('build.bat'); await open('README.md')
  await action('main.js', '创建父标签组'); await action('README.md', '移入标签组 1')
  assert.equal(await group.getByRole('tab').count(), 2)
  const first = group.locator('.world-vscode-pane').first(), rect = await first.boundingBox()
  await tab('README.md').dragTo(first, { targetPosition: { x: rect.width * .9, y: rect.height / 2 } })
  await group.getByRole('separator').waitFor()
  await group.getByRole('separator').press('ArrowLeft')
  const geometry = () => group.locator('.world-vscode-pane').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }
  }))
  const before = await geometry()
  assert.ok(before[0].width < before[1].width)
  const draft = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i}`).join('\n')
  await text('main.js').fill(draft)
  await text('main.js').evaluate(node => { node.setSelectionRange(13, 19); node.scrollTop = 300; node.dispatchEvent(new Event('scroll')) })
  await page.waitForTimeout(100)
  assert.equal(await text('main.js').evaluate(n => n.scrollTop), 300, 'scroll reached before switching')
  await page.screenshot({ path: join(shots, 'parent-split.png') })
  await tab('build.bat').click()
  assert.equal(await group.count(), 0)
  assert.equal(await editor.locator('.world-vscode-split-textarea').count(), 0, 'hidden parent must unmount small editors')
  await tab('标签组 1').click()
  assert.deepEqual(await geometry(), before)
  assert.equal(await text('main.js').inputValue(), draft)
  assert.deepEqual(await text('main.js').evaluate(n => [n.selectionStart,n.selectionEnd,n.scrollTop]), [13,19,300])
  const close = name => editor.getByRole('button', { name: `关闭标签 ${name}`, exact: true }).click()
  await close('标签组 1'); await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await group.getByRole('tab').count(), 2)
  await close('标签组 1'); await page.getByRole('button', { name: '仍然关闭', exact: true }).click()
  await text('build.bat').waitFor(); assert.deepEqual(await order(), ['build.bat'])

  // Measure after teardown, not at peak allocation. Include actual CodeMirror instances.
  await page.evaluate(() => { window.__worldSourceOpen = async ({ path }) => ({ ok: true, value: {
    path, source: '0123456789012345678901234567890123456789\n'.repeat(32000), version: 'v1', eol: 'LF', bom: false,
  } }) })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable'); const samples = []
  for (let i = 2; i <= 9; i++) {
    await open('big.txt'); await editor.locator('.cm-editor').waitFor()
    await action('big.txt', '创建父标签组')
    if (i === 2) { await group.locator('.cm-content').focus(); await page.keyboard.insertText('group-draft-') }
    await tab('build.bat').click(); assert.equal(await editor.locator('.cm-editor').count(), 0)
    await tab(`标签组 ${i}`).click(); await group.locator('.cm-editor').waitFor()
    if (i === 2) assert.match(await group.locator('.cm-line').first().textContent(), /^group-draft-/u)
    await close(`标签组 ${i}`)
    if (i === 2) await page.getByRole('button', { name: '仍然关闭', exact: true }).click()
    await text('build.bat').waitFor()
    assert.equal(await editor.locator('[data-parent-content], [data-parent-tab], .cm-editor').count(), 0)
    await cdp.send('HeapProfiler.collectGarbage')
    const { metrics } = await cdp.send('Performance.getMetrics'); const get = name => metrics.find(m => m.name === name).value
    samples.push({ nodes: get('Nodes'), listeners: get('JSEventListeners'), heap: get('JSHeapUsedSize') })
  }
  const warm = samples[2], last = samples.at(-1)
  assert.ok(last.heap < warm.heap + 1048576, `retained a full text body: ${JSON.stringify(samples)}`)
  assert.ok(last.nodes <= warm.nodes + 25 && last.listeners <= warm.listeners + 10, JSON.stringify(samples))
  console.log('parent layout and post-GC samples:', JSON.stringify({ before, samples }))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', shots, order: await order() }))
  await page.close()
} finally {
  await browser.close()
}
