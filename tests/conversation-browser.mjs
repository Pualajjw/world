import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopBridge } from '../desktop-bridge.js'

/** Exercise native-slot wiring, input ownership, body portals and retained Session lifecycle. */
export async function checkAssistantConversation(browser, bundleText) {
  const bridge = createDesktopBridge()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.setContent('<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:40px;box-sizing:border-box}#host-ui{position:absolute;inset:40px 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => Boolean(window.__worldTesting))
    await page.evaluate(() => {
      const fixture = window.__worldTesting.conversation
      fixture.setDraft('session-1', '交接前的草稿')
      fixture.setMessages('session-1', Array.from({ length: 12 }, (_, index) => ({ id: `history-${index}`,
        role: index % 2 ? 'assistant' : 'user', text: index === 0 ? `${'完整内容\n'.repeat(3000)}末尾仍可见` : `历史消息 ${index}` })))
    })
    const handoff = page.locator('[data-world-control-button]')
    await handoff.click()
    const panel = page.getByRole('region', { name: '固定助手对话', exact: true })
    const input = panel.getByRole('textbox', { name: 'DSH 原生输入框夹具' })
    await input.waitFor()
    assert.equal(await input.inputValue(), '交接前的草稿')
    assert.equal(await page.locator('[data-fixture-composer]').count(), 1, 'only one native editor is mounted')
    assert.equal(await panel.locator('[data-fixture-message]').count(), 12, 'not the previous eight-message projection')
    assert.ok((await panel.innerText()).includes('末尾仍可见'), 'long history is not clipped to 16000 characters')
    await checkConversationTheme(page, panel)
    assert.equal(await page.evaluate(() => window.__worldTesting.conversation.retainCount('session-1')), 1)
    const bounds = await page.locator('.world-control-card').evaluate(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { width: rect.width, right: innerWidth - rect.right, bottom: innerHeight - 48 - rect.bottom,
        heightRatio: Math.round(rect.height / innerHeight * 100) / 100,
        padding: style.padding, radius: style.borderRadius }
    })
    const { heightRatio, ...box } = bounds
    assert.deepEqual(box, { width: 372, right: 18, bottom: 14, padding: '14px 14px 12px', radius: '16px' })
    assert.ok(heightRatio < .75, `the nook never becomes a wall (got ${heightRatio})`)
    await input.fill('从面板发送给同一个助手')
    await input.press('Enter')
    assert.equal(await handoff.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await page.evaluate(() => window.__worldTesting.conversation.sent),
      [{ sessionId: 'session-1', text: '从面板发送给同一个助手' }])
    await panel.getByRole('button', { name: '模型菜单' }).click()
    await page.waitForFunction(() => document.querySelector('[data-fixture-popup]')?.dataset.worldAssistantDialog === 'true')
    const menu = page.getByRole('menu')
    assert.equal(await menu.evaluate(node => node.closest('[inert]') === null), true, 'native portals remain interactive while DSH is hidden')
    await checkConversationCollapse(page, bridge, input, menu, handoff)
    await menu.getByRole('button', { name: '保留当前模型' }).click()
    assert.equal(await handoff.getAttribute('aria-pressed'), 'true', 'portal interaction is not a desktop takeover')
    await page.evaluate(() => window.__worldTesting.switchMain('session-2'))
    assert.equal(await panel.locator('[data-fixture-chat="session-1"]').count(), 1, 'main selection never changes the fixed brain')
    await input.fill('接管后仍保留的草稿')
    await page.locator('[data-world-takeover]').click()
    await panel.waitFor({ state: 'detached' })
    await page.waitForFunction(() => window.__worldTesting.conversation.retainCount('session-1') === 0)
    await page.evaluate(() => window.__worldTesting.switchMain('session-1'))
    await page.waitForFunction(() => document.querySelector('[data-fixture-native-main] textarea')?.value === '接管后仍保留的草稿')
    for (let index = 0; index < 3; index++) {
      await handoff.click()
      await panel.getByRole('textbox').waitFor()
      await handoff.click()
      await panel.waitFor({ state: 'detached' })
    }
    assert.deepEqual(await page.evaluate(() => window.__worldTesting.conversation.conflicts), [], 'editor roots never overlap across repeated handoffs')
    await page.evaluate(() => window.__worldTesting.conversation.failNextOpen('会话暂时无法读取'))
    await handoff.click()
    await panel.getByRole('alert').waitFor()
    assert.match(await panel.getByRole('alert').innerText(), /会话暂时无法读取/)
    assert.equal(await page.locator('[data-fixture-composer]').count(), 1, 'a failed retain does not steal the main editor seat')
    await page.locator('[data-world-takeover]').click()
    // 400 比卡片本身还窄：这时才该出现 max-width 收边，而不是让台子伸出屏幕。
    await page.setViewportSize({ width: 400, height: 640 })
    await handoff.click()
    await panel.getByRole('textbox').waitFor()
    assert.equal(await page.locator('.world-control-card').evaluate(node => node.getBoundingClientRect().width), 368)
    assert.equal(await panel.evaluate(node => node.clientHeight > 0 && node.scrollWidth <= node.clientWidth), true)
    const narrowToggle = page.locator('[data-world-assistant-toggle]')
    await narrowToggle.click()
    assert.equal(await page.locator('.world-control-card').evaluate(node => node.getBoundingClientRect().width), 368)
    assert.equal(await page.locator('[data-world-takeover]').isVisible(), true)
    await page.locator('[data-world-takeover]').click()
    assert.equal(await handoff.getAttribute('aria-pressed'), 'false', 'takeover remains available from the collapsed titlebar')
    await handoff.click()
    await narrowToggle.waitFor()
    assert.equal(await narrowToggle.getAttribute('aria-expanded'), 'false', 'collapse preference survives another handoff in the same page')
    await narrowToggle.click()
    await panel.getByRole('textbox').waitFor()
    if (process.env.WORLD_CONVERSATION_SHOTS_DIR) {
      await mkdir(process.env.WORLD_CONVERSATION_SHOTS_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.WORLD_CONVERSATION_SHOTS_DIR, 'assistant-conversation-narrow.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.screenshot({ path: join(process.env.WORLD_CONVERSATION_SHOTS_DIR, 'assistant-conversation.png'), animations: 'disabled' })
    }
    await page.evaluate(() => window.__worldTesting.dispose())
    assert.equal(await page.locator('[data-world-control-overlay]').count(), 0)
    console.log(`Assistant Conversation passed: ${JSON.stringify(bounds)}; fixed Session, full history, single native editor, drafts, portal ownership, failed retain, narrow viewport and cleanup.`)
  } finally { bridge.dispose(); await page.close() }
}

