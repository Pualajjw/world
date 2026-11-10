import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopBridge } from '../desktop-bridge.js'
import { desktopToolDefinitions } from '../desktop-tools.js'
import { waitForDesktop } from '../desktop-client.js'

/** Deliberately deliver a captured old state after the user changed ownership in the actual UI. */
export async function checkOwnershipOrdering(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const bridge = createDesktopBridge()
  const tool = desktopToolDefinitions({ bridge }).find(tool => tool.name === 'world_desktop_state')
  let currentControl = null, holdNextReply = false, held = null
  const off = bridge.subscribe(event => { if (event.connected) currentControl = event.state.control })
  try {
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldDesktopCall', async (_source, operation, payload) => {
      if (operation === 'reply' && holdNextReply) {
        holdNextReply = false
        await new Promise(resolve => { held = { capturedOwner: payload.result.value.state.control.owner, release: resolve } })
      }
      return bridge.call(operation, payload)
    })
    await page.setContent('<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:40px;box-sizing:border-box}#host-ui{position:absolute;inset:40px 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    await waitForDesktop(() => bridge.list().length === 1)
    const button = page.locator('[data-world-control-button]')
    assert.equal(await button.getAttribute('aria-pressed'), 'false')

    holdNextReply = true
    const beforeGrant = tool.execute({})
    await waitForDesktop(() => held)
    assert.equal(held.capturedOwner, 'human')
    await button.click()
    await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
    await waitForDesktop(() => currentControl?.owner === 'assistant')
    const grantedRevision = currentControl.revision
    held.release()
    const granted = await beforeGrant
    assert.equal(granted.state.control.owner, 'assistant', 'tool and handoff button agree despite the delayed human reply')
    assert.equal(granted.state.control.revision, grantedRevision)
    assert.equal(granted.state.control.controlId, currentControl.controlId)
    const normal = await tool.execute({})
    assert.equal(normal.state.control.owner, 'assistant')
    assert.equal(normal.state.control.revision, grantedRevision)

    if (process.env.WORLD_OWNERSHIP_SHOTS_DIR) {
      await mkdir(process.env.WORLD_OWNERSHIP_SHOTS_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.WORLD_OWNERSHIP_SHOTS_DIR, 'ownership-after-handoff.png'), animations: 'disabled' })
    }

    held = null
    holdNextReply = true
    const beforeTakeover = tool.execute({})
    await waitForDesktop(() => held)
    assert.equal(held.capturedOwner, 'assistant')
    await page.mouse.click(630, 300)
    await waitForDesktop(() => currentControl?.owner === 'human')
    const takeoverRevision = currentControl.revision
    held.release()
    const revoked = await beforeTakeover
    assert.equal(revoked.state.control.owner, 'human', 'a delayed assistant reply cannot reverse a real takeover')
    assert.equal(revoked.state.control.revision, takeoverRevision)
    assert.ok(takeoverRevision > grantedRevision)
    assert.equal(revoked.state.control.controlId, null)
    assert.equal(await button.getAttribute('aria-pressed'), 'false')
    const report = { oldHumanReplyAfterGrant: granted.state.control, oldAssistantReplyAfterTakeover: revoked.state.control,
      interfaceMatchesTool: true }
    if (process.env.WORLD_OWNERSHIP_SHOTS_DIR)
      await writeFile(join(process.env.WORLD_OWNERSHIP_SHOTS_DIR, 'ownership-ordering.json'), JSON.stringify(report, null, 2))
    console.log(`Ownership ordering passed: tool/UI assistant at revision ${grantedRevision}, human takeover at revision ${takeoverRevision}; both stale reply directions rejected.`)
    await page.evaluate(() => window.__worldTesting.dispose())
  } finally {
    held?.release()
    off()
    bridge.dispose()
    await page.close()
  }
}
