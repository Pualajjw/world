import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopToolDefinitions } from '../desktop-tools.js'

/** Exercise human input through real browser events, including the owned cross-origin chat frame. */
export async function checkDesktopControl(page, bridge, root, brain) {
  const exec = { agent: { session: { id: 'session-1' } } }
  const tools = desktopToolDefinitions({ bridge, brain, sessions: { get: () => ({ header: { cwd: '/workspace' } }) },
    editor: { call: async (_op, args) => ({ path: `/workspace/${args.path}` }) } })
  const inspect = () => tools[0].execute({}, exec)
  const act = (args, context = exec) => tools[1].execute(args, context)
  const button = page.locator('[data-world-control-button]')
  const overlay = page.locator('[data-world-control-overlay]')
  const grant = async () => {
    if ((await inspect()).state.control.owner === 'assistant') await button.click()
    await button.click()
    await page.waitForFunction(() => document.querySelector('[data-world-control-button]').getAttribute('aria-pressed') === 'true')
    return (await inspect()).state.control.controlId
  }
  if ((await inspect()).state.control.owner === 'assistant') await button.click()
  assert.equal((await inspect()).state.control.owner, 'human')
  await assert.rejects(act({ action: 'open_app', appId: 'dsh', controlId: 'no-grant' }), { code: 'WORLD_DESKTOP_TAKEN_OVER' })

  const first = await grant()
  await overlay.waitFor()
  const measurements = await page.evaluate(() => {
    const card = document.querySelector('.world-control-card').getBoundingClientRect()
    const avatar = document.querySelector('.world-control-avatar').getBoundingClientRect()
    const button = document.querySelector('[data-world-control-button]').getBoundingClientRect()
    return { cardWidth: card.width, right: innerWidth - card.right, bottom: innerHeight - card.bottom,
      heightRatio: Math.round(card.height / innerHeight * 100) / 100, rightOfCentre: card.left > innerWidth / 2,
      avatarWidth: avatar.width, avatarHeight: avatar.height, buttonWidth: button.width, buttonHeight: button.height,
      pointerEvents: getComputedStyle(document.querySelector('.world-control-overlay')).pointerEvents }
  })
  const { heightRatio, rightOfCentre, ...box } = measurements
  assert.deepEqual(box, { cardWidth: 372, right: 18, bottom: 62,
    avatarWidth: 32, avatarHeight: 32, buttonWidth: 40, buttonHeight: 40, pointerEvents: 'none' })
  // 住进来不等于占住：卡片停在右下一角，永远不变成通高的墙。
  assert.ok(heightRatio < 0.75, `the nook stays under 75vh (got ${heightRatio})`)
  assert.equal(rightOfCentre, true, 'the desktop keeps its centre and left side')
  const cardText = await page.locator('.world-control-card').innerText()
  assert.match(cardText, /我在/, 'the assistant speaks as a resident, not as a control channel')
  assert.match(cardText, /换你来/, 'handing back reads as an invitation, not as seizing control')

  // 卡片跟着系统的浅色 / 深色走：浅色是白玻璃配深字，深色还是那层夜色。
  const nook = () => page.evaluate(() => {
    const card = document.querySelector('.world-control-card')
    const style = getComputedStyle(card)
    return { ink: style.color, pane: style.getPropertyValue('--nook-bg-top').replace(/\s+/g, ''), theme: document.body.dataset.worldTheme }
  })
  const lightNook = await nook()
  assert.equal(lightNook.theme, 'light')
  assert.equal(lightNook.ink, 'rgb(23, 35, 60)', 'the card text follows the light theme')
  assert.match(lightNook.pane, /255,255,255/, 'the card is a white pane in light theme')
  await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
  const darkNook = await nook()
  assert.equal(darkNook.ink, 'rgb(255, 255, 255)', 'and turns back to light ink in dark theme')
  assert.match(darkNook.pane, /10,32,52/, 'the night glass comes back in dark theme')
  await page.evaluate(() => document.documentElement.removeAttribute('data-ds-dark-theme'))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'light')
  await page.mouse.move(630, 300)
  assert.equal((await inspect()).state.control.owner, 'assistant', 'moving the pointer alone does not take over')
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })))
  assert.equal((await inspect()).state.control.owner, 'assistant', 'synthetic input is not a human takeover')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  assert.equal((await inspect()).state.control.controlId, first, 'window focus loss does not revoke the handoff')
  await assert.rejects(act({ action: 'explain', controlId: first, message: '不可越过会话边界' },
    { agent: { session: { id: 'another-session' } } }), { code: 'WORLD_DESKTOP_BRAIN' })
  await act({ action: 'explain', controlId: first, message: '正在检查项目文件，完成后把结果展示给你。' })
  assert.match(await overlay.innerText(), /正在检查项目文件/)
  if (process.env.WORLD_CONTROL_SHOTS_DIR) {
    await mkdir(process.env.WORLD_CONTROL_SHOTS_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.WORLD_CONTROL_SHOTS_DIR, 'assistant-control.png'), animations: 'disabled' })
  }

  await act({ action: 'open_app', appId: 'dsh', controlId: first })
  await page.locator('#host-focus').click()
  assert.equal((await inspect()).state.control.owner, 'human')
  assert.equal(await page.locator('#host-focus').evaluate(node => document.activeElement === node), true,
    'the same click reaches the underlying application')
  assert.equal(await overlay.count(), 0)
  await assert.rejects(act({ action: 'open_app', appId: 'dsh', controlId: first }), { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  const second = await grant()
  assert.notEqual(second, first)
  await assert.rejects(act({ action: 'open_app', appId: 'dsh', controlId: first }), { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  await page.keyboard.press('x')
  assert.equal((await inspect()).state.control.owner, 'human', 'a real key takes over')
  await grant()
  await page.mouse.move(630, 300)
  await page.mouse.wheel(0, 100)
  await page.waitForFunction(() => !document.querySelector('[data-world-control-overlay]'))
  assert.equal((await inspect()).state.control.owner, 'human', 'the wheel takes over')

  const interruptedGrant = await grant()
  const opening = act({ action: 'open_file', path: 'src/big.txt', controlId: interruptedGrant })
  const rejected = assert.rejects(opening, { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  await page.waitForFunction(() => Boolean(document.querySelector('.world-vscode-loading')))
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await rejected
  assert.equal((await inspect()).state.control.owner, 'human')
  // 开始菜单打开后光标落在搜索框里（0.2.73），所以这里只要求焦点还在菜单里、没被那次取消的读取抢走。
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.world-start'))), true,
    'a delayed file read cannot steal focus back after takeover')
  const state = (await inspect()).state
  assert.equal(state.windows.some(win => win.editor?.files.some(file => file.path.endsWith('/big.txt'))), false,
    'a cancelled file read cannot populate a tab later')
  await page.keyboard.press('Escape')

  // Use the actual chat HTML/JS, hosted under a different origin from the desktop.
  const assets = new Map(await Promise.all(['app.html', 'app.css', 'app.js', 'markdown.js'].map(async name =>
    [`/${name}`, await readFile(join(root, 'lan-chat', name), 'utf8')])))
  await page.route('http://world-input.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const contentType = pathname.endsWith('.html') ? 'text/html; charset=utf-8'
      : pathname.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8'
    await route.fulfill({ contentType, body: assets.get(pathname) || '' })
  })
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.dataset.inputCheck = 'true'
    frame.className = 'world-lanchat-frame'
    frame.src = 'http://world-input.test/app.html?demo=1'
    frame.style.cssText = 'position:fixed;left:10px;top:130px;width:420px;height:400px;z-index:110'
    document.body.append(frame)
  })
  await page.frameLocator('[data-input-check]').locator('#lcInput').waitFor()
  await grant()
  await page.evaluate(() => window.postMessage({ type: 'world-human-input' }, '*'))
  assert.equal((await inspect()).state.control.owner, 'assistant', 'unrelated window messages do not take over')
  await page.mouse.move(150, 250)
  assert.equal((await inspect()).state.control.owner, 'assistant')
  await page.mouse.wheel(0, 100)
  await page.waitForFunction(() => !document.querySelector('[data-world-control-overlay]'))
  assert.equal((await inspect()).state.control.owner, 'human', 'chat frame wheel input reaches the desktop handoff')
  await page.locator('[data-input-check]').evaluate(node => node.remove())
  await grant()
  await button.click()
  assert.equal((await inspect()).state.control.owner, 'human', 'the taskbar toggle revokes without accidentally granting again')
  // Changing the visible DSH conversation never changes the assistant's identity.
  await grant()
  await page.evaluate(() => window.__worldTesting.switchMain('session-2'))
  assert.equal((await inspect()).state.control.sessionId, 'session-1')
  await button.click()
  const fixedGrant = await grant()
  assert.equal((await inspect()).state.brainSessionId, 'session-1')
  assert.equal((await inspect()).state.control.sessionId, 'session-1')
  await assert.rejects(act({ action: 'explain', controlId: fixedGrant, message: '不能换脑' },
    { agent: { session: { id: 'session-2' } } }), { code: 'WORLD_DESKTOP_BRAIN' })
  await act({ action: 'explain', controlId: fixedGrant, message: '我仍在同一个助手会话中继续工作。' })
  await button.click()
  await page.evaluate(() => window.__worldTesting.switchMain('session-1'))
  console.log(`Desktop handoff passed: ${JSON.stringify(measurements)}; click/key/wheel takeover, new grant required, late read cancelled, iframe input relayed.`)
}