async function checkConversationCollapse(page, bridge, input, menu, handoff) {
  const toggle = page.locator('[data-world-assistant-toggle]'), card = page.locator('.world-control-card')
  const editor = await input.elementHandle()
  const controlId = (await bridge.request({ action: 'state' })).state.control.controlId
  const brainCalls = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method.startsWith('world-desktop-brain/')).length)
  const before = await card.boundingBox()
  await input.fill('收起时保留的草稿')
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('.world-assistant-conversation').isVisible(), false)
  assert.equal(await editor.evaluate(node => node.isConnected), true, 'collapsing must not unmount or rebind the native editor')
  assert.equal(await page.locator('[data-fixture-popup]').count(), 1)
  assert.equal(await menu.isVisible(), false, 'owned native portals hide with the collapsed panel')
  assert.equal(await page.locator('[data-world-takeover]').isVisible(), true)
  const compact = await card.evaluate(node => {
    const rect = node.getBoundingClientRect(), button = node.querySelector('[data-world-assistant-toggle]')
    return { width: rect.width, right: innerWidth - rect.right, bottom: innerHeight - 48 - rect.bottom,
      tall: rect.height > 120, buttonHeight: button.getBoundingClientRect().height }
  })
  assert.deepEqual({ ...compact, buttonHeight: undefined },
    { width: 372, right: 18, bottom: 14, tall: false, buttonHeight: undefined })
  assert.ok(compact.buttonHeight >= 20 && compact.buttonHeight <= 32, `compact header buttons (got ${compact.buttonHeight})`)
  assert.equal(await page.evaluate(() => window.__worldTesting.conversation.retainCount('session-1')), 1)
  await page.evaluate(() => {
    const fixture = window.__worldTesting.conversation
    fixture.setMessages('session-1', [...fixture.snapshot('session-1').messages,
      { id: 'collapsed-update', role: 'assistant', text: '收起期间也继续接收会话更新。' }])
  })
  assert.equal((await bridge.request({ action: 'state' })).state.control.controlId, controlId)
  assert.equal(await handoff.getAttribute('aria-pressed'), 'true')
  await toggle.press('Enter')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(await input.inputValue(), '收起时保留的草稿')
  assert.equal(await editor.evaluate(node => node === document.querySelector('.world-assistant-conversation textarea')), true)
  assert.equal(await page.locator('[data-fixture-message="collapsed-update"]').count(), 1)
  assert.equal(await menu.isVisible(), true)
  assert.deepEqual(await card.boundingBox(), before, 'expanding restores the original card bounds')
  assert.equal(await page.evaluate(() => window.__worldTesting.conversation.conflicts.length), 0)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method.startsWith('world-desktop-brain/')).length), brainCalls)
  if (process.env.WORLD_CONVERSATION_SHOTS_DIR) {
    await toggle.click()
    await mkdir(process.env.WORLD_CONVERSATION_SHOTS_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.WORLD_CONVERSATION_SHOTS_DIR, 'assistant-collapsed.png'), animations: 'disabled' })
    await toggle.click()
  }
  console.log(`Assistant collapse passed: ${JSON.stringify(compact)}; same controlId, same editor, draft/live updates retained, portals hidden, keyboard expansion.`)
}

