import assert from 'node:assert/strict'

const FIXTURE_HTML = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{position:relative;width:100vw;height:100vh;background:#123}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

/** The page rasterizes its own DOM; titlebar is cropped and browser guests are redacted. */
export async function checkDesktopScreenshot(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.route('http://127.0.0.1/world-shot-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE_HTML }))
    await page.goto('http://127.0.0.1/world-shot-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    await page.evaluate(() => {
      const marker = document.createElement('div')
      marker.id = 'shot-marker-top'
      marker.style.cssText = 'position:fixed;left:0;top:4px;width:24px;height:12px;background:#ff00ff;z-index:2147483000'
      const visible = document.createElement('div')
      visible.id = 'shot-marker-visible'
      visible.style.cssText = 'position:fixed;left:0;top:60px;width:24px;height:12px;background:#00ff00;z-index:2147483000'
      const guest = document.createElement('webview')
      guest.id = 'shot-fake-guest'
      guest.style.cssText = 'position:fixed;left:600px;top:400px;width:120px;height:80px;background:#ff0000;z-index:2147482000'
      document.body.append(marker, visible, guest)
    })
    const shot = await page.evaluate(async () => {
      const result = await window.__worldTesting.capture({ maxWidth: 0 })
      const image = new Image()
      image.src = result.dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data)
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      let opaque = 0
      for (let index = 3; index < data.length; index += 4) if (data[index] > 0) opaque++
      return { ...result, dataUrl: undefined, imageSize: { width: image.width, height: image.height },
        topMarker: pixel(8, 4), visibleMarker: pixel(8, 26), guest: pixel(610, 370),
        bottom: pixel(640, 750), opaque }
    })
    assert.equal(shot.imageSize.width, 1280)
    assert.equal(shot.imageSize.height, 760, 'the 40px titlebar must be cropped')
    assert.equal(shot.region.y, 40)
    assert.deepEqual(shot.visibleMarker.slice(0, 3), [0, 255, 0], 'content below the titlebar is captured')
    assert.notDeepEqual(shot.topMarker.slice(0, 3), [255, 0, 255], 'content above the titlebar is cropped out')
    assert.deepEqual(shot.guest.slice(0, 3), [21, 27, 34], 'browser guest content is replaced by a placeholder')
    assert.ok(shot.redacted.includes('webview'))
    assert.ok(shot.bottom[3] > 0)
    assert.ok(shot.opaque > 1280 * 760 * .5, 'most of the desktop should be rendered')

    const scaled = await page.evaluate(async () => {
      const result = await window.__worldTesting.capture({ maxWidth: 640 })
      return { width: result.width, height: result.height, scale: result.scale, prefix: result.dataUrl.slice(0, 22) }
    })
    assert.equal(scaled.width, 640)
    assert.equal(scaled.height, 380)
    assert.equal(scaled.scale, .5)
    assert.match(scaled.prefix, /^data:image\/png;base64,/)
    const jpeg = await page.evaluate(async () => (await window.__worldTesting.capture({ format: 'jpeg', maxWidth: 320 })).dataUrl.slice(0, 23))
    assert.match(jpeg, /^data:image\/jpeg;base64,/)
    assert.deepEqual(errors, [])
    console.log(`Desktop screenshot passed: ${shot.imageSize.width}×${shot.imageSize.height} crop, guest redaction, opaque ${(shot.opaque / (1280 * 760) * 100).toFixed(1)}%, scale and jpeg.`)
  } finally {
    await page.close()
  }
}
