import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopBrain } from '../desktop-brain.js'
import { createDesktopBridge } from '../desktop-bridge.js'
import { createWorkbench } from '../workbench.js'
import { companionInstructions } from '../companion-life.js'
import { DEFAULT_BACKGROUND } from '../workbench-profile.js'
import { atomic } from './journal-fixture.mjs'

/** Exercise real preference persistence and handoff, without invoking a live model. */
export async function checkPersonalization(browser, bundle) {
  const directory = await mkdtemp(join(tmpdir(), 'world-personalization-'))
  const file = join(directory, 'brain.json'), prompts = []
  const ctx = {
    sessions: { get: id => ['session-1', 'session-2'].includes(id) ? {} : null },
    agents: { get: () => undefined }, on: () => () => {},
    sessionController: { prompt: async request => { prompts.push(request); return { accepted: true } } },
  }
  const brain = createDesktopBrain(ctx, { file, atomic }), bridge = createDesktopBridge()
  const workbench = createWorkbench(ctx, { brain, bridge,
    promptOf: scope => {
      const fixed = brain.peek()
      return scope?.id === fixed.sessionId && fixed.profile ? companionInstructions({ profile: fixed.profile }) : ''
    } })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  let delayRead = null, delaySave = null, saveStarted = false
  const boot = async () => {
    await page.setContent('<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:40px;box-sizing:border-box}#host-ui{position:absolute;inset:40px 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
    await page.addScriptTag({ content: bundle })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  }
  try {
    await workbench.ready
    await page.exposeBinding('__worldBrainCall', async (_source, operation, payload) => {
      if (operation === 'get' && delayRead) { const wait = delayRead; delayRead = null; await wait }
      if (operation === 'update_profile' && delaySave) { saveStarted = true; await delaySave }
      return brain.call(operation, payload)
    })
    await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
    await boot()
    const dialog = page.getByRole('dialog', { name: '助手个性化', exact: true })
    const handoff = page.locator('[data-world-control-button]')
    const open = async () => {
      await page.locator('.world-start-button').click()
      const entry = page.getByRole('button', { name: '助手个性化', exact: true })
      assert.ok(Math.abs(await entry.evaluate(node => node.getBoundingClientRect().height) - 32) < 1)
      await entry.click()
      await dialog.waitFor()
    }
    await open()
    const name = dialog.getByLabel('助手名字', { exact: true })
    await name.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('.world-workbench-setup-card input')?.disabled)
    assert.equal(await name.inputValue(), '助手')
    assert.equal(await dialog.getByLabel('如何称呼你').inputValue(), '')
    assert.equal(await dialog.getByLabel('常驻背景').inputValue(), DEFAULT_BACKGROUND)
    const measurements = await dialog.evaluate(card => {
      const style = getComputedStyle(card), field = card.querySelector('textarea'), css = getComputedStyle(field)
      return { width: card.getBoundingClientRect().width, padding: style.padding, radius: style.borderRadius, gap: style.gap,
        inputHeights: [...card.querySelectorAll('input,select,button')].map(node => node.getBoundingClientRect().height),
        backgroundHeight: field.getBoundingClientRect().height, font: css.fontSize, lineHeight: css.lineHeight }
    })
    // 名字 / 称呼 / 风格 / 每天早上 / 每天回顾 / 开关 / 取消 / 保存：0.2.71 起多了两个时间和一个开关。
    assert.deepEqual(measurements, { width: 560, padding: '20px', radius: '8px', gap: '12px',
      inputHeights: [32, 32, 32, 32, 32, 16, 32, 32], backgroundHeight: 128, font: '13px', lineHeight: '20px' })
    assert.equal(await dialog.getByLabel('每天早上').inputValue(), '09:00')
    assert.equal(await dialog.getByLabel('每天回顾').inputValue(), '23:00')
    assert.equal(await dialog.getByRole('checkbox').isChecked(), true, 'her own time is on by default')
    await name.fill('没有保存')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal((await brain.get()).profile, null)
    assert.equal(prompts.length, 0)

    await open()
    await name.fill('归舟')
    await dialog.getByLabel('如何称呼你').fill('阿林')
    await dialog.getByLabel('表达风格').selectOption('concise')
    await dialog.getByLabel('常驻背景').fill('一起照料我们的小工作台。')
    if (process.env.WORLD_PERSONALIZATION_SHOTS_DIR) {
      await mkdir(process.env.WORLD_PERSONALIZATION_SHOTS_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.WORLD_PERSONALIZATION_SHOTS_DIR, 'assistant-personalization.png'), animations: 'disabled' })
    }
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const pending = await brain.get()
    assert.equal(pending.sessionId, null)
    assert.equal(pending.profile.name, '归舟')
    assert.equal(await handoff.getAttribute('aria-pressed'), 'false')
    assert.equal(prompts.length, 0, 'saving preferences cannot wake a session')

    await handoff.click()
    await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
    assert.equal(await page.getByRole('dialog').count(), 0, 'saved preferences skip repeated background setup')
    assert.equal((await brain.get()).sessionId, 'session-1')
    assert.equal(await page.locator('.world-control-header strong').innerText(), '我在')
    assert.match(await page.locator('.world-control-session').innerText(), /归舟/, 'the assistant keeps its own name as a signature')
    assert.equal(await page.locator('.world-assistant-pointer-label').innerText(), '归舟')
    // 交接只开门，不开一轮（0.2.72）：提示词在下一轮读，唤醒由生活线的闹钟负责。
    for (let tries = 0; tries < 10; tries++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(prompts.length, 0, 'a handoff starts no turn')
    assert.ok(workbench.instructions({ id: 'session-1' }).includes('阿林'))
    assert.ok(workbench.instructions({ id: 'session-1' }).includes('先说结论'))

    await open()
    await name.fill('草稿名字')
    const original = await brain.get()
    await brain.call('update_profile', { expectedRevision: original.revision, expectedSessionId: 'session-1', profile: { name: '另一窗口' } })
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    assert.match(await dialog.getByRole('alert').innerText(), /其他窗口/)
    assert.equal(await name.inputValue(), '草稿名字')
    assert.equal((await brain.get()).profile.name, '另一窗口')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()

    await open()
    await page.waitForFunction(() => document.querySelector('.world-workbench-setup-card input')?.value === '另一窗口')
    await name.fill('归舟一直照料我们共同的小小工作台') // exactly 16 characters
    assert.equal([...(await name.inputValue())].length, 16)
    await dialog.getByLabel('表达风格').selectOption('detailed')
    let finishSave
    delaySave = new Promise(resolve => { finishSave = resolve })
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
    for (let tries = 0; !saveStarted && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(saveStarted, true)
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await dialog.count(), 1, 'Escape cannot falsely cancel an admitted save')
    finishSave(); delaySave = null
    await dialog.waitFor({ state: 'detached' })
    assert.equal((await brain.get()).sessionId, 'session-1')
    assert.equal(await handoff.getAttribute('aria-pressed'), 'false')
    assert.equal(prompts.length, 0, 'editing does not automatically grant or prompt')
    await handoff.click()
    await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
    const label = await page.locator('.world-assistant-pointer-label').innerText()
    assert.equal(label, (await brain.get()).profile.name)
    await page.locator('[data-world-assistant-toggle]').click()
    const collapsed = await page.locator('.world-control-card').boundingBox()
    assert.ok(collapsed.height < 100, `long names cannot stretch the collapsed header (got ${collapsed.height})`)
    await page.setViewportSize({ width: 640, height: 480 })
    const header = await page.locator('.world-control-header strong').evaluate(node => {
      const style = getComputedStyle(node); return { overflow: style.textOverflow, lines: style.whiteSpace }
    })
    assert.deepEqual(header, { overflow: 'ellipsis', lines: 'nowrap' })

    // A slow settings read must not reopen a dialog the user has canceled.
    await page.setViewportSize({ width: 1280, height: 800 })
    let finishRead
    delayRead = new Promise(resolve => { finishRead = resolve })
    await open()
    await dialog.getByText('正在读取设置…').waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    finishRead()
    await page.waitForTimeout(80)
    assert.equal(await dialog.count(), 0)
    const bytes = await readFile(file, 'utf8')
    await page.evaluate(() => window.__worldTesting.dispose())
    await boot()
    await open()
    await page.waitForFunction(() => !document.querySelector('.world-workbench-setup-card input')?.disabled)
    assert.equal(await name.inputValue(), label)
    assert.equal(await dialog.getByLabel('表达风格').inputValue(), 'detailed')
    assert.equal(await readFile(file, 'utf8'), bytes, 'reload reads preferences without rewriting the file')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__worldTesting.dispose())
    console.log(`Assistant personalization passed: ${JSON.stringify(measurements)}; pre-handoff preferences, stable identity, live names, prompt style, conflict drafts, canceled read, admitted save, long-name collapse and reload.`)
  } finally {
    workbench.dispose(); bridge.dispose(); await page.close()
    assert.equal(dirname(directory), tmpdir())
    assert.ok(basename(directory).startsWith('world-personalization-'))
    await rm(directory, { recursive: true, force: true })
  }
}
