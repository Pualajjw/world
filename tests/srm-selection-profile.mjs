import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Count only SRM buttons, not Properties or unrelated desktop updates.
export const profilePaint = { name:'srm-profile-paint', setup(build) {
  build.onLoad({filter:/[\\/]srm-layout\.js$/}, async ({path}) => {
    const source = await readFile(path,'utf8'), signature = 'const h = React.createElement'
    assert.ok(source.includes(signature))
    return { contents:source.replace(signature, `let h = React.createElement
    window.__measureSrmRows = on => { h = on ? (type, ...args) => {
      if (type === 'button') window.__srmRows++
      return React.createElement(type, ...args)
    } : React.createElement }`), loader:'js' }
  })
} }

export async function profileSelection(page, editor, shots) {
  const count = 1000, switches = 24
  await page.evaluate(n => {
    window.saved = 'global type m_test from menu\nend type\ntype m_file from menu within m_test\nend type\n' +
      Array.from({length:n}, (_, i) => `type m_${i} from menu within m_file\nstring text = "Item &${i}"\nend type`).join('\n')
  }, count)
  const file = editor.getByRole('button',{name:'m_test.SRM',exact:true}), group = editor.locator('.world-srw-panes')
  const cdp = await page.context().newCDPSession(page)
  const sample = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    const {usedSize} = await cdp.send('Runtime.getHeapUsage')
    const {nodes} = await cdp.send('Memory.getDOMCounters'); return {bytes:usedSize,nodes}
  }
  try {
    const baseline = await sample(), runs = []
    for (let cycle=0; cycle<3; cycle++) {
      await file.dblclick()
      const tree = group.getByRole('region',{name:'菜单树'})
      await tree.getByRole('button',{name:'展开 m_file',exact:true}).click()
      await tree.getByRole('button',{name:'m_file',exact:true}).click()
      const metrics = await group.evaluate(async (el, {count,switches}) => {
        window.__srmLayoutProbe = new WeakRef(el.querySelector('.world-srm-layout'))
        const button = (panel,i) => el.querySelector(`.world-srm-${panel} button[title="m_${i}"]`)
        const left = [button('tree',0),button('tree',count-1)], right = [button('preview',0),button('preview',count-1)]
        const props = el.querySelector('[data-srw-view=properties]')
        const run = async () => {
          const begin = performance.now()
          for (let i=0;i<switches;i++) {
            const n = i%2; (n ? left[n] : right[n].querySelector('u')).click(); await Promise.resolve()
            if ([left[n],right[n]].some(b => b.getAttribute('aria-pressed') !== 'true') ||
                [left[1-n],right[1-n]].some(b => b.getAttribute('aria-pressed') !== 'false') || !props.textContent.includes(left[n].title))
              throw Error('Selection out of sync')
            void el.offsetHeight // Include synchronous style and layout, not Playwright input latency.
          }
          return performance.now() - begin
        }
        await run(); const times = []; for (let i=0;i<3;i++) times.push(await run())
        window.__srmRows = 0; window.__measureSrmRows(true)
        try { await run() } finally { window.__measureSrmRows(false) }
        return {ms:Math.round(times.sort((a,b)=>a-b)[1]),renderedButtons:window.__srmRows}
      }, {count,switches})
      const open = await sample()
      await editor.locator('[data-parent-tab]').getByRole('button',{name:/关闭标签/}).click(); await group.waitFor({state:'detached'})
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const closed = await sample(), mib = n => +((n-baseline.bytes)/2**20).toFixed(2)
      assert.ok(await page.evaluate(() => !window.__srmLayoutProbe.deref()), 'a closed Layout should be collectible')
      runs.push({...metrics,openMiB:mib(open.bytes),closedMiB:mib(closed.bytes),closedNodes:closed.nodes-baseline.nodes})
    }
    const report = {count,switches,runs}; console.log('SRM selection:', JSON.stringify(report))
    await writeFile(join(shots,'selection-profile.json'), JSON.stringify(report,null,2)+'\n')
    assert.ok(runs.every(run => run.renderedButtons === 0), 'leaf selection must not repaint the tree or menu buttons')
  } finally { await cdp.detach() }
}
