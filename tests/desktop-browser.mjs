import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopToolDefinitions } from '../desktop-tools.js'

/** Drive actual tool definitions through the Host mailbox into the rendered React desktop. */
export async function checkDesktopTools(page, bridge, brain) {
  const exec = { agent: { session: { id: 'session-1' } } }
  const tools = desktopToolDefinitions({ bridge, brain,
    sessions: { get: id => id === 'session-1' ? { header: { cwd: '/workspace' } } : null },
    editor: { async call(_operation, payload) {
      if (payload.path === 'outside') throw Object.assign(new Error('outside workspace'), { code: 'FS_SANDBOX_DENIED' })
      return { path: payload.path.startsWith('/') ? payload.path : `/workspace/${payload.path}` }
    } },
  })
  const inspect = () => tools[0].execute({}, exec)
  const act = async args => {
    let snapshot = await inspect()
    if (snapshot.state.control.owner === 'human') {
      await page.locator('[data-world-control-button]').click()
      await page.waitForFunction(() => document.querySelector('[data-world-control-button]').getAttribute('aria-pressed') === 'true')
      snapshot = await inspect()
    }
    return tools[1].execute({ ...args, controlId: snapshot.state.control.controlId }, exec)
  }
  const initial = await inspect()
  assert.ok(initial.desktopId)
  assert.ok(initial.state.apps.find(app => app.id === 'vscode'))
  if (!initial.state.apps.find(app => app.id === 'vscode').installed) {
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await page.locator('[data-world-app-card="vscode"] .world-app-install').click()
    await page.keyboard.press('Escape')
  }
  const opened = await act({ action: 'open_file', path: 'src/main.js', line: 1, column: 7 })
  const id = opened.windowId
  const editorState = result => result.state.windows.find(win => win.id === id).editor
  assert.equal(opened.state.activeWindow, id)
  assert.equal(editorState(opened).activePath, '/workspace/src/main.js')
  assert.deepEqual(editorState(opened).caret, { line: 1, column: 7 })
  assert.equal(editorState(opened).files[0].pinned, true)
  const window = page.locator(`[data-world-vscode-key="${id.slice(7)}"]`)
  const input = window.locator('textarea.world-vscode-textarea')
  await input.fill('const localDraft = true\n')
  const dirty = await inspect()
  assert.equal(editorState(dirty).dirty, true)
  assert.ok(!JSON.stringify(dirty).includes('localDraft'), 'desktop state does not export draft contents')
  await act({ action: 'open_file', path: 'README.md' })
  assert.equal(await window.locator('.world-vscode-tab').count(), 2)
  await page.evaluate(() => window.__worldTesting.setFile('/workspace/README.md', '# Updated by the agent\n'))
  await assert.rejects(act({ action: 'open_file', path: 'src/main.js', refresh: true }), { code: 'WORLD_DESKTOP_DIRTY' })
  await act({ action: 'open_file', path: 'src/main.js', column: 4 })
  assert.equal(await input.inputValue(), 'const localDraft = true\n', 'reopening preserves the user draft')
  assert.deepEqual(editorState(await inspect()).caret, { line: 1, column: 4 })
  await assert.rejects(act({ action: 'open_file', path: 'outside' }), { code: 'FS_SANDBOX_DENIED' })
  const refreshed = await act({ action: 'open_file', path: 'README.md', refresh: true })
  assert.equal(editorState(refreshed).activePath, '/workspace/README.md')
  assert.equal(await input.inputValue(), '# Updated by the agent\n', 'refresh displays the current disk contents')
  assert.equal(editorState(refreshed).files.find(file => file.path.endsWith('main.js')).dirty, true)
  const clamped = await act({ action: 'open_file', path: 'README.md', line: 999999, column: 999999 })
  assert.deepEqual(editorState(clamped).caret, { line: 2, column: 1 })
  assert.match(await window.locator('.world-vscode-highlight-rows').innerText(), /Updated by the agent/,
    'an out-of-range location still renders the text')

  await act({ action: 'maximize_window', windowId: id })
  await act({ action: 'minimize_window', windowId: id })
  await act({ action: 'minimize_window', windowId: id })
  const focused = await act({ action: 'focus_window', windowId: id })
  assert.equal(focused.state.windows.find(win => win.id === id).state, 'max')
  await act({ action: 'restore_window', windowId: id })
  await act({ action: 'open_app', appId: 'dsh' })
  const front = await act({ action: 'focus_window', windowId: id })
  assert.equal(front.state.activeWindow, id)
  assert.equal(editorState(front).files.length, 2)
  // A model handoff must move actual keyboard focus, including when a different app owns it.
  await input.fill('# Saved after the model handoff\n')
  await act({ action: 'open_app', appId: 'dsh' })
  await page.locator('#host-focus').click()
  await act({ action: 'focus_window', windowId: id })
  assert.equal(await input.evaluate(node => document.activeElement === node), true,
    'model focus_window hands the keyboard to the visible editor')
  const beforeSave = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length)
  await page.keyboard.press('Control+s')
  await page.waitForFunction(before => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length === before + 1, beforeSave)
  const saved = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').at(-1).payload)
  assert.equal(saved.path, '/workspace/README.md')
  assert.equal(saved.source, '# Saved after the model handoff\n')

  // If the editor is already active, focusing from an open start menu must still reclaim the keyboard.
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await act({ action: 'focus_window', windowId: id })
  assert.equal(await input.evaluate(node => document.activeElement === node), true)

  // A different editor's last pointer ownership must not receive this editor's shortcuts.
  // 同一个文件夹只有一个窗口，第二个编辑器改用子目录（换文件夹才开新窗口）。
  await page.keyboard.press('Escape')
  await window.locator('.world-vscode-title-btn').click()
  await page.locator('.world-vscode-picker').waitFor()
  await page.locator('.world-vscode-picker-row').filter({ hasText: 'src' }).click()
  await page.locator('.world-vscode-picker').getByRole('button', { name: '在新窗口打开' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  const other = page.locator('.world-vscode-window[data-world-vscode-key]').last()
  await other.locator('.world-vscode-titlebar').click()
  await act({ action: 'focus_window', windowId: id })
  const sidebar = window.locator('.world-vscode-sidebar')
  const otherSidebar = other.locator('.world-vscode-sidebar')
  assert.equal(await sidebar.count(), 1)
  await page.keyboard.press('Control+b')
  assert.equal(await sidebar.count(), 0, 'the handed-off editor owns Ctrl+B')
  assert.equal(await otherSidebar.count(), 1, 'the other editor is unaffected')
  await page.keyboard.press('Control+b')
  await act({ action: 'focus_window', windowId: `vscode:${await other.getAttribute('data-world-vscode-key')}` })
  // The full conversation panel intentionally covers the right edge; explicitly take over first.
  await page.locator('[data-world-takeover]').click()
  await other.getByRole('button', { name: '关闭 Visual Studio Code', exact: true }).click()
  await act({ action: 'focus_window', windowId: id })

  // An open folder picker keeps the keyboard inside its modal after a model handoff.
  await page.keyboard.press('Control+Shift+O')
  const picker = window.locator('.world-vscode-picker-card')
  await picker.waitFor()
  await act({ action: 'open_app', appId: 'dsh' })
  await page.locator('#host-focus').click()
  await act({ action: 'focus_window', windowId: id })
  assert.equal(await picker.evaluate(node => node.contains(document.activeElement)), true)
  const savesAtPicker = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length)
  await page.keyboard.press('Control+s')
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), savesAtPicker)
  await page.keyboard.press('Escape')
  await picker.waitFor({ state: 'detached' })

  await assert.rejects(act({ action: 'focus_window', windowId: 'missing' }), { code: 'WORLD_DESKTOP_WINDOW' })
  await assert.rejects(act({ action: 'open_app', appId: 'missing' }), { code: 'WORLD_DESKTOP_APP' })
  const plugin = await act({ action: 'open_app', appId: 'plugin:workflow-studio' })
  assert.equal(plugin.state.activeWindow, 'plugin:workflow-studio')
  await act({ action: 'focus_window', windowId: id })

  if (process.env.WORLD_DESKTOP_SHOTS_DIR) {
    await mkdir(process.env.WORLD_DESKTOP_SHOTS_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.WORLD_DESKTOP_SHOTS_DIR, 'desktop-tools.png'), animations: 'disabled' })
  }
  console.log('Desktop tools passed: real receipts, file/line reveal, window operations, dirty drafts, explicit refresh, invalid targets, plugin opening, keyboard handoff, isolated shortcuts, modal focus.')
}
