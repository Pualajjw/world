import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopBrain } from '../desktop-brain.js'
import { createDesktopBridge } from '../desktop-bridge.js'
import { createWorkbench } from '../workbench.js'
import { DEFAULT_BACKGROUND, WORKBENCH_PRIORITY } from '../workbench-profile.js'

/** First-run setup uses the real Host state and handoff channel, with an inert test model. */
export async function checkWorkbenchSetup(browser, bundle) {
  const directory = await mkdtemp(join(tmpdir(), 'world-setup-'))
  try {
    for (const legacy of [false, true]) {
      const file = join(directory, legacy ? 'legacy.json' : 'fresh.json')
      if (legacy) await writeFile(file, JSON.stringify({ sessionId: 'legacy-brain' }))
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const handlers = new Map(), prompts = []
      const ctx = {
        sessions: { get: id => ['session-1', 'legacy-brain'].includes(id) ? {} : null },
        agents: { get: () => undefined },
        on(name, listener) {
          const set = handlers.get(name) || new Set(); set.add(listener); handlers.set(name, set)
          return () => set.delete(listener)
        },
        sessionController: { async prompt(request) { prompts.push(request); return { accepted: true } } },
      }
      const brain = createDesktopBrain(ctx, { file })
      const bridge = createDesktopBridge()
      // 0.2.71 起提示词由 index.js 组装（生活线 + 我是谁 + 背景），这里用同样的形状给一个桩。
      const workbench = createWorkbench(ctx, { brain, bridge,
        promptOf: scope => {
          const fixed = brain.peek()
          return scope?.id === fixed.sessionId && fixed.profile ? fixed.profile.background : ''
        } })
      try {
        await workbench.ready
        await page.exposeBinding('__worldBrainCall', (_source, operation, payload) => brain.call(operation, payload))
        await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
        await page.setContent('<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:40px;box-sizing:border-box}#host-ui{position:absolute;inset:40px 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
        await page.addScriptTag({ content: bundle })
        await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
        const button = page.locator('[data-world-control-button]')
        const dialog = page.getByRole('dialog', { name: '设定你的助手' })
        await button.click()
        await dialog.waitFor()
        const input = dialog.getByLabel('助手背景')
        assert.equal(await input.inputValue(), DEFAULT_BACKGROUND)
        assert.match(await dialog.innerText(), new RegExp(WORKBENCH_PRIORITY))
        assert.equal(await input.evaluate(node => document.activeElement === node), true)
        assert.equal(await button.getAttribute('aria-pressed'), 'false')
        assert.equal(prompts.length, 0)
        const measurements = await dialog.evaluate(card => {
          const style = getComputedStyle(card), input = card.querySelector('textarea'), field = getComputedStyle(input)
          return { width: card.getBoundingClientRect().width, padding: style.padding, radius: style.borderRadius,
            gap: style.gap, inputHeight: input.getBoundingClientRect().height, fontSize: field.fontSize,
            lineHeight: field.lineHeight, buttonHeights: [...card.querySelectorAll('button')].map(node => node.getBoundingClientRect().height) }
        })
        assert.deepEqual(measurements, { width: 560, padding: '20px', radius: '8px', gap: '12px', inputHeight: 128,
          fontSize: '13px', lineHeight: '20px', buttonHeights: [32, 32] })
        if (process.env.WORLD_SETUP_SHOTS_DIR) {
          await mkdir(process.env.WORLD_SETUP_SHOTS_DIR, { recursive: true })
          await page.screenshot({ path: join(process.env.WORLD_SETUP_SHOTS_DIR, legacy ? 'setup-existing-assistant.png' : 'setup-first-handoff.png'), animations: 'disabled' })
        }
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        assert.equal((await brain.get()).profile, null, 'cancel does not persist a profile')
        assert.equal((await brain.get()).sessionId, legacy ? 'legacy-brain' : null)
        assert.equal(prompts.length, 0)

        await button.click()
        await dialog.waitFor()
        await dialog.getByRole('button', { name: '保存并交接', exact: true }).focus()
        await page.keyboard.press('Tab')
        assert.equal(await input.evaluate(node => document.activeElement === node), true, 'Tab stays inside the setup dialog')
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        assert.equal((await brain.get()).profile, null)

        await button.click()
        await dialog.waitFor()
        await input.fill(legacy ? '你是我的固定工作台助手，先处理我布置的任务。' : DEFAULT_BACKGROUND)
        await dialog.getByRole('button', { name: '保存并交接', exact: true }).click()
        await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
        await dialog.waitFor({ state: 'detached' })
        const configured = await brain.get()
        assert.equal(configured.sessionId, legacy ? 'legacy-brain' : 'session-1')
        assert.equal(configured.profile.background, legacy ? '你是我的固定工作台助手，先处理我布置的任务。' : DEFAULT_BACKGROUND)
        assert.equal(JSON.parse(await readFile(file, 'utf8')).profile.background, configured.profile.background)
        // The handoff only opens the door: it must not start a turn by itself (0.2.72). Waking her is the life
        // line's job, and it is not wired into this fixture.
        for (let tries = 0; tries < 10; tries++) await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(prompts.length, 0, 'a handoff never starts a turn by itself')
        assert.ok(workbench.instructions({ id: configured.sessionId }).includes(configured.profile.background))
        await button.click()
        await button.click()
        await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
        assert.equal(await dialog.count(), 0, 'configured assistants do not repeat onboarding')
        assert.equal((await brain.get()).sessionId, configured.sessionId)
        await page.evaluate(() => window.__worldTesting.dispose())
        console.log(`Workbench ${legacy ? 'upgrade' : 'first handoff'} passed: ${JSON.stringify(measurements)}; cancel/Escape preserve identity, setup saved, a handoff starts no turn.`)
      } finally {
        workbench.dispose()
        bridge.dispose()
        await page.close()
      }
    }
  } finally {
    assert.equal(dirname(directory), tmpdir())
    assert.ok(basename(directory).startsWith('world-setup-'))
    await rm(directory, { recursive: true, force: true })
  }
}