/** Native Chat sets its own foreground; its container must supply the matching theme surface. */
async function checkConversationTheme(page, panel) {
  const style = await page.addStyleTag({ content: `
body { --dsw-alias-bg-base: rgb(255,255,255); --dsw-alias-label-primary: rgb(15,17,21); }
body[data-ds-dark-theme] { --dsw-alias-bg-base: rgb(21,21,23); --dsw-alias-label-primary: rgb(249,250,251); }
` })
  const palette = []
  try {
    for (const dark of [false, true, false]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const colors = await panel.evaluate(node => {
        const region = getComputedStyle(node), text = getComputedStyle(node.querySelector('[data-fixture-chat]'))
        const probe = document.createElement('span')
        probe.style.cssText = 'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)'
        node.append(probe)
        const expected = getComputedStyle(probe)
        const result = { background: region.backgroundColor, foreground: text.color,
          expectedBackground: expected.backgroundColor, expectedForeground: expected.color }
        probe.remove()
        return result
      })
      assert.equal(colors.background, colors.expectedBackground, 'native text and background must come from the same theme')
      assert.equal(colors.foreground, colors.expectedForeground)
      const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
        const s = channel / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
      const light = luminance(colors.background), ink = luminance(colors.foreground)
      const contrast = (Math.max(light, ink) + 0.05) / (Math.min(light, ink) + 0.05)
      assert.ok(contrast >= 4.5, `conversation contrast is too low: ${contrast}`)
      palette.push({ theme: dark ? 'dark' : 'light', ...colors, contrast: Number(contrast.toFixed(2)) })
      if (process.env.WORLD_CONVERSATION_SHOTS_DIR) {
        await mkdir(process.env.WORLD_CONVERSATION_SHOTS_DIR, { recursive: true })
        await page.screenshot({ path: join(process.env.WORLD_CONVERSATION_SHOTS_DIR, `conversation-theme-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' })
      }
    }
  } finally {
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await style.evaluate(node => node.remove())
  }
  console.log(`Conversation theme passed: ${JSON.stringify(palette)}`)
}
