import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..'), out = join(root, 'tmp/performance')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
// Count React file row construction, not DOM mutations (React often reuses the DOM).
const bundle = await build({ stdin: { resolveDir: root, contents: `import React from 'react'
  const create = React.createElement
  React.createElement = function(type, props) {
    if (type === 'div' && props?.['data-git-path'] && window.gitRows) window.gitRows[props['data-git-staged']]++
    return create.apply(this, arguments)
  }
  import('./tests/browser-entry.js')` }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' }, nodePaths: [join(root, '../workflow-studio/node_modules')] })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/git-compose', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{height:100vh;width:100vw}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>' }))
  await page.goto('http://127.0.0.1/git-compose')
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', '["vscode"]')
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldBrainCall = () => ({ sessionId: 'session-1', setupRequired: false })
    const files = Array.from({ length: 400 }, (_, i) => {
      const path = `src/module-${i % 10}/file-${i}.js`, staged = i < 100
      return { path, open: path, index: staged ? 'M' : ' ', worktree: staged ? ' ' : 'M', staged, unstaged: !staged }
    })
    const status = { repo: true, root: '/workspace', branch: 'main', files, identity: { ok: true } }
    window.__worldGitCall = async (op, payload) => {
      if (op === 'status') return { ok: true, value: status }
      if (op === 'log') return { ok: true, value: { commits: [] } }
      if (op === 'commit') {
        window.sentMessage = payload.message
        await new Promise(resolve => { window.finishCommit = resolve })
        return { ok: true, value: { status, output: 'commit acknowledged' } }
      }
      throw Error('Unexpected fixture operation: ' + op)
    }
    window.gitRows = { true: 0, false: 0 }
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('.world-vscode-window'), git = editor.getByRole('button', { name:'源代码管理', exact:true })
  await git.click(); await page.waitForFunction(() => document.querySelectorAll('[data-git-path]').length === 400)
  const first = await page.evaluate(() => window.gitRows)
  assert.ok(first.true >= 100 && first.false >= 300, 'row instrumentation sees both groups mount')
  const message = editor.getByRole('textbox', { name:'提交信息' }), submit = editor.locator('.world-vscode-git-primary')
  const text = 'test commit with changes'
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
  const scriptMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ScriptDuration').value * 1000
  const type = async () => { await message.pressSequentially(text); assert.equal(await message.inputValue(), text) }
  await page.evaluate(() => { window.gitRows = null }); await type()
  const samples = []
  for (let i = 0; i < 5; i++) { await message.fill(''); const start = await scriptMs(); await type(); samples.push(await scriptMs() - start) }
  await message.fill(''); assert.equal(await submit.isDisabled(), true)
  await page.evaluate(() => { window.gitRows = { true: 0, false: 0 } }); await type()
  const rows = await page.evaluate(() => { const c = window.gitRows; window.gitRows = null; return c })
  const result = { files:400, keys:text.length, stagedRowRenders:rows.true, unstagedRowRenders:rows.false, medianScriptMs:Math.round(samples.sort((a,b)=>a-b)[2]) }
  console.log('Git commit message:', JSON.stringify(result))
  await mkdir(out, {recursive:true}); await editor.screenshot({path:join(out,'git-compose.png')})
  await writeFile(join(out,'git-compose.json'), JSON.stringify(result,null,2)+'\n')
  // Switching away unmounts the form. A later commit receipt may clear only the message it sent.
  await editor.getByRole('button', { name:'资源管理器', exact:true }).click(); await message.waitFor({state:'detached'})
  await git.click(); assert.equal(await message.inputValue(), text)
  await message.press('Control+Enter'); await page.waitForFunction(() => !!window.finishCommit)
  await message.fill('next draft'); await page.evaluate(() => window.finishCommit())
  await editor.getByRole('status').filter({hasText:'commit acknowledged'}).waitFor()
  assert.equal(await page.evaluate(() => window.sentMessage), text); assert.equal(await message.inputValue(), 'next draft')
  await page.evaluate(() => { window.finishCommit = null }); await submit.click(); await page.waitForFunction(() => !!window.finishCommit)
  await page.evaluate(() => window.finishCommit()); await page.waitForFunction(() => document.querySelector('.world-vscode-git-message').value === '')
  assert.deepEqual(errors, []); assert.deepEqual(rows, {true:0, false:0}, 'editing the message must not rebuild the unchanged change tree')
} finally { await browser.close() }
