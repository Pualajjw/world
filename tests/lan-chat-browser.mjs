import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Exercise the shared composer through both the live page and shipped prototype. */
export async function checkLanChatInput(browser, root) {
  const assets = new Map(await Promise.all(['app.html', 'app.css', 'app.js', 'markdown.js'].map(async name => [
    `/${name}`, await readFile(join(root, 'lan-chat', name), 'utf8'),
  ])))
  const shots = process.env.WORLD_CHAT_SHOTS_DIR
  if (shots) await mkdir(shots, { recursive: true })

  for (const mode of ['live', 'prototype']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    let liveState = null
    page.on('pageerror', error => errors.push(error.message))
    try {
      if (mode === 'live') {
        const state = {
          me: { id: 'me', nickname: '我', ip: '127.0.0.1' }, peers: [],
          bots: [{ id: 'bot:test/model', name: '测试模型', provider: 'test', model: 'model', providerName: 'Test', machine: '本机模型', ip: '127.0.0.1', online: true, bot: true }],
          pending: {}, retrying: {},
          conversations: [{ id: 'input-check', kind: 'group', name: '输入自检', memberIds: ['me'], unread: 0 }],
          messages: { 'input-check': [] },
        }
        liveState = state
        await page.route('http://world-chat.test/**', async route => {
          const pathname = new URL(route.request().url()).pathname
          if (pathname === '/api/state') return route.fulfill({ json: state })
          if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' })
          if (pathname === '/api/send') {
            const { conversationId, text } = route.request().postDataJSON()
            state.messages[conversationId].push({
              id: `sent-${state.messages[conversationId].length}`, conversationId,
              from: state.me.id, fromName: state.me.nickname, text, at: Date.now(), kind: 'text',
            })
            return route.fulfill({ json: { state } })
          }
          if (pathname === '/api/conversations') {
            const options = route.request().postDataJSON()
            const id = `group-${state.conversations.length}`
            const bots = state.bots.filter(bot => (options.botIds || []).includes(bot.id))
            const conv = { id, kind: 'group', name: options.name, ownerId: state.me.id,
              memberIds: [state.me.id].concat(options.memberIds || [], bots.map(bot => bot.id)),
              botMembers: bots.map(bot => ({ ...bot, ownerId: state.me.id })),
              allowOthersMention: options.allowOthersMention === true, unread: 0, updatedAt: Date.now() }
            state.conversations.unshift(conv); state.messages[id] = []
            return route.fulfill({ json: { id, state } })
          }
          if (pathname === '/api/group/settings') {
            const options = route.request().postDataJSON()
            const conv = state.conversations.find(row => row.id === options.conversationId)
            conv.allowOthersMention = options.allowOthersMention === true
            return route.fulfill({ json: { ok: true, state } })
          }
          if (pathname === '/api/read') {
            const options = route.request().postDataJSON()
            const conv = state.conversations.find(row => row.id === options.conversationId)
            if (conv) conv.unread = 0
            return route.fulfill({ json: { ok: true, state } })
          }
          const body = assets.get(pathname)
          if (body !== undefined) return route.fulfill({
            contentType: pathname.endsWith('.html') ? 'text/html; charset=utf-8'
              : pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            body,
          })
          throw new Error(`Unexpected LAN chat request: ${pathname}`)
        })
        await page.goto('http://world-chat.test/app.html')
      } else {
        await page.goto(pathToFileURL(join(root, 'lan-chat/prototype.html')).href)
      }

      const input = page.locator('#lcInput')
      const outgoing = page.locator('.lc-msg.out')
      const send = page.locator('#lcSend')
      await input.waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.querySelector('#lcChatHead strong'))
      if (mode === 'live') {
        await page.evaluate(() => window.postMessage({ type: 'world-dsh-theme', theme: 'dark', colors: {
          'bg-base': 'rgb(21, 21, 23)', 'bg-layer-1': 'rgb(30, 32, 36)', 'bg-layer-2': 'rgb(39, 42, 48)',
          'bg-layer-3': 'rgb(48, 52, 60)', 'label-primary': 'rgb(249, 250, 251)',
          'label-secondary': 'rgb(190, 196, 205)', 'label-tertiary': 'rgb(140, 148, 160)',
          'border-l2': 'rgb(65, 70, 80)', 'border-l3': 'rgb(75, 80, 90)',
          'interactive-bg-hover': 'rgb(50, 55, 65)', 'interactive-bg-active': 'rgb(60, 65, 75)',
          'state-business-primary': 'rgb(90, 130, 255)',
        } }, location.origin))
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lc-bg').trim()),
          'rgb(21, 21, 23)', 'live chat surface follows the host dark theme')
        assert.equal(await page.locator('#lcTheme').count(), 0, 'chat does not expose its own theme toggle')
        await page.evaluate(() => window.postMessage({ type: 'world-dsh-theme', theme: 'light', colors: {
          'bg-base': 'rgb(255, 255, 255)', 'bg-layer-1': 'rgb(247, 249, 253)', 'bg-layer-2': 'rgb(241, 243, 245)',
          'label-primary': 'rgb(23, 35, 60)', 'label-secondary': 'rgb(100, 110, 130)',
          'label-tertiary': 'rgb(145, 155, 175)', 'border-l2': 'rgb(225, 230, 238)',
          'interactive-bg-hover': 'rgb(235, 240, 250)', 'interactive-bg-active': 'rgb(225, 233, 250)',
          'state-business-primary': 'rgb(59, 110, 246)',
        } }, location.origin))
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')

        await page.locator('#lcNewGroup').click()
        assert.equal(await page.locator('#lcGroupBots [data-bot-member].on').count(), 0, 'models start unchecked')
        assert.equal(await page.locator('#lcAllowOthersMention').isChecked(), false, 'other-member @ starts disabled')
        await page.locator('#lcGroupName').fill('邀请模型测试')
        await page.locator('#lcGroupBots [data-bot-member]').click()
        await page.locator('[data-modal="create"]').click()
        await page.waitForFunction(() => document.querySelector('#lcModalRoot').hidden)
        const group = liveState.conversations.find(row => row.name === '邀请模型测试')
        assert.deepEqual(group.botMembers.map(bot => bot.id), ['bot:test/model'])
        await page.locator('#lcDetail [data-action="group-settings"]').click()
        await page.locator('#lcAllowOthersMention').check()
        await page.locator('[data-modal="save-group-settings"]').click()
        await page.waitForFunction(() => document.querySelector('#lcModalRoot').hidden)
        assert.equal(group.allowOthersMention, true, 'group @ permission persists through the settings action')
      }
      const before = await outgoing.count()
      assert.equal(await send.isDisabled(), true, `${mode}: empty input cannot send`)

      // The input method owns candidate-confirmation Enter, including the legacy 229 signal.
      for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
        await input.fill('中文候选词确认')
        const prevented = await input.evaluate((element, flags) => {
          const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...flags })
          element.dispatchEvent(event)
          return event.defaultPrevented
        }, flags)
        assert.equal(await outgoing.count(), before, `${mode}: candidate Enter must not send`)
        assert.equal(await input.inputValue(), '中文候选词确认', `${mode}: candidate text stays in composer`)
        assert.equal(prevented, false, `${mode}: input method keeps its default Enter handling`)
      }
      if (shots) await page.screenshot({ path: join(shots, `chat-ime-${mode}.png`), animations: 'disabled' })

      await input.fill('第一行')
      await input.press('Shift+Enter')
      await page.keyboard.insertText('第二行')
      assert.equal(await input.inputValue(), '第一行\n第二行', `${mode}: Shift+Enter still inserts a newline`)
      assert.equal(await outgoing.count(), before, `${mode}: Shift+Enter does not send`)

      await input.fill('中文确认后发送')
      await input.press('Enter')
      await page.waitForFunction(expected => document.querySelectorAll('.lc-msg.out').length === expected, before + 1)
      assert.equal(await outgoing.last().locator('.lc-bubble').innerText(), '中文确认后发送')
      assert.equal(await input.inputValue(), '', `${mode}: ordinary Enter clears the sent text`)
      assert.equal(await send.isDisabled(), true)
      if (shots) await page.screenshot({ path: join(shots, `chat-sent-${mode}.png`), animations: 'disabled' })

      await input.fill('点击发送')
      await send.click()
      await page.waitForFunction(expected => document.querySelectorAll('.lc-msg.out').length === expected, before + 2)
      assert.equal(await outgoing.last().locator('.lc-bubble').innerText(), '点击发送')
      assert.equal(await input.inputValue(), '')
      assert.deepEqual(errors, [], `${mode}: no uncaught browser errors`)
      console.log(`LAN chat ${mode}: candidate Enter sent 0, ordinary Enter sent 1, button sent 1; Shift+Enter preserved.`)
    } finally {
      await page.close()
    }
  }
}
