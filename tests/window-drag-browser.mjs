import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/** Real pointer gestures must stay local to the moving window and preserve final geometry. */
export async function checkWindowDrag(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('http://127.0.0.1/world-drag', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.goto('http://127.0.0.1/world-drag')
    await page.evaluate(() => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode']))
      window.__dragCommits = 0
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1,
        onCommitFiberRoot: () => { window.__dragCommits++ }, onCommitFiberUnmount() {} }
      document.addEventListener('pointerdown', event => { window.__dragPointerId = event.pointerId })
    })
    await page.addScriptTag({ content: bundleText })
    await page.locator('[data-world-icon-id="vscode"]').dblclick()
    await page.getByRole('button', { name: 'src', exact: true }).click()
    const source = Array.from({ length: 2000 }, (_, i) => `const value${i} = ${i}; // drag fixture`).join('\n')
    await page.evaluate(source => window.__worldTesting.setFile('/workspace/src/main.js', source), source)
    await page.getByRole('button', { name: 'main.js', exact: true }).click()
    const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
    const input = editor.locator('.world-vscode-textarea')
    await input.waitFor()
    await page.waitForTimeout(300)
    const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1, `${message}: ${actual} != ${expected}`)
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const begin = async locator => {
      const box = await locator.boundingBox()
      const x = box.x + Math.min(150, box.width / 2), y = box.y + box.height / 2
      await page.mouse.move(x, y); await page.mouse.down(); await settled()
      return { x, y }
    }
    await input.evaluate(node => { node.scrollTop = 22000; node.setSelectionRange(80, 80) })
    const scroll = await input.evaluate(node => node.scrollTop)
    const before = await editor.boundingBox(), bar = editor.locator('.world-vscode-titlebar')
    const start = await begin(bar)
    await page.evaluate(() => { window.__dragCommits = 0 })
    for (let i = 1; i <= 60; i++) await page.mouse.move(start.x + i * 2, start.y + i / 2)
    await settled()
    const commits = await page.evaluate(() => window.__dragCommits)
    assert.ok(commits < 10, `60 pointer moves must not rerender the desktop each time; commits=${commits}`)
    const during = await editor.boundingBox()
    close(during.x, before.x + 120, 'live horizontal position')
    close(during.y, before.y + 30, 'live vertical position')
    await page.mouse.up(); await settled()
    const after = await editor.boundingBox()
    close(after.x, during.x, 'release keeps horizontal position')
    close(after.y, during.y, 'release keeps vertical position')
    close(after.width, before.width, 'drag preserves width')
    close(after.height, before.height, 'drag preserves height')
    assert.equal(await input.inputValue(), source, 'drag preserves the draft')
    close(await input.evaluate(node => node.scrollTop), scroll, 'drag preserves editor scroll')
    const transientStyles = () => editor.evaluate(node => ['left', 'top', 'width', 'height', 'transition'].map(key => node.style[key]))
    assert.deepEqual(await transientStyles(), ['', '', '', '', ''])
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.vscode.window')))
    close(saved.x * 14.4, after.x, 'saved horizontal position')
    close(saved.y * 10, after.y, 'saved vertical position')

    // Release/cancel before rAF gets a turn: commit the latest event and cancel its queued paint.
    const cancelStart = await begin(bar)
    await bar.evaluate((node, point) => {
      const event = { bubbles: true, pointerId: window.__dragPointerId, clientX: point.x - 30, clientY: point.y - 20, buttons: 1 }
      node.dispatchEvent(new PointerEvent('pointermove', event))
      node.dispatchEvent(new PointerEvent('pointercancel', event))
    }, cancelStart)
    await page.mouse.up(); await settled()
    const cancelled = await editor.boundingBox()
    close(cancelled.x, after.x - 30, 'cancel commits latest x before queued paint')
    close(cancelled.y, after.y - 20, 'cancel commits latest y before queued paint')
    assert.deepEqual(await transientStyles(), ['', '', '', '', ''])

    // The editor is a standalone window: interrupt its own capture, release outside and return with no buttons.
    for (const [handle, reason] of [[bar, 'capture'], [editor.locator('.world-vscode-resize-se'), 'blur'], [bar, 'buttons']]) {
      const point = await begin(handle)
      await page.mouse.move(point.x - 18, point.y - 8, { steps: 3 }); await settled()
      const preview = await editor.boundingBox()
      await handle.evaluate((node, reason) => {
        const id = window.__dragPointerId
        if (reason === 'capture') node.releasePointerCapture(id)
        if (reason === 'blur') window.dispatchEvent(new Event('blur'))
        if (reason === 'buttons') node.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerId:id, buttons:0, clientX:10, clientY:10 }))
      }, reason)
      await page.mouse.move(1420, 960); await page.mouse.up(); await settled()
      const barBox = await bar.boundingBox(); await page.mouse.move(barBox.x + 130, barBox.y + 12); await settled()
      const end = await editor.boundingBox()
      for (const k of ['x','y','width','height']) close(end[k], preview[k], `${reason}: hover after interruption must not change ${k}`)
      assert.deepEqual(await transientStyles(), ['', '', '', '', ''])
    }
    const beforeResize = await editor.boundingBox()
    const resizeStart = await begin(editor.locator('.world-vscode-resize-se'))
    await page.mouse.move(resizeStart.x - 40, resizeStart.y - 30, { steps: 10 })
    await settled()
    const resizing = await editor.boundingBox()
    close(resizing.width, beforeResize.width - 40, 'live resize width')
    close(resizing.height, beforeResize.height - 30, 'live resize height')
    await page.mouse.up(); await settled()
    const resized = await editor.boundingBox()
    close(resized.width, resizing.width, 'resize release width')
    close(resized.height, resizing.height, 'resize release height')
    assert.equal(await input.inputValue(), source)
    assert.deepEqual(await transientStyles(), ['', '', '', '', ''])

    await begin(bar)
    await bar.evaluate(node => {
      node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: window.__dragPointerId, clientX: 500, clientY: 200, buttons: 1 }))
      window.__worldTesting.dispose()
    })
    await page.mouse.up(); await settled()
    assert.equal(await editor.count(), 0, 'unmount clears the queued drag paint')
    assert.deepEqual(errors, [])
    console.log(`Window drag passed: ${JSON.stringify({ moves: 60, commits, before, during, after, cancelled, resized })}; draft, scroll, persistence, cancellation and unmount preserved.`)
  } finally { await page.close() }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/window-drag-browser.mjs')) {
  const { createRequire } = await import('node:module')
  const { build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')
  const { chromium } = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))('playwright-core')
  const bundle = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['tests/browser-entry.js'],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [fileURLToPath(new URL('../../workflow-studio/node_modules', import.meta.url))], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkWindowDrag(browser, bundle.outputFiles[0].text) } finally { await browser.close() }
}
