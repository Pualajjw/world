import assert from 'node:assert/strict'
import { join } from 'node:path'

export const revealSource = `datawindow(units=1)
detail(height=2500)
groupbox(band=detail name=page x=0 y=0 width=2540 height=2500)
text(band=detail name=home text="首页" x=16 y=60 width=100 height=24)
text(band=detail name=far text="合计金额" x=2040 y=2090 width=110 height=24)
text(band=detail name=near text="小计" x=1900 y=2060 width=110 height=24)
text(band=detail name=clipped text="带区外" x=2460 y=2700 width=100 height=24)
line(band=detail name=no_pen pen.style=5 x1=20 x2=50 y1=24 y2=40)
text(band=foreground name=stamp text="第 1 页" x=32 y=50 width=90 height=24)`

export async function testPickerReveal(editor, shots) {
  await editor.getByRole('button',{name:'d_reveal.srd',exact:true}).dblclick()
  const group = editor.locator('.world-srw-panes'), canvas = group.locator('[data-srw-view=layout]'), picker = group.getByLabel('属性对象')
  await canvas.getByRole('button',{name:'text home',exact:true}).waitFor(); await picker.focus()
  const snapshot = name => canvas.evaluate((pane, name) => {
    const box = pane.querySelector(`[aria-label="text ${name}"]`).getBoundingClientRect(), viewport = pane.getBoundingClientRect()
    const toolbar = pane.querySelector('.world-srw-zoom').getBoundingClientRect(), ancestors = []
    for (let el = pane.parentElement; el; el = el.parentElement) ancestors.push([el.scrollLeft, el.scrollTop])
    const left = viewport.left + pane.clientLeft, top = viewport.top + pane.clientTop
    return { x:pane.scrollLeft, y:pane.scrollTop, ancestors,
      left:box.left-left, right:box.right-left-pane.clientWidth, top:box.top-top, bottom:box.bottom-top-pane.clientHeight,
      behindToolbar:box.left<toolbar.right && box.right>toolbar.left && box.top<toolbar.bottom && box.bottom>toolbar.top }
  },name)
  const before = await snapshot('far'); assert.ok(before.right>0 && before.bottom>0, 'test object must start offscreen on both axes')
  await picker.selectOption('band:detail/home'); await picker.press('ArrowDown')
  assert.equal(await picker.inputValue(), 'band:detail/far')
  const after = await snapshot('far')
  assert.ok(Math.abs(after.right)<=1 && Math.abs(after.bottom)<=1, `picker should reveal at nearest edges, got right=${after.right}, bottom=${after.bottom}`)
  assert.deepEqual(after.ancestors,before.ancestors); assert.equal(await picker.evaluate(el=>el===el.ownerDocument.activeElement),true)
  await editor.screenshot({path:join(shots,'srd-picker-reveal.png')})
  await picker.press('ArrowDown'); assert.equal(await picker.inputValue(),'band:detail/near')
  for (const value of [null,'band:detail/page','band:detail/clipped','band:detail/no_pen','band:detail','datawindow']) {
    if (value) await picker.selectOption(value)
    const stay = await snapshot('near'); assert.deepEqual([stay.x,stay.y],[after.x,after.y],`unnecessary scroll for ${value || 'visible object'}`)
  }
  // The foreground stamp is now offscreen to the upper left and covered by the
  // toolbar when aligned to the raw top edge. Foreground has no clipping band.
  await picker.selectOption('band:foreground/stamp')
  const back = await snapshot('stamp'); assert.ok(back.left >= -1 && back.top >= -1 && back.right<=1 && back.bottom<=1 && !back.behindToolbar)
  assert.deepEqual(back.ancestors,before.ancestors); assert.equal(await picker.evaluate(el=>el===el.ownerDocument.activeElement),true)
  // A model refresh restores the marker but must not pull the user away from where
  // they subsequently scrolled. Only an explicit picker change requests a reveal.
  await canvas.evaluate(pane => pane.scrollTo(pane.scrollWidth, pane.scrollHeight))
  const parked = await snapshot('stamp')
  await editor.page().evaluate(() => { window.__revealSource += '\ntext(band=detail name=refreshed x=1 y=40 width=100 height=20)'; window.__version='reveal-2' })
  await picker.locator('option[value="band:detail/refreshed"]').waitFor({state:'attached',timeout:12000})
  assert.equal(await picker.inputValue(),'band:foreground/stamp')
  const refreshed = await snapshot('stamp'); assert.deepEqual([refreshed.x,refreshed.y],[parked.x,parked.y])
  console.log('SRD picker reveal (CSS px):', {before:[before.x,before.y], after:[after.x,after.y], right:after.right, bottom:after.bottom, back:[back.x,back.y]})
}
