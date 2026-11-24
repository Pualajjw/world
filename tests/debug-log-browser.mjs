/** Real renderer load test: bound DOM size and snapshots during a burst, pause and minimize. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'
const root = join(import.meta.dirname,'..'), require = createRequire(join(root,'../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({stdin:{resolveDir:root,contents:`
import React from 'react'; import {createRoot} from 'react-dom/client'; import {DebugLogPage} from './debug-log-page.js'; import {createDebugLog} from './debug-log.js';
const log=createDebugLog(), snap=log.snapshot, root=createRoot(document.querySelector('main'));let snapshots=0;
log.snapshot=()=>{snapshots++;return snap()};window.snapshots=()=>snapshots;
window.showLog=visible=>root.render(React.createElement(DebugLogPage,{log,visible}));
window.emit=n=>{for(let i=0;i<n;i++)log.add(log.trace(),'VSCode','World','request')};showLog(true);`},bundle:true,format:'iife',platform:'browser',write:false,nodePaths:[join(root,'../workflow-studio/node_modules')]})
const browser=await chromium.launch(browserLaunchOptions())
try {
  const page=await browser.newPage();await page.setContent('<main></main>');await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.getByText('暂停刷新').waitFor()
  const result=await page.evaluate(async()=>{
    const start=performance.now(), prior=snapshots()
    for(let i=0;i<40;i++){emit(25000);await new Promise(r=>setTimeout(r,25))}
    await new Promise(r=>setTimeout(r,320))
    return {elapsed:performance.now()-start, snapshots:snapshots()-prior, rows:document.querySelectorAll('tbody tr').length}
  })
  assert.equal(result.rows,50); assert.ok(result.snapshots>0 && result.snapshots<=Math.ceil(result.elapsed/300)+1)
  await page.getByText('暂停刷新').click();const before=await page.evaluate(()=>snapshots());await page.evaluate(()=>emit(10000));await page.waitForTimeout(450)
  assert.equal(await page.evaluate(()=>snapshots()),before)
  await page.getByText('继续刷新').click();await page.waitForTimeout(40);await page.evaluate(()=>showLog(false));await page.waitForTimeout(40)
  const hidden=await page.evaluate(()=>snapshots());await page.evaluate(()=>emit(10000));await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>snapshots()),hidden)
  console.log('1M browser events (paced):', result, '; no snapshots while paused/minimized')
} finally { await browser.close() }
