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
    { name: 'w_main.srw', type: 'file' },
  ])
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
    await page.exposeBinding('__worldRootsCall', async () => scan)
    await page.exposeBinding('__worldWorkspaceList', async (_source, payload) => workspaceList(payload))
    await page.exposeBinding('__worldPbdCall', async (_source, operation, payload) => {
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

    assert.deepEqual(errors, [])
    console.log('VSCode plugin roots passed: IMA entry, PBT/EXE projects, picker shortcuts, .exe opened as a project.')
  } finally {
    await page.close()
  }
}
