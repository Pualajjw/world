import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 别的插件挂上来的目录：IMA 知识库、PowerBuilder 的 .pbt / .exe 工程。
 * 这里用假宿主验证两件事——侧栏里能看见并选得到，选中后根真的切过去。
 */
const IMA = 'C:/ima/knowledge.workspace'
const PBT_ROOT = 'E:/pb/tj.workspace'
const EXE_ROOT = 'E:/pb/tj.pbd.workspace'

const scan = {
  ima: { available: true, path: IMA, label: 'IMA', error: '' },
  projects: [
    { id: 'pbnpm-pbd:E:/pb/tj.pbt', plugin: 'pbnpm-pbd', kind: 'pbt', name: 'tj.pbt', root: PBT_ROOT, pbtPath: 'E:/pb/tj.pbt', pbVersion: 90, libraries: 26 },
    { id: 'pbnpm-pbd:E:/pb/tj.exe', plugin: 'pbnpm-pbd', kind: 'exe', name: 'tj.exe', root: EXE_ROOT, pbtPath: 'E:/pb/tj.exe', pbVersion: 90, libraries: 26 },
  ],
  tools: [{ name: 'pbnpm', dir: 'C:/plugins/dsh-pbnpm/bin', exe: 'C:/plugins/dsh-pbnpm/bin/pbnpm.exe' }],
  truncated: false,
}

const listing = (path, entries) => ({ ok: true, value: { path, parent: '', entries, truncated: false } })

const workspaceList = payload => {
  if (payload.path === '/workspace') return listing('/workspace', [
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file' },
    { name: 'tj.exe', type: 'file' },
  ])
  if (payload.path === IMA) return listing(IMA, [
    { name: 'knowledge-bases', type: 'directory' },
    { name: 'notes', type: 'directory' },
    { name: '.ima-recent.md', type: 'file' },
  ])
  if (payload.path === PBT_ROOT) return listing(PBT_ROOT, [
    { name: 'tj.pbl', type: 'directory' },
    { name: 'utils.pbl', type: 'directory' },
    { name: 'w_main.srw', type: 'file' },
  ])
  if (payload.path === PBT_ROOT + '/utils.pbl') return listing(payload.path, [{ name: 'u_service.sru', type: 'file' }])
  if ([PBT_ROOT + '/tj.pbl', EXE_ROOT + '/tj.exe.pbd'].includes(payload.path)) {
    const files = ['w_order.srw','d_order.srd','f_order.srf','startup.sra'].map(name => ({name, type:'file'}))
    return {ok:true, value:{path:payload.path, parent:'', entries:files, recentObjects: [files[1],files[0]]}}
  }
  if (payload.path === EXE_ROOT) return listing(EXE_ROOT, [
    { name: 'tj.exe.pbd', type: 'directory' },
    { name: 'w_main.srw', type: 'file' },
  ])
  return listing(String(payload.path || ''), [])
}

