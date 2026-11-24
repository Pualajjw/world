import assert from 'node:assert/strict'

// This fixture alone forces GC. Used JS heap is comparable across cycles;
// reserved V8 space and the renderer's working set need not fall immediately.
export async function checkEditorMemory(page, bytes) {
  const cdp = await page.context().newCDPSession(page)
  const editor = page.locator('[data-world-vscode-key]'), viewer = editor.locator('.cm-editor:visible')
  const body = viewer.locator('.cm-content'), scroller = viewer.locator('.cm-scroller')
  const file = name => editor.getByRole('button', { name, exact: true })
  const tab = name => editor.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })
  const close = name => editor.getByRole('button', { name: `关闭标签 ${name}`, exact: true }).click()
  const usedMiB = async () => (await cdp.send('Runtime.getHeapUsage')).usedSize / (1024 ** 2)
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const sample = async phase => {
    await settle()
    const beforeGC = await usedMiB()
    // Allow in-flight browser callbacks to finish before classifying a detached view as retained.
    await page.waitForTimeout(350)
    await cdp.send('HeapProfiler.collectGarbage'); await settle(); await cdp.send('HeapProfiler.collectGarbage')
    const live = await usedMiB(), { nodes, jsEventListeners } = await cdp.send('Memory.getDOMCounters')
    const viewRefs = await page.evaluate(() => window.__pastViews.filter(ref => ref.deref()).length)
    console.log(JSON.stringify({ phase, beforeGC: +beforeGC.toFixed(2), liveMiB: +live.toFixed(2), nodes, jsEventListeners, viewRefs }))
    return { live, viewRefs }
  }
  const atEnd = () => page.waitForFunction(() => [...document.querySelectorAll('.cm-editor .cm-line')].some(n => n.textContent === '2000000'))
  await page.evaluate(() => { window.__pastViews = [] })
  await file('small.txt').dblclick(); await editor.locator('textarea.world-vscode-textarea').waitFor()
  const baseline = await sample('small-baseline'), fileMiB = bytes / (1024 ** 2)
  const loadCount = () => page.evaluate(() => window.__worldTesting.calls.filter(c => c.method === 'world-vscode-source/open').length)
  try {
    for (let i = 1; i <= 4; i++) {
      await file('numbers.txt').dblclick(); await viewer.waitFor()
      await viewer.evaluate(node => { window.__pastViews.push(new WeakRef(node)) })
      if (i === 1) {
        await body.focus(); await body.press('Control+Home'); await body.press('Shift+ArrowRight')
      }
      await scroller.evaluate(node => { node.scrollTop = node.scrollHeight }); await atEnd(); await settle()
      await sample(`open-${i}`)
      await tab('small.txt').click(); await editor.locator('textarea.world-vscode-textarea:visible').waitFor()
      const hidden = await sample(`hidden-${i}`)
      assert.equal(hidden.viewRefs, 0, 'invisible tab must not own the CodeMirror view/document tree')
      assert.ok(hidden.live < baseline.live + fileMiB * 1.5, 'hidden tab should retain the raw text, not its layout')
      if (i === 1 || i === 4) {
        const loads = await loadCount(), start = performance.now()
        await tab('numbers.txt').click(); await atEnd()
        console.log(`Resume existing tab: ${Math.round(performance.now() - start)} ms`)
        assert.equal(await loadCount(), loads, 'resuming a tab must not reload a possibly changed file')
        await viewer.evaluate(node => { window.__pastViews.push(new WeakRef(node)) })
        if (i === 1) {
          // The selection is at the beginning and the scroll anchor is at EOF: restore both independently.
          const selected = await body.evaluate(node => {
            const data = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy', { bubbles:true, cancelable:true, clipboardData:data }))
            return data.getData('text/plain')
          })
          assert.equal(selected, '1')
        }
      }
      await close('numbers.txt'); await tab('numbers.txt').waitFor({ state:'detached' })
      const closed = await sample(`closed-${i}`)
      assert.equal(closed.viewRefs, 0)
      assert.ok(closed.live < baseline.live + fileMiB / 2, 'old callbacks must not keep even one closed file body')
    }
    await file('numbers.txt').dblclick(); await viewer.waitFor()
    await viewer.evaluate(node => { window.__pastViews.push(new WeakRef(node)) })
    await editor.getByRole('button', { name: '关闭 Visual Studio Code', exact: true }).click()
    await editor.waitFor({ state: 'detached' })
    const shut = await sample('window-closed')
    assert.equal(shut.viewRefs, 0)
    assert.ok(shut.live < baseline.live + fileMiB / 2)
    await page.locator('[data-world-icon-id="vscode"]').dblclick(); await file('numbers.txt').waitFor()
  } finally { await cdp.detach() }
}
