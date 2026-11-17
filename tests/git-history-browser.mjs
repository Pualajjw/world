import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
let mode = 'normal', release
const commit = { hash: 'abcdef0123456789012345678901234567890123', shortHash: 'abcdef0',
  subject: '完善 Git 提交历史', body: '完善 Git 提交历史\n\n完整中文说明\n多行正文 <b>不作为HTML</b>',
  author: '测试作者', date: '2026-11-16T09:00:00+08:00' }
try {
  await page.addInitScript(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
  await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.exposeBinding('__worldGitLog', (_source, payload) => {
    if (mode === 'delay') return new Promise(resolve => { release = resolve })
    if (mode === 'error') return { ok: false, error: { message: 'history unavailable' } }
    return { ok: true, value: { commits: mode === 'empty' ? [] : [{ ...commit, subject: payload.root === '/workspace/src' ? '子目录提交' : commit.subject }], truncated: false } }
  })
  await page.route('http://127.0.0.1/world-history-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-history-fixture')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('.world-start-button').click()
  await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
  await page.getByRole('button', { name: '源代码管理', exact: true }).click()
  const row = page.locator('.world-vscode-git-history-row').first()
  await row.waitFor()
  await row.click()
  const detail = page.locator('.world-vscode-git-history-detail')
  assert.match(await detail.innerText(), /测试作者/u)
  assert.equal(await detail.locator('pre').innerText(), commit.body)
  assert.equal(await detail.locator('b').count(), 0)
  const geometry = await row.evaluate(node => ({ height: node.getBoundingClientRect().height, fontSize: getComputedStyle(node).fontSize }))
  assert.equal(geometry.height, 24)
  assert.equal(geometry.fontSize, '12px')
  const shots = join(root, 'tmp/git-history-shots')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'desktop.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
  await page.screenshot({ path: join(shots, 'dark.png') })
  const toggle = page.locator('.world-vscode-git-history-toggle')
  await toggle.click()
  assert.equal(await row.count(), 0)
  await toggle.focus(); await page.keyboard.press('Space')
  await row.waitFor()
  const refresh = page.getByRole('button', { name: '刷新 Git 状态', exact: true })
  mode = 'empty'; await refresh.click()
  await page.getByText('暂无提交', { exact: true }).waitFor()
  mode = 'error'; await refresh.click()
  await page.getByRole('alert').filter({ hasText: 'history unavailable' }).waitFor()
  mode = 'normal'; await refresh.click(); await row.waitFor()
  mode = 'delay'; await refresh.click()
  await page.getByText('正在读取提交历史…', { exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.world-vscode-git-refresh').disabled)
  assert.equal(typeof release, 'function')
  mode = 'normal'
  await page.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
  await page.locator('.world-vscode-picker').getByRole('button', { name: '浏览系统文件夹', exact: true }).click()
  await page.locator('.world-vscode-picker').getByRole('button', { name: '打开', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-status-root')?.textContent.includes('src'))
  await page.waitForFunction(() => document.querySelector('.world-vscode-git-history-row')?.textContent.includes('子目录提交'))
  release({ ok: true, value: { commits: [{ ...commit, subject: '旧目录响应不应出现' }], truncated: false } })
  // A browser round trip allows the delayed binding to settle without sleeping.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.match(await row.innerText(), /子目录提交/u)
  assert.equal(await page.getByText('旧目录响应不应出现').count(), 0)
  await page.setViewportSize({ width: 360, height: 640 })
  await page.getByRole('button', { name: '视图菜单', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /源代码管理/u }).click()
  await row.waitFor()
  assert.equal(await row.evaluate(node => node.getBoundingClientRect().height), 38)
  await row.click()
  assert.ok(await detail.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'hash and body wrap on phone')
  await page.screenshot({ path: join(shots, 'phone.png') })
  assert.deepEqual(errors, [])
  console.log('Git history passed: two-level keyboard folding, literal multiline details, empty/error/retry, stale-root rejection, desktop 24px/12px and phone 38px rows. Screenshots: ' + shots)
} finally { await page.close(); await browser.close() }
