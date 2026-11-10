import assert from 'node:assert/strict'

/** The robot must keep its walk cycle under reduced motion and never stand inside an icon. */
export async function checkWalkerMotion(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.setContent('<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
    await page.evaluate(() => {
      window.__walkerSamples = []
      const tick = () => {
        const host = document.querySelector('.world-walker')
        if (host) {
          const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(host.style.transform || '')
          const wrap = host.parentElement.getBoundingClientRect()
          window.__walkerSamples.push({
            walking: host.dataset.walking,
            x: m ? Number(m[1]) + wrap.left + 42 : null,
            y: m ? Number(m[2]) + wrap.top + 148 : null,
            leg: getComputedStyle(host.querySelector('.wn-leg-a')).animationName,
            icons: [...document.querySelectorAll('.world-desktop-icon')].map(el => el.getBoundingClientRect().toJSON()),
          })
          if (window.__walkerSamples.length > 900) window.__walkerSamples.shift()
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.mouse.move(900, 660)
    await page.waitForTimeout(500)
    await page.mouse.move(70, 650)
    await page.waitForTimeout(3500)
    const result = await page.evaluate(() => {
      const samples = window.__walkerSamples.filter(sample => sample.x != null)
      const walking = samples.filter(sample => sample.walking === 'on')
      const inside = samples.filter(sample => sample.icons.some(rect => sample.x > rect.left + 0.5 && sample.x < rect.right - 0.5
        && sample.y > rect.top + 0.5 && sample.y < rect.bottom - 0.5))
      return { frames: samples.length, walking: walking.length,
        walkingLegs: [...new Set(walking.map(sample => sample.leg))],
        inside: inside.length, end: samples.at(-1) && { x: Math.round(samples.at(-1).x), y: Math.round(samples.at(-1).y) } }
    })
    assert.ok(result.frames > 0)
    assert.ok(result.walking > 0, 'the robot must actually walk toward the pointer')
    assert.deepEqual(result.walkingLegs, ['world-walk-leg-a'], 'reduced motion must not remove the walk cycle')
    assert.equal(result.inside, 0, 'the robot must walk around icons instead of entering their body')
    assert.ok(result.end)
    console.log(`Walker motion passed: ${JSON.stringify(result)}; reduced-motion gait kept, full-rect icon avoidance.`)
  } finally {
    await page.close()
  }
}
