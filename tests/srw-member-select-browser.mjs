import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..'), out = join(root, 'tmp/performance')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' }, nodePaths: [join(root, '../workflow-studio/node_modules')] })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://127.0.0.1/srw-members', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{width:100vw;height:100vh}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>' }))
  await page.goto('http://127.0.0.1/srw-members')
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', '["vscode"]')
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldBrainCall = () => ({ sessionId: 'session-1', setupRequired: false })
    const name = 'n_members.sru', source = 'global type n_members from nonvisualobject\nend type\non n_members.create\nreturn\nend on\n' +
      Array.from({ length: 600 }, (_, i) => `public function integer f_${i} ();return ${i}\nend function`).join('\n')
    window.__worldWorkspaceList = ({ path }) => ({ ok: true, value: { path, parent: '', entries: [{ name, type: 'file' }] } })
    window.__worldSourceOpen = async ({ path }) => ({ ok: true, value: { path, source, version: '1', eol: 'LF', encoding: 'UTF-8', readOnly: false } })
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  await page.getByRole('button', { name: 'n_members.sru', exact: true }).dblclick()
  const view = page.locator('[data-srw-view="script"]'), picker = view.getByLabel('事件或函数'), kind = view.getByLabel('脚本类别')
  const body = n => view.getByRole('textbox', { name: `编辑 n_members.f_${n}`, exact: true })
  await body(0).waitFor(); assert.equal(await picker.locator('option').count(), 600)
  // Measure full change -> new editor transactions. Count JS reads of the member
  // option values separately so instrumentation does not inflate the timed runs.
  const result = await picker.evaluate(async select => {
    const proto = HTMLOptionElement.prototype, desc = Object.getOwnPropertyDescriptor(proto, 'value')
    let reads = 0
    const run = async () => {
      const start = performance.now()
      for (let i = 0; i < 24; i++) {
        const n = i % 2 ? 575 : 599
        select.selectedIndex = n; select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve()
        const editor = select.closest('[data-srw-view]').querySelector('.cm-content')
        if (editor?.textContent !== `return ${n}` || select.title !== `public function integer f_${n} ()`) throw Error(`Wrong member at ${i}`)
      }
      return performance.now() - start
    }
    await run()
    const samples = []
    for (let i = 0; i < 5; i++) samples.push(await run())
    Object.defineProperty(proto, 'value', { ...desc, get() { if (this.parentNode === select) reads++; return desc.get.call(this) } })
    try { await run() } finally { Object.defineProperty(proto, 'value', desc) }
    return { members: select.length, switches: 24, optionValueReads: reads, medianMs: Math.round(samples.sort((a,b) => a-b)[2]) }
  })
  console.log('Script member selection:', JSON.stringify(result))
  await body(575).fill('return 98765')
  await picker.focus(); await picker.press('ArrowDown'); assert.equal(await body(576).innerText(), 'return 576')
  await picker.press('ArrowUp'); assert.equal(await body(575).innerText(), 'return 98765')
  await kind.selectOption('events'); assert.equal(await picker.locator('option').count(), 1)
  assert.equal(await picker.locator('option:checked').innerText(), 'on n_members.create')
  await kind.selectOption('functions'); assert.equal(await picker.locator('option').count(), 600)
  await picker.selectOption({ index: 575 }); assert.equal(await body(575).innerText(), 'return 98765')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'srw-member-select.json'), JSON.stringify(result, null, 2) + '\n')
  await page.locator('.world-vscode-window').screenshot({ path: join(out, 'srw-member-select.png') })
  assert.deepEqual(errors, [])
  assert.ok(result.optionValueReads <= result.switches * 2, 'switching members must not scan the entire native option list')
} finally { await browser.close() }
