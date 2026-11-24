import assert from 'node:assert/strict'
import { join } from 'node:path'

// Real HTML drags: start with both files in one strip, then reposition the whole
// group around the other one. A drop on a child's bottom strip must still split.
export async function checkPainterGroupDrag(page, editor, shots) {
  for (const [first, second, edges] of [
    ['w_drag.srw', 'uo_drag.sru', ['right', 'bottom']],
    ['d_test.srd', 'm_test.srm', ['left', 'top']],
  ]) {
    const open = async name => {
      await editor.getByRole('button', { name, exact: true }).dblclick()
      const tab = editor.locator('[data-parent-tab]').filter({ hasText: name })
      const id = await tab.getAttribute('data-parent-tab')
      const body = editor.locator(`[data-parent-content="${id}"]`)
      await body.locator('[data-srw-view]').first().waitFor()
      const pane = editor.locator('.world-vscode-pane:not([data-world-scope])').filter({ has: page.locator(`[data-parent-tab="${id}"]`) })
      const layout = () => body.locator(':scope > .world-vscode-pane').evaluateAll(nodes => nodes.map(p => [
        p.style.cssText, p.querySelector('[role=tablist]').dataset.worldActive,
        [...p.querySelectorAll('[role=tab]')].map(t => t.dataset.tabId),
      ]))
      return { tab, body, pane, layout, before: await layout() }
    }
    const a = await open(first), b = await open(second)
    for (const [i, edge] of edges.entries()) {
      const [source, target] = i ? [b, a] : [a, b]
      const start = await source.tab.boundingBox(), end = await target.body.boundingBox()
      const x = end.x + (edge === 'left' ? 16 : edge === 'right' ? end.width - 16 : end.width * .4)
      const y = end.y + (edge === 'top' ? 4 : edge === 'bottom' ? end.height - 4 : end.height / 2)
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
      await page.mouse.down(); await page.mouse.move(x, y, { steps: 12 }); await page.mouse.move(x, y)
      try { await target.pane.locator(`:scope > .world-vscode-pane-preview.is-${edge}`).waitFor({ timeout: 3000 }) }
      finally { await page.mouse.up() }
      const s = await source.pane.boundingBox(), t = await target.pane.boundingBox()
      const horizontal = edge === 'left' || edge === 'right'
      const [before, after] = edge === 'left' || edge === 'top' ? [s, t] : [t, s]
      const axis = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height'
      assert.ok(Math.abs(after[axis] - (before[axis] + before[size])) < 1, `panes are adjacent: ${edge}`)
      assert.ok(Math.abs(s[size] - t[size]) < 1, `split halves: ${edge}`)
      assert.deepEqual(await a.layout(), a.before); assert.deepEqual(await b.layout(), b.before)
      console.log(`Painter group ${edge}:`, JSON.stringify([s, t]))
      await editor.screenshot({ path: join(shots, `groups-${edge}.png`) })
    }
    // The outer strip still merges whole tabs rather than nesting the two groups.
    await a.tab.dragTo(b.tab)
    assert.equal(await editor.locator('.world-vscode-pane:not([data-world-scope])').count(), 1)
    await a.tab.getByRole('button').click(); await b.tab.getByRole('button').click()
  }
}
