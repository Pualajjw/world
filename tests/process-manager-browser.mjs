import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkProcesses(browser, bundleText, shotsDir) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = [], calls = []
  let mode = 'normal', releaseFile
  const rows = [
    { pid: 10, parentPid: 1, startedAt: '100', name: 'DeepSeek Harness.exe', role: 'DSH 主进程', cpu: 3.5,
      workingSet: 180 * 1048576, privateBytes: 120 * 1048576, handles: 700, threads: 36, path: 'C:\\DSH\\DeepSeek Harness.exe' },
    { pid: 11, parentPid: 10, startedAt: '110', name: 'DeepSeek Harness.exe', role: 'DSH 子进程', cpu: 12,
      workingSet: 320 * 1048576, privateBytes: 260 * 1048576, handles: 500, threads: 25, path: 'C:\\DSH\\DeepSeek Harness.exe' },
    { pid: 12, parentPid: 10, startedAt: '120', name: 'world-host.exe', role: 'world 宿主', cpu: 1,
      workingSet: 90 * 1048576, privateBytes: 60 * 1048576, handles: 120, threads: 8, path: 'C:\\DSH\\world-host.exe' },
  ]
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldProcessesCall', (_source, operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'snapshot') return mode === 'error'
        ? { ok: false, error: { message: 'snapshot unavailable' } }
        : { ok: true, value: { rootPid: 10, timestamp: Date.now(), cores: 16, rows,
          totals: { count: 3, cpu: 16.5, workingSet: 590 * 1048576, privateBytes: 440 * 1048576 } } }
      const result = { ok: true, value: { path: payload.path, owners: payload.path.includes('empty') ? [] :
        [{ pid: 12, startedAt: '120', name: 'world-host.exe' }] } }
      return mode === 'delayed' ? new Promise(resolve => { releaseFile = () => resolve(result) }) : result
    })
    await page.route('http://127.0.0.1/world-processes-fixture', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-processes-fixture')
    await page.addStyleTag({ content: `
      :root { --dsw-alias-bg-base: rgb(255,255,255); --dsw-alias-bg-layer-1: rgb(247,249,253);
        --dsw-alias-bg-layer-2: rgb(241,243,245); --dsw-alias-label-primary: rgb(23,35,60);
        --dsw-alias-label-secondary: rgb(100,110,130); --dsw-alias-border-l2: rgb(225,230,238);
        --dsw-alias-interactive-bg-hover: rgb(235,240,250); --dsw-alias-interactive-bg-active: rgb(225,233,250); }
      :root[data-ds-dark-theme] { --dsw-alias-bg-base: rgb(21,21,23); --dsw-alias-bg-layer-1: rgb(30,32,36);
        --dsw-alias-bg-layer-2: rgb(39,42,48); --dsw-alias-label-primary: rgb(249,250,251);
        --dsw-alias-label-secondary: rgb(190,196,205); --dsw-alias-border-l2: rgb(65,70,80);
        --dsw-alias-interactive-bg-hover: rgb(50,55,65); --dsw-alias-interactive-bg-active: rgb(60,65,75); }
    ` })
    await page.addScriptTag({ content: bundleText })
    assert.equal(await page.locator('[data-world-icon-id="plugin:world-processes"]').count(), 0)
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-processes"] .world-app-open').click()
    const win = page.locator('[data-world-plugin="world-processes"]')
    const tableRows = win.locator('tbody tr')
    await tableRows.first().waitFor()
    assert.equal(await tableRows.count(), 3)
    assert.equal(await tableRows.first().getAttribute('data-process-pid'), '11')
    const geometry = await win.evaluate(node => ({ width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height, rowHeight: node.querySelector('tbody tr').getBoundingClientRect().height,
      buttonHeight: node.querySelector('.world-processes-toolbar button').getBoundingClientRect().height,
      fontSize: getComputedStyle(node.querySelector('.world-processes')).fontSize }))
    assert.deepEqual(geometry, { width: 1024, height: 640, rowHeight: 36, buttonHeight: 36, fontSize: '13px' })
    assert.equal(await win.locator('.world-processes').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)')
    await win.getByRole('button', { name: '暂停刷新', exact: true }).click()
    const beforePause = calls.filter(call => call.operation === 'snapshot').length
    await page.waitForTimeout(2200)
    assert.equal(calls.filter(call => call.operation === 'snapshot').length, beforePause)
    await win.getByLabel('搜索 DSH 进程').fill('12')
    assert.equal(await tableRows.count(), 1)
    await tableRows.first().focus(); await page.keyboard.press('Enter')
    assert.equal(await win.getByLabel('进程文件路径').inputValue(), 'C:\\DSH\\world-host.exe')
    assert.match(await win.getByRole('region', { name: '进程详情' }).innerText(), /句柄 120/u)
    await win.getByLabel('搜索 DSH 进程').fill('')
    await win.getByRole('button', { name: '工作集', exact: true }).click()
    assert.equal(await tableRows.first().getAttribute('data-process-pid'), '11')
    await win.getByRole('button', { name: '工作集 ↓', exact: true }).click()
    assert.equal(await tableRows.first().getAttribute('data-process-pid'), '12')
    const fileInput = win.getByLabel('查询占用的文件路径')
    await fileInput.fill('C:\\数据\\notes.txt')
    await win.getByRole('button', { name: '查询占用', exact: true }).click()
    await win.locator('.world-processes-owners').getByRole('button', { name: 'world-host.exe · PID 12' }).waitFor()
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true })
      await page.screenshot({ path: join(shotsDir, 'desktop.png') })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
    assert.equal(await win.locator('.world-processes').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(21, 21, 23)')
    if (shotsDir) await page.screenshot({ path: join(shotsDir, 'dark.png') })
    await fileInput.fill('C:\\数据\\empty.txt')
    await win.getByRole('button', { name: '查询占用', exact: true }).click()
    await win.getByText('未发现 DSH 进程占用该文件；其他程序的占用不在查询范围内。', { exact: true }).waitFor()
    mode = 'delayed'
    await fileInput.fill('C:\\数据\\old.txt')
    await win.getByRole('button', { name: '查询占用', exact: true }).click()
    await win.getByRole('button', { name: '查询中…', exact: true }).waitFor()
    await fileInput.fill('C:\\数据\\new.txt')
    releaseFile()
    assert.equal(await win.locator('.world-processes-owners').count(), 0, 'a late lookup must not display results for a replaced path')
    mode = 'error'
    await win.getByRole('button', { name: '刷新', exact: true }).click()
    await win.getByRole('alert').filter({ hasText: 'snapshot unavailable' }).waitFor()
    assert.equal(await tableRows.count(), 3, 'failed refresh retains the last successful snapshot')
    mode = 'normal'
    await win.getByRole('button', { name: '继续刷新', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.world-processes-error'))
    const beforePolling = calls.filter(call => call.operation === 'snapshot').length
    await page.waitForTimeout(2200)
    assert.ok(calls.filter(call => call.operation === 'snapshot').length > beforePolling)
    await win.getByRole('button', { name: '最小化', exact: true }).click()
    const beforeMinimize = calls.filter(call => call.operation === 'snapshot').length
    await page.waitForTimeout(2200)
    assert.equal(calls.filter(call => call.operation === 'snapshot').length, beforeMinimize)
    await page.locator('[data-world-taskbar="plugin:world-processes"]').click()
    await page.setViewportSize({ width: 360, height: 740 })
    await page.waitForTimeout(250)
    const phone = await win.evaluate(node => ({ width: node.getBoundingClientRect().width,
      rowHeight: node.querySelector('tbody tr').getBoundingClientRect().height,
      buttonHeight: node.querySelector('.world-processes-toolbar button').getBoundingClientRect().height,
      overflow: node.querySelector('.world-processes').scrollWidth > node.querySelector('.world-processes').clientWidth }))
    assert.equal(phone.width, 360); assert.equal(phone.rowHeight, 44); assert.equal(phone.buttonHeight, 44)
    assert.equal(phone.overflow, false, 'horizontal scrolling stays inside the process table')
    if (shotsDir) await page.screenshot({ path: join(shotsDir, 'phone.png') })
    assert.equal(await win.getByRole('button', { name: /结束|终止/u }).count(), 0)
    assert.deepEqual(errors, [])
    await win.getByRole('button', { name: '关闭', exact: true }).click()
    const beforeClose = calls.length
    await page.waitForTimeout(2200)
    assert.equal(calls.length, beforeClose, 'closing the manager stops its polling')
    console.log('DSH processes passed: ' + JSON.stringify({ geometry, phone }) + '; sorting, filtering, selection, file lookup, stale response, retry, pause/minimize/close, read-only.')
  } finally { await page.close() }
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
  try { await checkProcesses(browser, bundle.outputFiles[0].text, process.env.WORLD_PROCESS_SHOTS_DIR) }
  finally { await browser.close() }
}
