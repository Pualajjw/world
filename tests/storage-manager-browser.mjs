import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, readFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorldStorage } from '../storage-manager.js'

export async function checkStorage(browser, bundleText, shotsDir) {
  const directory = await mkdtemp(join(tmpdir(), 'world-storage-ui-'))
  const roots = ['install', 'home', 'desktop'].map((kind, index) => ({ id: kind, kind, group: kind === 'install' ? 'install' : 'user',
    label: ['DSH 安装目录', 'DSH 用户数据', '桌面用户数据'][index], path: join(directory, kind) }))
  for (const root of roots) await mkdir(root.path)
  const put = async (relative, size) => {
    const path = join(directory, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.alloc(size))
    const old = new Date(Date.now() - 30 * 86400000); await utimes(path, old, old)
  }
  await put('install/resources/app.asar', 4 * 1048576)
  await put('home/sessions/session.jsonl', 1048576)
  await put('home/cache/attachments/request-images/aa/image', 2 * 1048576)
  await put('home/logs/old.log', 8192)
  await put('desktop/Local Storage/preferences', 1024)
  const service = createWorldStorage({ roots: () => roots })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
  const errors = [], calls = []
  let delayList, failList = false, failStart = false
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldProcessesCall', () => ({ ok: true, value: { rows: [], timestamp: Date.now(), totals: { count: 0, cpu: 0, workingSet: 0, privateBytes: null } } }))
    await page.exposeBinding('__worldStorageCall', async (_source, operation, payload) => {
      calls.push({ operation, payload })
      try {
        if (operation === 'start' && failStart) throw new Error('扫描启动失败，请重试')
        if (operation === 'list' && failList) throw new Error('读取目录失败，请重试')
        const value = await service.call(operation, payload)
        if (operation === 'list' && payload.query === 'delayed') return await new Promise(resolve => { delayList = () => resolve({ ok: true, value }) })
        return { ok: true, value }
      } catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
    })
    await page.route('http://127.0.0.1/world-storage-fixture', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-storage-fixture')
    await page.addStyleTag({ content: `
      :root { --dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f9fd;--dsw-alias-bg-layer-2:#f1f3f5;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-border-l2:#e1e6ee;--dsw-alias-state-business-primary:#3b6ef6;--dsw-alias-interactive-bg-hover:#ebf0fa;--dsw-alias-interactive-bg-active:#e1e9fa; }
      :root[data-ds-dark-theme] { --dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#1e2024;--dsw-alias-bg-layer-2:#272a30;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#bec4cd;--dsw-alias-border-l2:#414650;--dsw-alias-interactive-bg-hover:#323741;--dsw-alias-interactive-bg-active:#3c414b; }
    ` })
    await page.addScriptTag({ content: bundleText })
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await page.locator('[data-world-app-card="world-processes"] .world-app-open').click()
    const win = page.locator('[data-world-plugin="world-processes"]')
    await win.getByRole('tab', { name: '存储与清理', exact: true }).click()
    const storage = win.locator('.world-storage')
    await storage.getByRole('button', { name: '重新扫描', exact: true }).waitFor()
    await storage.locator('[data-storage-entry="resources"]').waitFor()
    assert.match(await storage.locator('.world-resource-cards').innerText(), /4.0 MiB/u)
    const geometry = await storage.evaluate(node => ({ padding: getComputedStyle(node).padding,
      gap: getComputedStyle(node).gap, directoryWidth: node.querySelector('.world-storage-roots').getBoundingClientRect().width,
      rowHeight: node.querySelector('tbody tr').getBoundingClientRect().height,
      radius: getComputedStyle(node.querySelector('.world-resource-card')).borderRadius }))
    assert.deepEqual(geometry, { padding: '16px', gap: '12px', directoryWidth: 240, rowHeight: 36, radius: '8px' })
    assert.equal(await storage.getByRole('button', { name: '释放空间', exact: true }).isEnabled(), false)
    await storage.getByRole('button', { name: /DSH 用户数据/u }).click()
    await storage.locator('[data-storage-entry="cache"]').waitFor()
    await storage.getByRole('button', { name: 'cache', exact: true }).click()
    await storage.locator('[data-storage-entry="attachments"]').waitFor()
    await storage.getByRole('button', { name: '上一级', exact: true }).click()
    await storage.locator('[data-storage-entry="sessions"]').waitFor()
    const search = storage.getByLabel('搜索 DSH 存储文件')
    await search.fill('delayed')
    while (!delayList) await page.waitForTimeout(10)
    await search.fill('session.jsonl')
    await storage.locator('[data-storage-entry="session.jsonl"]').waitFor()
    delayList(); await page.waitForTimeout(50)
    assert.equal(await storage.locator('[data-storage-entry="session.jsonl"]').count(), 1, 'late directory response cannot replace current search')
    await search.fill(''); await storage.locator('[data-storage-entry="cache"]').waitFor()
    if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.screenshot({ path: join(shotsDir, 'storage-desktop.png') }) }
    await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
    if (shotsDir) await page.screenshot({ path: join(shotsDir, 'storage-dark.png') })

    await storage.getByLabel(/附件图片缓存/u).check()
    await storage.getByLabel(/DSH 旧日志/u).check()
    await storage.getByRole('button', { name: '释放空间', exact: true }).click()
    await page.locator('[data-world-confirm]').waitFor()
    assert.match(await page.locator('.world-confirm-message').innerText(), /永久删除 2 个文件/u)
    await page.locator('[data-world-confirm] [data-role="cancel"]').click()
    assert.equal(calls.filter(call => call.operation === 'start' && call.payload.mode === 'cleanup').length, 0)
    assert.equal((await lstat(join(directory, 'home/logs/old.log'))).size, 8192)
    await storage.getByRole('button', { name: '释放空间', exact: true }).click()
    await page.locator('[data-world-confirm] [data-role="confirm"]').click()
    await storage.getByText(/清理完成 · 已删除 2 个文件/u).waitFor()
    await storage.getByRole('button', { name: '重新扫描', exact: true }).waitFor()
    assert.equal(calls.filter(call => call.operation === 'start' && call.payload.mode === 'cleanup').length, 1)
    assert.equal((await readFile(join(directory, 'home/sessions/session.jsonl'))).length, 1048576)
    assert.match(await storage.locator('.world-resource-cards').innerText(), /可释放空间\s+0 B/u)
    await page.setViewportSize({ width: 360, height: 740 })
    await page.evaluate(() => document.documentElement.removeAttribute('data-ds-dark-theme'))
    await page.waitForTimeout(250)
    assert.equal(await storage.evaluate(node => node.scrollWidth > node.clientWidth), false, 'phone storage has no page-level horizontal overflow')
    assert.equal(await storage.getByRole('button', { name: '重新扫描', exact: true }).evaluate(node => node.getBoundingClientRect().height), 44)
    if (shotsDir) await page.screenshot({ path: join(shotsDir, 'storage-phone.png') })
    await storage.evaluate(node => { node.scrollTop = node.querySelector('.world-storage-files').offsetTop - node.offsetTop })
    const phoneContent = await storage.evaluate(node => {
      const table = node.querySelector('.world-storage-files').getBoundingClientRect()
      const action = node.querySelector('.world-storage-cleanup-action').getBoundingClientRect()
      return { contentVisible: table.top < action.top && table.bottom > node.getBoundingClientRect().top,
        actionVisible: action.bottom <= node.getBoundingClientRect().bottom + 1 }
    })
    assert.equal(phoneContent.contentVisible, true, 'phone can scroll to the file details above the cleanup action')
    assert.equal(phoneContent.actionVisible, true)
    if (shotsDir) await page.screenshot({ path: join(shotsDir, 'storage-phone-files.png') })
    // Failure preserves the inventory; a rescan recovers and refreshes the file listing.
    failList = true; await search.fill('broken')
    await storage.getByRole('alert').filter({ hasText: '读取目录失败' }).waitFor()
    failList = false; await storage.getByRole('button', { name: '重新扫描', exact: true }).click()
    await storage.getByRole('button', { name: '重新扫描', exact: true }).waitFor()
    assert.equal(await storage.getByRole('alert').count(), 0)
    failStart = true
    await storage.getByRole('button', { name: '重新扫描', exact: true }).click()
    await storage.getByRole('alert').filter({ hasText: '扫描启动失败' }).waitFor()
    await page.waitForTimeout(100)
    assert.match(await storage.getByRole('alert').innerText(), /扫描启动失败/u, 'listing refresh must not erase the scan failure')
    assert.deepEqual(errors, [])
    console.log(`Storage UI passed: ${JSON.stringify(geometry)}; scoped inventory, navigation/search, stale responses, cancel/confirm cleanup, refresh, themes and 360px phone.`)
  } finally {
    await page.close(); service.dispose()
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-storage-ui-'))
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let build
  try { ({ build } = await import('esbuild')) }
  catch { ({ build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')) }
  const require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
  const { chromium } = require('playwright-core')
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkStorage(browser, bundle.outputFiles[0].text, process.env.WORLD_PROCESS_SHOTS_DIR) }
  finally { await browser.close() }
}
