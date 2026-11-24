import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Exercise the real painter, including the native Properties picker. Record heap deltas,
// not pass/fail timing or MiB limits: those vary with Chromium and unrelated desktop work.
export async function profileSelection(page, editor, group, shots) {
  const count = 1200
  await page.evaluate(n => {
    window.__dense = 'datawindow(units=1) detail(height=2400)\n' + Array.from({length:n}, (_, i) => {
      const type = i === 0 ? 'groupbox' : 'text', band = i === n-1 ? 'foreground' : 'detail'
      return `${type}(band=${band} name=c${i} text="label ${i}" x=${(i%10)*60} y=${Math.floor(i/10)*20} width=60 height=20 font.height=-9)`
    }).join('\n')
  }, count)
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
  try {
    const before = await heap()
    await editor.getByRole('button',{name:'d_dense.srd',exact:true}).dblclick()
    const foreground = group.getByRole('button',{name:`text c${count-1}`,exact:true}); await foreground.waitFor({state:'attached'})
    assert.equal(await group.locator('.world-srd-object').count(), count)
    // Use a nested caption click as well as a foreground button. Do not bring offscreen
    // objects into view: this measures selection work, not automated pointer scrolling.
    const result = await group.evaluate(async (el, n) => {
      const picker = el.querySelector('select'), first = el.querySelector('[aria-label="groupbox c0"]'), last = el.querySelector(`[aria-label="text c${n-1}"]`)
      const run = async () => {
        const start = performance.now()
        for (let i = 0; i < 24; i++) {
          const target = i % 2 ? last : first, previous = i % 2 ? first : last
          const clickTarget = target.firstElementChild || target
          clickTarget.click(); await Promise.resolve()
          if (target.getAttribute('aria-pressed') !== 'true' || previous.getAttribute('aria-pressed') !== 'false' ||
              picker.value !== (i % 2 ? `band:foreground/c${n-1}` : 'band:detail/c0')) throw Error('Canvas and Properties selection disagree')
        }
        return performance.now() - start
      }
      await run()
      window.__srdPaints = 0
      const samples = []; for (let i = 0; i < 5; i++) samples.push(await run())
      const paintsPerBatch = window.__srdPaints / samples.length
      // Count JavaScript option scans separately, without perturbing the timed runs.
      const proto = HTMLOptionElement.prototype, desc = Object.getOwnPropertyDescriptor(proto, 'value')
      let optionValueReads = 0
      const firstOption = picker.firstElementChild
      Object.defineProperty(proto, 'value', { ...desc, get() {
        if (this.parentNode === picker) optionValueReads++
        return desc.get.call(this)
      } })
      try { await run() } finally { Object.defineProperty(proto, 'value', desc) }
      if (picker.firstElementChild !== firstOption) throw Error('Choosing an object replaced the native picker options')
      return { objects:n, options:picker.length, switchesPerBatch:24, paintsPerBatch, optionValueReads, medianMs:Math.round(samples.sort((a,b)=>a-b)[2]) }
    }, count)
    result.openHeapDeltaMiB = +(((await heap())-before)/2**20).toFixed(2)
    const picker = group.getByLabel('属性对象'); await picker.selectOption('band:detail')
    assert.equal(await foreground.getAttribute('aria-pressed'), 'false'); assert.equal(await group.locator('[data-band=detail]').getAttribute('data-selected'), 'true')
    await picker.focus(); await picker.press('ArrowDown')
    assert.equal(await group.getByRole('button',{name:'groupbox c0',exact:true}).getAttribute('aria-pressed'), 'true')
    await picker.press('ArrowUp'); assert.equal(await picker.inputValue(), 'band:detail')
    await picker.selectOption(`band:foreground/c${count-1}`); assert.equal(await foreground.getAttribute('aria-pressed'),'true')
    await group.getByLabel('显示带区溢出内容').check(); assert.equal(await foreground.getAttribute('aria-pressed'),'true')
    await editor.locator('[data-parent-tab]').getByRole('button',{name:/关闭标签/}).click(); await group.waitFor({state:'detached'})
    result.closedHeapDeltaMiB = +(((await heap())-before)/2**20).toFixed(2)
    console.log('SRD selection:', result); await writeFile(join(shots,'selection-profile.json'), JSON.stringify(result,null,2)+'\n')
    assert.equal(result.options, count + 3, 'all objects, both bands and the root must remain selectable')
    assert.equal(result.optionValueReads, 0, 'syncing canvas selection should not walk the native option values in JavaScript')
    assert.equal(result.paintsPerBatch, 0, 'selection must not recalculate object geometry and styles')
  } finally { await cdp.detach() }
}
