import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createJournalStore } from '../journal.js'
import { createDesktopBridge } from '../desktop-bridge.js'
import { atomic } from './journal-fixture.mjs'
import { waitForDesktop } from '../desktop-client.js'

/** Actual diary/trash windows through the RPC boundary and a durable temporary store. */
export async function checkJournal(browser, bundleText, root) {
  const directory = await mkdtemp(join(tmpdir(), 'world-journal-ui-')), file = join(directory, 'journal.json')
  const journal = createJournalStore({ file, atomic }), other = createJournalStore({ file, atomic }), bridge = createDesktopBridge()
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  let loseNextWrite = true, holdNextWrite = false, failNextGet = false, releaseWrite
  page.on('pageerror', error => errors.push(error.message))
  // 日记只在开始菜单里：0.2.73 起桌面不再摆设置 / 日记 / 待办三个图标。
  const openDiary = async () => {
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-diary"] .world-app-open').click()
  }
  try {
    await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldJournalCall', async (_source, operation, payload) => {
      try {
        if (operation === 'get' && failNextGet) {
          failNextGet = false
          return { ok: false, error: { code: 'WORLD_DIARY_ACTION', message: '测试：读取连接暂时不可用。' } }
        }
        const value = await journal.call(operation, payload)
        if (operation === 'write' && loseNextWrite) {
          loseNextWrite = false
          return { ok: false, error: { code: 'WORLD_DIARY_ACTION', message: '测试：保存已提交，但响应丢失。' } }
        }
        if (operation === 'write' && holdNextWrite) {
          holdNextWrite = false
          await new Promise(resolve => { releaseWrite = resolve })
        }
        return { ok: true, value }
      }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message } } }
    })
    await page.route('http://127.0.0.1/world-journal-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-journal-fixture')
    const themeCss = await readFile(join(process.env.WORLD_DSH_SOURCE || 'E:/deepseek-harness', 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
    await page.addStyleTag({ content: themeCss })
    await page.addScriptTag({ content: bundleText })
    await page.locator('[data-world-icon-id="plugin:world-trash"]').waitFor()
    assert.equal(await page.locator('[data-world-version]').innerText(), `world v${manifest.version}`)
    const version = await page.locator('[data-world-version]').evaluate(node => ({
      x: node.getBoundingClientRect().x, font: getComputedStyle(node).fontSize,
      color: getComputedStyle(node).color,
      expected: getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-secondary').trim(),
    }))
    assert.equal(version.x, 16); assert.equal(version.font, '12px')
    assert.equal(version.color, version.expected, 'desktop labels follow the active dsh appearance token')
    await openDiary()
    const diary = page.locator('[data-world-plugin="world-diary"]'), trash = page.locator('[data-world-plugin="world-trash"]')
    await diary.getByRole('button', { name: '新建日记', exact: true }).click()
    const title = diary.getByLabel('日记标题', { exact: true }), body = diary.getByLabel('日记正文', { exact: true })
    await title.fill('手工日记'); await body.fill('公开工作记录\n<script>window.__diaryPwned=true</script>')
    await diary.getByRole('button', { name: '保存日记', exact: true }).click()
    await diary.getByRole('alert').waitFor()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await diary.getByRole('button', { name: '重新读取', exact: true }).waitFor({ timeout: 4000 })
    assert.equal((await journal.call('list')).total, 1, 'a lost save response must not cause a second entry')
    await body.fill('响应丢失后继续编辑的草稿')
    await diary.getByRole('button', { name: '重新读取', exact: true }).click()
    await diary.getByRole('dialog', { name: '重新读取', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await body.inputValue(), '响应丢失后继续编辑的草稿')
    await diary.getByRole('button', { name: '重新读取', exact: true }).click()
    await diary.getByRole('dialog', { name: '重新读取', exact: true }).getByRole('button', { name: '重新读取', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-diary"] .world-journal-meta')?.textContent.includes('已保存'))
    let row = (await journal.call('list')).entries[0]
    assert.equal((await other.call('get', { id: row.id })).body, '公开工作记录\n<script>window.__diaryPwned=true</script>')
    assert.equal(await page.evaluate(() => window.__diaryPwned), undefined)
    const geometry = await diary.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
      listWidth: node.querySelector('.world-journal-list').getBoundingClientRect().width,
      rowHeight: node.querySelector('.world-journal-row').getBoundingClientRect().height,
      buttonHeight: node.querySelector('.world-journal-buttons button').getBoundingClientRect().height,
      inputHeight: node.querySelector('[aria-label="日记标题"]').getBoundingClientRect().height,
      font: getComputedStyle(node.querySelector('.world-journal')).fontSize, lineHeight: getComputedStyle(node.querySelector('.world-journal')).lineHeight }))
    assert.equal(geometry.width, 1024); assert.equal(geometry.height, 640); assert.equal(geometry.listWidth, 240)
    assert.ok(geometry.rowHeight >= 64); assert.equal(geometry.buttonHeight, 32); assert.equal(geometry.inputHeight, 32)
    assert.equal(geometry.font, '13px'); assert.equal(geometry.lineHeight, '20px')
    const colors = []
    for (const dark of [false, true, false]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const palette = await body.evaluate(node => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }))
      const light = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
        const n = channel / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
      const a = light(palette.foreground), b = light(palette.background), contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      assert.ok(contrast >= 4.5)
      colors.push({ dark, ...palette, contrast: Number(contrast.toFixed(2)) })
    }
    await body.fill('正在保存的版本 A')
    holdNextWrite = true
    await diary.getByRole('button', { name: '保存日记', exact: true }).click()
    await waitForDesktop(() => releaseWrite)
    await diary.locator('.world-plugin-titlebar [aria-label="关闭"]').click()
    await openDiary()
    await body.waitFor()
    await body.fill('重新打开后输入的新草稿 B')
    const listCalls = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-journal/list').length)
    releaseWrite()
    await page.waitForFunction(count => window.__worldTesting.calls.filter(call => call.method === 'world-journal/list').length >= count + 2, listCalls)
    await page.waitForTimeout(100)
    const protectedDraft = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented
    })
    assert.equal(protectedDraft, true, 'a delayed response must not remove the newer draft or its unload protection')
    await diary.locator('.world-plugin-titlebar [aria-label="关闭"]').click()
    failNextGet = true
    await openDiary()
    await body.waitFor()
    assert.equal(await body.inputValue(), '重新打开后输入的新草稿 B')
    await diary.getByRole('alert').waitFor()
    await diary.getByRole('button', { name: '重新读取', exact: true }).click()
    failNextGet = true
    await diary.getByRole('dialog', { name: '重新读取', exact: true }).getByRole('button', { name: '重新读取', exact: true }).click()
    await diary.getByRole('alert').waitFor()
    assert.equal(await body.inputValue(), '重新打开后输入的新草稿 B', 'a failed reload must not discard the existing draft')
    await diary.getByRole('button', { name: '重新读取', exact: true }).click()
    await diary.getByRole('dialog', { name: '重新读取', exact: true }).getByRole('button', { name: '重新读取', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-diary"] [aria-label="日记正文"]')?.value === '正在保存的版本 A')
    row = await journal.call('get', { id: row.id })
    await body.fill('我的未保存草稿')
    await diary.locator('.world-plugin-titlebar [aria-label="关闭"]').click()
    await openDiary()
    await body.waitFor()
    assert.equal(await body.inputValue(), '我的未保存草稿', 'closing and reopening a virtual window retains the draft')
    await other.call('write', { id: row.id, expectedRevision: row.revision, title: '后台更新', body: '助手更新的内容' }, undefined, 'assistant')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await diary.getByRole('alert').waitFor()
    assert.equal(await body.inputValue(), '我的未保存草稿')
    await diary.getByRole('button', { name: '保存日记', exact: true }).click()
    await diary.getByRole('button', { name: '保存日记', exact: true }).waitFor()
    assert.equal((await journal.call('get', { id: row.id })).body, '助手更新的内容')
    await diary.getByRole('button', { name: '重新读取', exact: true }).click()
    let dialog = diary.getByRole('dialog', { name: '重新读取', exact: true })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await body.inputValue(), '我的未保存草稿')
    await diary.getByRole('button', { name: '重新读取', exact: true }).click()
    await dialog.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-diary"] [aria-label="日记正文"]')?.value === '助手更新的内容')
    await diary.getByRole('button', { name: '移入垃圾箱', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-diary"] [data-world-journal-entry]'))
    assert.equal((await journal.call('list', { trash: true })).total, 1)
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-trash"] .world-app-open').click()
    await trash.getByRole('button', { name: '恢复日记', exact: true }).waitFor()
    assert.match(await trash.locator('.world-journal-bodytext').innerText(), /助手更新的内容/)
    await trash.getByRole('button', { name: '恢复日记', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-trash"] [data-world-journal-entry]'))
    assert.equal((await journal.call('list')).total, 1)
    await page.locator('[data-world-taskbar="plugin:world-diary"]').click()
    await diary.getByRole('button', { name: '移入垃圾箱', exact: true }).click()
    await page.locator('[data-world-taskbar="plugin:world-trash"]').click()
    await trash.getByRole('button', { name: '永久删除', exact: true }).click()
    dialog = trash.getByRole('dialog', { name: '永久删除', exact: true })
    const confirmation = await dialog.evaluate(node => ({ width: node.getBoundingClientRect().width, padding: getComputedStyle(node).padding }))
    assert.deepEqual(confirmation, { width: 560, padding: '20px' })
    assert.equal(await trash.locator('.world-journal-detail').evaluate(node => node.inert), true, 'confirmation makes background editors inert')
    await dialog.press('Escape')
    assert.equal((await journal.call('list', { trash: true })).total, 1)
    await trash.getByRole('button', { name: '永久删除', exact: true }).click()
    await trash.getByRole('dialog', { name: '永久删除', exact: true }).getByRole('button', { name: '永久删除', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-trash"] [data-world-journal-entry]'))
    assert.equal((await journal.call('list', { trash: true })).total, 0)
    const first = await other.call('write', { title: '待清空 A', body: 'A' })
    const second = await other.call('write', { title: '待清空 B', body: 'B' })
    const firstTrash = await other.call('trash', { id: first.id, expectedRevision: first.revision })
    await other.call('trash', { id: second.id, expectedRevision: second.revision })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => document.querySelectorAll('[data-world-plugin="world-trash"] [data-world-journal-entry]').length === 2)
    await trash.getByRole('button', { name: '清空', exact: true }).click()
    await other.call('restore', { id: first.id, expectedRevision: firstTrash.revision })
    await trash.getByRole('dialog', { name: '清空垃圾箱', exact: true }).getByRole('button', { name: '清空垃圾箱', exact: true }).click()
    await trash.getByRole('alert').waitFor()
    assert.equal((await journal.call('list')).total, 1, 'a stale clearing confirmation cannot remove a concurrent restoration')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => document.querySelectorAll('[data-world-plugin="world-trash"] [data-world-journal-entry]').length === 1)
    await trash.getByRole('button', { name: '清空', exact: true }).click()
    await trash.getByRole('dialog', { name: '清空垃圾箱', exact: true }).getByRole('button', { name: '清空垃圾箱', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-trash"] [data-world-journal-entry]'))
    await journal.recordProgress({ key: 'fixed:browser-progress', title: '助手自动日记', body: '验证完成，保留公开结果。' })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.locator('[data-world-taskbar="plugin:world-diary"]').click()
    await diary.locator('.world-journal-row').filter({ hasText: '助手自动日记' }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-diary"] [aria-label="日记标题"]')?.value === '助手自动日记')
    assert.equal((await bridge.request({ action: 'state' })).state.version, manifest.version)
    await diary.locator('.world-plugin-titlebar [aria-label="最小化"]').click()
    await page.locator('[data-world-taskbar="plugin:world-diary"]').click()
    assert.equal(await title.inputValue(), '助手自动日记')
    const shots = process.env.WORLD_JOURNAL_SHOTS_DIR || join(tmpdir(), 'world-journal-shots')
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, 'diary.png'), animations: 'disabled' })
    await page.evaluate(() => window.__worldTesting.dispose())
    await page.reload(); await page.addScriptTag({ content: bundleText })
    await openDiary()
    await diary.locator('.world-journal-row').filter({ hasText: '助手自动日记' }).waitFor()
    assert.equal((await other.call('list')).total, 2)
    for (let index = 0; index < 101; index++) await other.call('write', { title: `分页记录 ${index}`, body: '分页读取校验' })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await diary.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-world-plugin="world-diary"] [data-world-journal-entry]').length === 3)
    const secondPage = await other.call('list', { offset: 100, limit: 100 })
    assert.equal(await diary.locator('.world-journal-row').first().getAttribute('data-world-journal-entry'), secondPage.entries[0].id)
    await page.waitForFunction(expected => document.querySelector('[data-world-plugin="world-diary"] [aria-label="日记标题"]')?.value === expected, secondPage.entries[0].title)
    await diary.getByRole('button', { name: '上一页', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-world-plugin="world-diary"] [data-world-journal-entry]').length === 100)
    const agreement = await other.call('write', { title: '可搜索约定', body: '长期约定：几何参数先确认。' }, undefined, 'assistant')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const agreementRow = diary.locator('.world-journal-rowwrap').filter({ hasText: '可搜索约定' })
    await agreementRow.waitFor()
    await agreementRow.locator('.world-journal-pin').click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-diary"] .world-journal-rowwrap.is-pinned'))
    const pinned = (await journal.call('list', { pinned: true })).entries[0]
    assert.equal(pinned.id, agreement.id)
    assert.equal(pinned.pinned, true)
    await diary.getByLabel('搜索日记', { exact: true }).fill('几何参数')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-plugin="world-diary"] [data-world-journal-entry]').length === 1)
    assert.equal(await diary.locator('.world-journal-row').first().getAttribute('data-world-journal-entry'), agreement.id)
    await diary.getByRole('button', { name: '清空', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-world-plugin="world-diary"] [data-world-journal-entry]').length === 100)
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.__worldTesting.dispose())
    console.log(`Journal passed: ${JSON.stringify({ geometry, confirmation, version, colors })}; real persistence, shared editing/conflicts, draft retention, restore, confirmed purge/clear, concurrent restoration, automatic receipts and reload.`)
  } finally {
    releaseWrite?.()
    await page.close(); bridge.dispose(); await journal.dispose(); await other.dispose()
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-journal-ui-'))
    await rm(directory, { recursive: true, force: true })
  }
}