export async function checkPluginRoots(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const opened = []
  try {
    const actions = [], results = new Map()
    await page.exposeBinding('__worldPbAction', (_source, op, payload) => {
      if (op === 'status') return results.get(payload.root) || null
      actions.push({op, ...payload}); const result = { action: op, running: false, output: 'demo.exe',
        diagnostics: {id: `test-${actions.length}`, spawned:true, temp:'private', exitCode:0, elapsedMs:23} }
      results.set(payload.root, result); return result
    })
    const indexReads = []
    let finishFirstIndex
    const firstIndex = new Promise(resolve => { finishFirstIndex = resolve })
    await page.exposeBinding('__worldRootsCall', async (_src, op, {root}) => {
      if (op === 'objects') {
        indexReads.push(root)
        if (indexReads.length === 1) await firstIndex
        return { libraries: root === PBT_ROOT ? [['tj.pbl', ['W_HOME.srw', 'w_home.srs', 'w_home2.sru']],
          ['utils.pbl', ['w_home.srs']]] : [['tj.exe.pbd', [['w_home.srf', 'w_home.fun'], ['w_home.srw', 'w_home.win']]]], skipped: [] }
      }
      const p = scan.projects.find(p => p.root === root)
      return {...scan, currentProject: p && {...p, libraryNames: p.kind === 'exe' ? ['tj.exe.pbd'] : ['tj.pbl', 'utils.pbl']}}
    })
    await page.exposeBinding('__worldWorkspaceList', async (_source, payload) => workspaceList(payload))
    await page.exposeBinding('__worldPbdCall', async (_source, operation, payload) => {
      if (operation === 'application') return { ok: true, value: { library: payload.root === EXE_ROOT ? 'tj.exe.pbd' : 'tj.pbl', name: 'startup.sra' } }
      opened.push(payload?.path)
      const target = String(payload?.path || '').toLowerCase()
      if (!target.endsWith('.pbt') && !target.endsWith('.exe')) {
        return { ok: false, error: { code: 'pbnpm-pbd/project', message: '所选文件不是 PBT 或 EXE' } }
      }
      const root = target.endsWith('.exe') ? EXE_ROOT : PBT_ROOT
      return { ok: true, value: { path: root, pbtPath: payload.path, pbVersion: 90, libraries: [] } }
    })
    await page.route('http://127.0.0.1/world-roots-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-roots-fixture')
    const themeCss = await readFile(join(process.env.WORLD_DSH_SOURCE || 'E:/deepseek-harness',
      'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
    await page.addStyleTag({ content: themeCss })
    await page.addScriptTag({ content: bundleText })

    // VSCode 是可选应用：先从开始菜单装上，再打开窗口
    await page.locator('.world-start-button').click()
    const card = page.locator('[data-world-app-card="vscode"]')
    await card.waitFor()
    const install = card.locator('.world-app-install')
    if (await install.count()) await install.first().click()
    const open = card.locator('.world-app-open')
    await open.waitFor()
    await open.first().click()
    await page.locator('.world-vscode-window').waitFor()
    // 侧栏默认是资源管理器、默认展开；只有上一次的状态把它收起了才需要展开
    if (!(await page.locator('.world-vscode-sidebar').count())) {
      await page.getByRole('button', { name: '展开侧栏' }).click()
    }
    await page.waitForSelector('.world-vscode-explorer-list')

    const fileNames = () => page.locator('.world-vscode-file-name').allTextContents()

    assert.equal(await page.getByRole('button', {name:'运行', exact:true}).count(), 0)
    assert.equal(await page.locator('.world-vscode-window').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {key:'F5',bubbles:true,cancelable:true}))), true)
    // 1. 侧栏的「插件位置」：IMA 与两个 PowerBuilder 工程都在
    const roots = page.locator('.world-vscode-roots')
    await roots.waitFor()
    assert.equal(await roots.locator('.world-vscode-roots-head').textContent(), '插件位置')
    const entries = await roots.locator('.world-vscode-root-entry .world-vscode-file-name').allTextContents()
    assert.deepEqual(entries, ['IMA', 'tj.pbt', 'tj.exe'])
    assert.match(await roots.locator('.world-vscode-root-entry').nth(1).textContent(), /PB90 · 26库/u)

    // 2. 树里的 .exe 是工程入口，不是普通二进制文件
    const treeExe = page.locator('.world-vscode-file.is-project')
    assert.equal(await treeExe.count(), 1)
    assert.equal(await treeExe.locator('.world-vscode-file-icon.is-pb').count(), 1)

    // 3. 点 IMA：根切到云端工作区，树里换成知识库/笔记
    await roots.locator('.world-vscode-root-entry').first().click()
    await page.waitForFunction(root => (document.querySelector('.world-vscode-status-root')?.title || '').includes(root), IMA)
    await page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-file-name')].some(node => node.textContent === 'notes'))
    assert.ok((await fileNames()).includes('knowledge-bases'))
    // 当前所在的位置高亮出来，避免「到底打开了哪个」要靠记忆
    assert.equal(await roots.locator('.world-vscode-root-entry.is-current').count(), 1)

    // 4. 打开文件夹对话框里也有同一份快捷入口，点一行就切过去
    await page.locator('.world-vscode-sidebar-act[title="打开文件夹"]').click()
    const picker = page.locator('.world-vscode-picker')
    await picker.waitFor()
    assert.equal(await picker.locator('.world-vscode-picker-root').count(), 3)
    await picker.locator('.world-vscode-picker-root').filter({ hasText: 'tj.pbt' }).click()
    await page.waitForFunction(root => (document.querySelector('.world-vscode-status-root')?.title || '').includes(root), PBT_ROOT)
    await page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-file-name')].some(node => node.textContent === 'tj.pbl'))
    assert.deepEqual(opened, [], '选择已登记的工程不该再走一次解析')

    const btn = name => page.getByRole('button', {name, exact: true})
    const app = btn('应用程序 · startup.sra')
    const tree = page.locator('.world-vscode-explorer-list')
    await page.evaluate(() => {
      const saved = new Map()
      window.__worldSourceSave = async ({path, source, version}) => {
        const prev = saved.get(path)?.version || 'v1'
        if (prev !== version || window.rejectNextSave) {
          window.rejectNextSave = false; return {ok:false,error:{message:'SRA version conflict'}}
        }
        const value = {path, source, version:`v${Number(prev.slice(1)) + 1}`,eol:'LF',encoding:'UTF-8'}
        saved.set(path, value); return {ok:true,value}
      }
      window.__worldSourceOpen = async ({path}) => ({ok:true,value:saved.get(path) || {path, source: path.endsWith('.sra')
      ? 'global type startup from application\nstring appname = "startup"\nend type\nglobal variables\nstring gs_app\n// second declaration\nlong gl_count\nend variables\ntype prototypes\nfunction long AppTick() library "clock.dll"\nsubroutine AppReset() library "clock.dll"\nend prototypes\nevent open;\nopen(w_home)\n' + (path.includes('tj.exe.pbd/') ? '// W_HOME.WIN\n// w_home.srf\n' : '') + 'end event'
      : path.endsWith('.sru') ? 'global type u_service from nonvisualobject\nend type'
      : path.endsWith('.srw') ? 'global type w from window\nend type\nglobal variables\ninteger gi_window\nend variables\ntype prototypes\nglobal function long WindowGlobal() library "clock.dll"\nfunction long WindowTick() library "clock.dll"\nend prototypes' : '', version:'v1',eol:'LF',encoding:'UTF-8',readOnly:path.includes('tj.exe.pbd/')}}) })
    const checkApp = async lib => {
      await app.waitFor()
      assert.equal(await tree.locator('.world-vscode-file').first().getAttribute('aria-label'), '应用程序 · startup.sra')
      await app.click()
      const panes = page.locator('.world-srw-panes')
      await panes.locator('[data-srw-view="script"]').getByText('open(w_home)', {exact:true}).waitFor()
      assert.equal(await panes.getByText('Layout', {exact:true}).count(), 0)
      assert.equal(await panes.locator('[data-srw-view="properties"] input[aria-label="AutoInstantiate"]').count(), 0)
      assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(c => c.method === 'world-vscode-source/open').at(-1).payload.path), `${lib}/startup.sra`)
    }
    await checkApp(PBT_ROOT + '/tj.pbl')
    const rightClickScript = async (word, row = 'open(w_home)') => {
      const line = page.locator('[data-srw-view=script]:visible .cm-line').filter({ hasText: row }).first()
      const point = await line.evaluate((node, word) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        let text
        while ((text = walker.nextNode())) {
          const i = text.data.indexOf(word); if (i < 0) continue
          const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1)
          const box = r.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]
        }
      }, word)
      await page.mouse.click(...point, { button: 'right' })
    }
    const objectMenu = async () => {
      await rightClickScript('w_home')
      await page.getByRole('menuitem', {name:/^打开 w_home/i}).first().waitFor()
      return page.getByRole('menuitem')
    }
    assert.deepEqual(indexReads, [], 'no indexing just to open a project or a Script')
    await rightClickScript('open')
    await page.getByText('正在查找工程对象…').waitFor(); await page.keyboard.press('Escape')
    await rightClickScript('w_home'); finishFirstIndex()
    const menu = page.getByRole('menuitem')
    await menu.filter({ hasText: 'utils.pbl/w_home.srs' }).waitFor()
    const labels = await menu.allTextContents()
    assert.ok(labels.includes('复制'))
    assert.deepEqual(labels.slice(-3), ['打开 W_HOME（tj.pbl/W_HOME.srw）','打开 w_home（tj.pbl/w_home.srs）','打开 w_home（utils.pbl/w_home.srs）'])
    await page.keyboard.press('Escape')
    await rightClickScript('open'); assert.equal(await menu.count(), 0, 'an unknown word keeps the native menu')
    await rightClickScript(')'); assert.equal(await menu.count(), 0, 'punctuation is not its neighbour')
    await objectMenu()
    assert.deepEqual(indexReads, [PBT_ROOT], 'repeat lookups use the name index')
    await menu.last().click()
    await page.waitForFunction(path => window.__worldTesting.calls.some(c => c.method === 'world-vscode-source/open' && c.payload.path === path), `${PBT_ROOT}/utils.pbl/w_home.srs`)
    await app.click()
    if (process.env.WORLD_SRA_SHOT) await page.locator('.world-vscode-window').screenshot({ path: process.env.WORLD_SRA_SHOT })
    const script = page.locator('[data-srw-view=script] .cm-content')
    await script.fill('open(w_changed)')
    await btn('tj.pbl').click()
    await btn('应用程序').click(); await btn('startup.sra').click()
    assert.equal(await page.locator('[data-parent-tab]').count(), 1, 'shortcut and library entry share the design group')
    assert.equal(await script.innerText(), 'open(w_changed)')
    await btn('保存').click()
    const save = await page.evaluate(() => window.__worldTesting.calls.find(c => c.method === 'world-vscode-source/save').payload)
    assert.equal(save.path, `${PBT_ROOT}/tj.pbl/startup.sra`); assert.match(save.source, /event open;\nopen\(w_changed\)\nend event/)
    const variables = page.locator('[data-srw-view=variables]:visible')
    const openVars = async () => page.locator('.world-srw-panes:visible').getByRole('tab', {name:'Variables'}).click()
    await openVars(); await variables.getByRole('button', {name:'Global External', exact:true}).click()
    assert.match(await variables.getByLabel('编辑 Global External Functions').innerText(), /AppTick/)
    await variables.getByRole('button', {name:'Local External', exact:true}).click()
    assert.equal(await variables.locator('.cm-content').count(), 0)

    await btn('w_main.srw').click(); await openVars()
    await variables.getByRole('button', {name:'Global', exact:true}).click()
    const appVars = variables.getByLabel('startup.sra · Global Variables')
    const assertOnlySra = async (box, expected) => {
      assert.equal(await box.innerText(), expected)
      assert.equal(await box.getAttribute('aria-readonly'), 'false')
      assert.equal(await variables.locator('.cm-content').count(), 1)
      assert.doesNotMatch(await variables.innerText(), /当前对象声明|gi_window|WindowGlobal|WindowTick/)
      const gap = await variables.evaluate(p => p.getBoundingClientRect().bottom - p.querySelector('.cm-scroller').getBoundingClientRect().bottom)
      assert.ok(Math.abs(gap) <= 1, `SRA editor bottom gap: ${gap}px`)
    }
    const expectedVars = 'string gs_app\n// second declaration\nlong gl_count'
    const expectedFunctions = 'function long AppTick() library "clock.dll"\nsubroutine AppReset() library "clock.dll"'
    await assertOnlySra(appVars, expectedVars)
    const changedVars = expectedVars + '\nstring gs_added'
    await appVars.fill(changedVars); await appVars.press('Control+s')
    const lastSave = () => page.evaluate(() => window.__worldTesting.calls.filter(c => c.method === 'world-vscode-source/save').at(-1).payload)
    await page.waitForFunction(() => window.__worldTesting.calls.some(c => c.method === 'world-vscode-source/save' && c.payload.source.includes('gs_added')))
    const varSave = await lastSave()
    assert.equal(varSave.path, save.path); assert.equal(varSave.version, 'v2')
    assert.equal(varSave.source, save.source.replace(expectedVars, changedVars)); assert.ok(varSave.spans?.length)
    if (process.env.WORLD_SRA_GLOBALS_SHOT) await variables.screenshot({ path: process.env.WORLD_SRA_GLOBALS_SHOT })
    await variables.getByRole('button', {name:'Global External', exact:true}).click()
    const appFunctions = variables.getByLabel('startup.sra · Global External Functions')
    await assertOnlySra(appFunctions, expectedFunctions)
    await variables.getByRole('button', {name:'Local External', exact:true}).click()
    assert.match(await variables.innerText(), /WindowTick/); assert.doesNotMatch(await variables.innerText(), /AppTick/)
    await variables.getByLabel('编辑 Local External Functions').fill('function long WindowTick2() library "clock.dll"')
    await btn('保存').click()
    const savedWindow = await page.evaluate(() => window.__worldTesting.calls.filter(c => c.method === 'world-vscode-source/save').at(-1).payload)
    assert.equal(savedWindow.path, `${PBT_ROOT}/w_main.srw`)
    assert.match(savedWindow.source, /WindowTick2/); assert.match(savedWindow.source, /gi_window/); assert.match(savedWindow.source, /WindowGlobal/)
    assert.doesNotMatch(savedWindow.source, /gs_app|AppTick/)
    await btn('utils.pbl').click(); await btn('用户对象').click(); await btn('u_service.sru').click()
    await openVars(); await variables.getByRole('button', {name:'Global', exact:true}).click()
    await assertOnlySra(appVars, changedVars)
    await variables.getByRole('button', {name:'Global External', exact:true}).click()
    await assertOnlySra(appFunctions, expectedFunctions)
    const changedFns = expectedFunctions.replace('AppReset', 'AppResetAll')
    await appFunctions.fill(changedFns)
    await page.evaluate(() => { window.rejectNextSave = true }); await btn('保存').click()
    await page.getByText('SRA version conflict', {exact:true}).first().waitFor()
    assert.equal(await appFunctions.innerText(), changedFns)
    await variables.getByRole('button', {name:'Global', exact:true}).click(); await btn('保存').click()
    const fnSave = await lastSave()
    assert.equal(fnSave.path, save.path); assert.equal(fnSave.version, 'v3')
    assert.equal(fnSave.source, varSave.source.replace(expectedFunctions, changedFns)); assert.ok(fnSave.spans?.length)
    await variables.getByRole('button', {name:'Global External', exact:true}).click(); await assertOnlySra(appFunctions, changedFns)
    if (process.env.WORLD_SRU_GLOBAL_EXTERNAL_SHOT) await variables.screenshot({ path: process.env.WORLD_SRU_GLOBAL_EXTERNAL_SHOT })
    await btn('utils.pbl').click()
    await btn('应用程序').click()
    await btn('最近修改').click()
    assert.ok(await btn('d_order.srd').isVisible()); assert.ok(await btn('w_order.srw').isVisible())
    await btn('最近修改').click()
    await btn('窗口').click()
    await btn('w_order.srw').click()
    await page.waitForFunction(() => window.__worldTesting.calls.some(c => c.method === 'world-vscode-source/open' && c.payload.path.endsWith('/tj.pbl/w_order.srw')))
    const activeFiles = tree.locator('.world-vscode-file.selected .world-vscode-file-name')
    await page.locator('[data-srw-view=layout]:visible').waitFor()
    assert.deepEqual(await activeFiles.allTextContents(), ['w_order.srw'], 'Layout selects its SRW in the PBT explorer')
    await openVars(); await variables.waitFor()
    assert.deepEqual(await activeFiles.allTextContents(), ['w_order.srw'], 'switching design views keeps the owning file selected')
    assert.equal(await btn('其他').count(), 0)
    await btn('全局函数').click()
    await btn('f_order.srf').click()
    const input = page.locator('.world-vscode-textarea:visible').last()
    assert.deepEqual(await activeFiles.allTextContents(), ['f_order.srf'], 'opening another file moves the explorer selection')
    const original = await input.inputValue()
    await input.fill('// unsaved')
    await input.press('F5')
    await page.getByRole('alertdialog').getByRole('button', {name:'取消'}).click()
    assert.equal(actions.length, 0, 'cancelled dirty run never reaches the host')
    assert.equal(await input.inputValue(), '// unsaved')
    await input.fill(original)
    await btn('资源管理器').click()
    await btn('运行').click()
    assert.equal(actions.length, 0, 'opening the run panel must never launch a program')
    await btn('运行项目 (F5)').click()
    await page.getByText('程序已退出。', {exact:true}).waitFor()
    await page.keyboard.press('F5')
    await page.waitForFunction(() => window.__worldTesting.calls.filter(c => c.method === 'world-vscode-pb/run').length === 2)
    await page.locator('.world-vscode-pb-panel summary').click()
    await btn('开始打包').click()
    await page.getByText('已生成：demo.exe', {exact:true}).waitFor()
    assert.deepEqual(actions.map(item => [item.op, item.root]), [['run',PBT_ROOT],['run',PBT_ROOT],['build',PBT_ROOT]])
    await btn('资源管理器').click()

    // 5. 回工作区，点树里的 tj.exe：交给 pbnpm-pbd 打开，然后跟到它的 workspace
    await page.locator('.world-vscode-sidebar-act[title="打开文件夹"]').click()
    await picker.locator('.world-vscode-picker-input').fill('/workspace')
    await picker.locator('.world-vscode-picker-input').press('Enter')
    await page.waitForFunction(() => document.querySelector('.world-vscode-picker-input')?.value === '/workspace')
    await picker.getByRole('button', { name: '打开', exact: true }).click()
    await page.waitForFunction(() => (document.querySelector('.world-vscode-status-root')?.title || '').includes('/workspace'))
    await page.locator('.world-vscode-file.is-project').click()
    await page.waitForFunction(root => (document.querySelector('.world-vscode-status-root')?.title || '').includes(root), EXE_ROOT, { timeout: 10000 })
    assert.deepEqual(opened, ['/workspace/tj.exe'])
    await page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-file-name')].some(node => node.textContent === 'tj.exe.pbd'))

    await checkApp(EXE_ROOT + '/tj.exe.pbd')
    const exeMenu = await objectMenu()
    assert.deepEqual((await exeMenu.allTextContents()).slice(-2), ['打开 w_home（tj.exe.pbd/w_home.srf）', '打开 w_home（tj.exe.pbd/w_home.srw）'])
    assert.ok((await exeMenu.allTextContents()).includes('切换回源代码'), 'read-only scripts retain their design menu')
    await page.keyboard.press('Escape')
    for (const [row, glyph, target] of [['W_HOME.WIN','W_HOME','w_home.srw'], ['w_home.srf','srf','w_home.srf'], ['W_HOME.WIN','WIN','w_home.srw']]) {
      await rightClickScript(glyph, row)
      const link = page.getByRole('menuitem', {name:'打开 w_home', exact:true})
      await link.waitFor()
      assert.equal(await link.getAttribute('title'), `tj.exe.pbd/${target}`)
      if (glyph === 'WIN') {
        await link.click()
        await page.waitForFunction(path => window.__worldTesting.calls.some(c => c.method === 'world-vscode-source/open' && c.payload.path === path), `${EXE_ROOT}/tj.exe.pbd/w_home.srw`)
      } else await page.keyboard.press('Escape')
    }
    assert.equal(indexReads.filter(root => root === EXE_ROOT).length, 1)
    await btn('运行').click()
    assert.equal(await btn('打包 EXE').isDisabled(), true)
    await page.keyboard.press('F5')
    await page.getByText('程序已退出。', {exact:true}).waitFor()
    assert.equal(actions.at(-1).root, EXE_ROOT)
    await btn('资源管理器').click(); await btn('tj.exe.pbd').click()
    await btn('数据窗口').click(); assert.ok(await btn('d_order.srd').isVisible()); await btn('数据窗口').click()
    await btn('最近修改').click(); await btn('w_order.srw').waitFor()
    const gitCalls = [], bound = '/separate-repo'
    await page.exposeBinding('__worldGitCall', (_ctx, op, request) => {
      gitCalls.push([op,request.root]); const repo = request.root === bound
      return {ok:true,value:op === 'status' ? {repo, root:repo ? bound : '', branch:'bound-test', files:repo ? [{path:'actual.txt',open:'actual.txt',index:' ',worktree:'M',unstaged:true}] : []}
        : op === 'log' ? {commits:[]} : {patch:''}}
    })
    await btn('源代码管理').click(); await btn('刷新 Git 状态').click(); await btn('选择 Git 文件夹').click()
    const dialog = page.getByRole('dialog',{name:'选择 Git 文件夹'}), gitInput = dialog.getByLabel('文件夹路径')
    await gitInput.fill('/not-a-repo'); await dialog.getByRole('button',{name:'绑定 Git 目录'}).click()
    await dialog.getByText('所选文件夹不在 Git 仓库中。').waitFor()
    await gitInput.fill(bound); await gitInput.press('Enter'); await dialog.getByRole('button',{name:'绑定 Git 目录'}).click()
    await page.locator('.world-vscode-git-branch-name').filter({hasText:'bound-test'}).waitFor()
    assert.ok((await page.locator('.world-vscode-status-root').getAttribute('title')).includes(EXE_ROOT))
    await page.locator('[data-git-path="actual.txt"]').dblclick()
    await page.waitForFunction(root => window.__worldTesting.calls.some(c => c.method==='world-vscode-source/open' && c.payload.root===root && c.payload.path===root+'/actual.txt'),bound)
    assert.ok(gitCalls.some(([op,root])=>op==='diff' && root===bound))
    assert.ok(gitCalls.every(([op])=>['status','log','diff'].includes(op)), JSON.stringify(gitCalls))
    await btn('解除绑定').click(); await btn('选择 Git 文件夹').waitFor()

    // Inspect a PB trace captured *before* the log window opened; copy includes stages hidden by filters.
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-debug-log"] .world-app-open').click()
    const logs = page.getByRole('region',{name:'调试日志',exact:true})
    await logs.getByLabel('全部应用').selectOption('PB')
    await logs.getByLabel('日志关键词').fill('退出码')
    await logs.getByText('任务结束 · 退出码 0').first().waitFor()
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async s=>{ window.copiedWorldLog=s }}}))
    await logs.locator('tbody button').first().click()
    const copied = await page.evaluate(() => window.copiedWorldLog)
    assert.match(copied,/运行项目（F5）/u); assert.match(copied,/启动 PB worker/u); assert.match(copied,/使用任务专用临时目录/u)
    assert.ok(!copied.includes(EXE_ROOT)); assert.ok(!copied.includes('demo.exe'))
    console.log('Debug log: start-menu window, filtered PB trace and copy passed.', await logs.evaluate(n=>({width:n.clientWidth,height:n.clientHeight})))
    assert.deepEqual(errors, [])
    console.log('VSCode plugin roots passed: IMA entry, PBT/EXE projects, picker shortcuts, .exe opened as a project.')
  } finally {
    await page.close()
  }
}
