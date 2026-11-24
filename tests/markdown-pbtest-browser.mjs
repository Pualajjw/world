import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [resolve(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = [], requests = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/pbtest', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}#root,.app-frame{height:100vh}</style><div id="root"><div class="app-frame"><main></main><div data-shell-overlay id="overlay-root"></div></div></div>' }))
  await page.goto('http://127.0.0.1/pbtest')
  const guides = {}
  for (const name of ['pbnpm-cspb-正则表达式.md', 'pbnpm-test-C实现分工与接口规范.md']) {
    try { guides[name] = (await readFile(resolve(root, '../../../docs', name), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  await page.evaluate(guides => {
    localStorage.setItem('dsh.world.apps', '["vscode"]')
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldWorkspaceList = ({path}) => ({ok:true,value:{path,entries:['README.md','big.txt','plain.pbtest','shared.md','long.md', ...Object.keys(guides)].map(name=>({name,type:'file'}))}})
    window.fixture = '# 教程\n```pbtest\nsubroutine test_a()\nif true then\nmessagebox("test", "hidden")\nend if\nend subroutine\n```\n## 附注\n子章节正文\n# 附录\n仍然可见'
    window.fixture = window.fixture.replace('subroutine test_a()', 'subroutine test_a() // ' + 'long comment '.repeat(30))
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source:guides[path.split('/').pop()] ?? (path.endsWith('long.md') ? '# Large\n' + 'line\n'.repeat(5000) : path.endsWith('shared.md') ? '# 示例\n```pbtest:shared\ninteger gi_counter\n```' : path.endsWith('.md') ? window.fixture : path.endsWith('plain.pbtest') ? 'subroutine test_simple()\nreturn\nend subroutine' : 'alpha\nbeta\ngamma\ndelta'),version:'v1',encoding:'UTF-8'}})
    window.__worldSourceSave = async p => { window.savedText = p.source; return {ok:true,value:{source:p.source,version:'v2',encoding:'UTF-8'}} }
  }, guides)
  await page.exposeBinding('__worldTerminalCall', (_, op, payload) => {
    if (op === 'pbtest') { requests.push(payload); return { ok: true, value: { jobId: 'test' } } }
    if (op === 'poll') return { ok: true, value: { chunk: '[FAIL] test_a', running: false, exitCode: 1 } }
    throw new Error(op)
  })
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const ui = page.locator('[data-world-vscode-key]'), button = (name, scope = ui) => scope.getByRole('button', { name, exact:true })
  // Compare rectangle centres with the first visual row (even when the line wraps).
  const geometry = async (scope, line, text, label) => {
    const measured = await scope.evaluate((el, {line,text,label}) => {
      const cm = el.querySelector('.cm-content'), rect = n => n?.getBoundingClientRect()
      const run = el.querySelector(`.world-vscode-gutter-test[aria-label="${label}"]`)
      const numbers = el.querySelectorAll(cm ? '.cm-lineNumbers .cm-gutterElement' : '.world-vscode-row-number')
      const num = [...numbers].find(n => n.textContent === String(line) && getComputedStyle(n).visibility !== 'hidden')
      const row = [...el.querySelectorAll(cm ? '.cm-line' : '.world-vscode-hl-line')].find(n => n.textContent.includes(text))
      const nr = rect(num), rr = rect(row), btn = [...el.querySelectorAll('.world-vscode-fold-arrow')].find(n => Math.abs(rect(n).top - rr.top) < 1 && getComputedStyle(n).visibility !== 'hidden')
      const br = rect(btn), tr = rect(run), font = getComputedStyle(row)
      return {height:rr.height,font:parseFloat(font.fontSize), icon:parseFloat(getComputedStyle(btn,'::before').width), hit:[br.width,br.height],
        order: tr.right <= nr.left + .1 && nr.right <= br.left + .1 && br.right <= rr.left + .1,
        dy:(br.top + br.height/2) - (rr.top + parseFloat(font.lineHeight)/2)}
    }, {line,text,label})
    assert.equal(measured.icon, measured.font); assert.equal(measured.hit[0], measured.hit[1]); assert.ok(measured.order)
    assert.ok(Math.abs(measured.dy) < 1, JSON.stringify(measured)); return measured
  }
  await button('README.md').dblclick()
  await ui.locator('.world-vscode-tok-fn').filter({hasText:'test_a'}).waitFor()
  const arrow = ui.getByTitle('折叠第 1 行代码块') // Native gutter, before switching to CodeMirror.
  await arrow.waitFor()
  const caseGeometry = () => geometry(ui, 3, 'subroutine test_a()', '运行 test_a')
  await ui.locator('.world-vscode-status-wrap').click()
  const nativeCase = await caseGeometry(); assert.ok(nativeCase.height > nativeCase.hit[1]); console.log('Native gutter:', nativeCase)
  await ui.getByTitle('折叠第 4 行代码块').click()
  const folded = ui.locator('.cm-foldPlaceholder'), body = ui.locator('.cm-content')
  await folded.waitFor(); assert.ok(!(await body.innerText()).includes('hidden')); assert.match(await body.innerText(), /subroutine test_a/)
  const cmCase = await caseGeometry(); assert.ok(cmCase.height > cmCase.hit[1]); console.log('CodeMirror gutter:', cmCase)
  const resized = await page.addStyleTag({content:'.world-vscode-editor-content {--vscode-font-size: 17px !important;}'})
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-foldGutter .world-vscode-fold-arrow'),'::before').width === '17px')
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  assert.equal((await caseGeometry()).icon,17); await resized.evaluate(n => n.remove())
  // Fold the parent around an already folded IF; the sibling heading stays on screen.
  await ui.locator('.cm-foldGutter [title="折叠代码块"]:visible').first().click()
  assert.match(await body.innerText(), /# 教程/); assert.match(await body.innerText(), /仍然可见/)
  assert.doesNotMatch(await body.innerText(), /附注|subroutine test_a/)
  const out = resolve(root, 'tmp/folding'); await mkdir(out, {recursive:true})
  await ui.screenshot({path:resolve(out,'markdown-heading.png')})
  await button('big.txt').dblclick()
  const txt = ui.getByLabel('编辑 big.txt', {exact:true})
  await txt.evaluate(node => { node.focus(); node.setSelectionRange(6,16); node.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true})) })
  await ui.getByRole('menuitem',{name:'折叠选中文本'}).click(); await folded.waitFor()
  assert.ok(!(await body.innerText()).includes('beta')); await folded.click(); assert.match(await body.innerText(), /beta/)
  await button('plain.pbtest').dblclick()
  const plain = ui.getByLabel('编辑 plain.pbtest',{exact:true})
  await plain.press('Control+End'); await page.keyboard.insertText(' // before fold')
  await ui.getByTitle('折叠第 1 行代码块').click(); await folded.waitFor()
  assert.ok(!(await body.innerText()).includes('return')); await button('展开代码块').press('Enter'); assert.match(await body.innerText(), /end subroutine \/\/ before fold/)
  assert.equal(await ui.locator('.cm-lineNumbers').getAttribute('aria-hidden'),'true')
  await body.press('Control+z'); assert.doesNotMatch(await body.innerText(), /before fold/)
  await body.press('Control+y'); assert.match(await body.innerText(), /before fold/)
  await body.press('Control+End'); await page.keyboard.insertText(' and after')
  // Switching tabs suspends the CM view. Its compact history still spans both surfaces.
  await ui.getByRole('tab',{name:'big.txt'}).click(); await ui.getByRole('tab',{name:'plain.pbtest'}).click()
  await body.press('Control+z'); assert.match(await body.innerText(), /before fold/); assert.doesNotMatch(await body.innerText(), /and after/)
  await body.press('Control+z'); assert.doesNotMatch(await body.innerText(), /before fold/)
  await ui.getByRole('tab',{name:'plain.pbtest'}).click({button:'right'})
  await ui.getByRole('menuitem',{name:'切回文本编辑'}).click()
  await plain.press('Control+y'); assert.match(await plain.inputValue(), /before fold/)
  await plain.press('Control+z'); assert.doesNotMatch(await plain.inputValue(), /before fold/)
  await ui.getByRole('tab',{name:'README.md'}).click(); await folded.waitFor()
  assert.doesNotMatch(await body.innerText(), /附注|subroutine test_a/)
  await folded.click(); await folded.waitFor() // The inner IF is still folded.
  assert.match(await body.innerText(), /附注/); assert.match(await body.innerText(), /subroutine test_a/); assert.doesNotMatch(await body.innerText(), /hidden/)
  await ui.screenshot({path:resolve(out,'markdown-pbtest.png')})
  await button('运行 test_a').click()
  const output = ui.getByRole('region', { name: 'PBTest 输出' })
  await output.getByText('[FAIL] test_a').waitFor()
  assert.equal(requests[0].blockIndex, 1); assert.equal(requests[0].caseName, 'test_a'); assert.equal(requests[0].version, 'v1')
  assert.match(requests[0].path, /README\.md$/); assert.match(await output.innerText(), /退出码 1/)
  await button('关闭输出', output).click()
  await button('文件内单元测试').click()
  const panel = ui.getByRole('region', { name: '文件内单元测试' })
  await button('运行文件内全部测试', panel).click(); await output.getByText('[FAIL] test_a').waitFor()
  assert.equal(requests[1].blockIndex, undefined); assert.equal(requests[1].caseName, undefined)
  await button('关闭输出', output).click()
  await ui.getByRole('textbox', {name:'编辑 README.md'}).press('End'); await page.keyboard.insertText(' changed')
  assert.equal(await button('运行文件内全部测试', panel).isDisabled(), true)
  await ui.getByRole('textbox', {name:'编辑 README.md'}).press('Control+s')
  await page.waitForFunction(() => !!window.savedText)
  assert.equal(await page.evaluate(() => window.savedText.replace(' changed','') === window.fixture), true, 'save writes the hidden body too')
  await ui.getByRole('textbox', {name:'编辑 README.md'}).press('Control+Shift+e')
  await button('shared.md').dblclick(); const shared = ui.getByLabel('编辑 shared.md',{exact:true})
  await shared.waitFor(); assert.equal(await ui.locator('.world-vscode-gutter-test').count(),0)
  const runWidth = () => shared.evaluate(n => getComputedStyle(n.parentElement.querySelector('.world-vscode-gutter-row')).gridTemplateColumns.split(' ')[0])
  assert.equal(await runWidth(),'0px')
  await shared.fill('# 示例\n```pbtest\nsubroutine test_added()\nend subroutine\n```')
  await button('运行 test_added').waitFor(); assert.notEqual(await runWidth(),'0px')
  await shared.fill('# 示例\n无用例'); assert.equal(await runWidth(),'0px')
  // CodeMirror must also remove the *column* when a large Markdown draft loses its last test.
  await button('long.md').dblclick(); const long = ui.getByLabel('编辑 long.md',{exact:true}); await long.waitFor()
  const cmRuns = ui.locator('.world-vscode-run-gutter'); assert.equal(await cmRuns.count(),0)
  await long.fill('```pbtest\nsubroutine test_large()\nend subroutine\n```'); await button('运行 test_large').waitFor()
  assert.ok(await button('运行 test_large').isDisabled()); await long.fill('# Nothing'); await cmRuns.waitFor({state:'detached'})
  // A large Markdown without a run column must still expose keyboard/AT fold controls,
  // including on phones where even documents containing test cases omit the run gutter.
  await long.fill('# Phone heading\n```pbtest\nsubroutine test_phone()\nend subroutine\n```')
  await button('运行 test_phone').waitFor(); await page.setViewportSize({width:390,height:844})
  await ui.locator('.world-vscode-large.is-phone .cm-content[aria-label$="long.md"]').waitFor(); await cmRuns.waitFor({state:'detached'})
  await button('折叠代码块').first().press('Space'); await button('展开代码块').first().press('Enter')
  await page.setViewportSize({width:1440,height:960}); await button('运行 test_phone').waitFor()
  if (await ui.locator('.world-vscode-status-wrap').getAttribute('aria-pressed') === 'true') await ui.locator('.world-vscode-status-wrap').click()
  if (Object.keys(guides).length === 2) {
    const [withTests, withoutTests] = Object.keys(guides)
    await button(withTests).dblclick(); await button('运行代码块 1').waitFor()
    const guideText = ui.getByLabel(`编辑 ${withTests}`,{exact:true})
    const source = await guideText.inputValue(), line = source.split('\n').findIndex(l => l.startsWith('subroutine test_regex_valid')) + 1
    await guideText.evaluate((n,line) => { n.scrollTop = (line-2)*parseFloat(getComputedStyle(n).lineHeight) },line)
    await button('运行 test_regex_valid').waitFor()
    console.log('Regex guide:', await geometry(ui,line,'subroutine test_regex_valid','运行 test_regex_valid'))
    await ui.screenshot({path:resolve(out,'regex-run-column.png')})
    await button(withoutTests).dblclick(); const guide = ui.getByLabel(`编辑 ${withoutTests}`,{exact:true}); await guide.waitFor()
    assert.equal(await ui.locator('.world-vscode-gutter-test').count(),0)
    await ui.screenshot({path:resolve(out,'markdown-no-run-column.png')})
    // The inactive split still owns its run buttons; clicking runs that file, not its neighbour.
    const pane = ui.locator('.world-vscode-pane').filter({has:page.getByLabel(`编辑 ${withoutTests}`,{exact:true})}), box = await pane.boundingBox()
    await ui.getByRole('tab',{name:withTests}).dragTo(pane,{targetPosition:{x:box.width*.88, y:box.height/2}})
    await guide.waitFor(); await guide.click(); await guideText.waitFor()
    await guideText.evaluate(n => { n.scrollTop = 0 }); await button('运行代码块 1').click()
    await output.getByText('[FAIL] test_a').waitFor(); assert.ok(requests.at(-1).path.endsWith(withTests)); assert.equal(requests.at(-1).blockIndex,1)
  }
  assert.deepEqual(errors, [])
  console.log('PBTest browser: embedded colours, inline case, file action, failure output and unsaved guard passed.')
} finally { await browser.close() }
