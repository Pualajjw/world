import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sample } from './srm-fixture.js'

// In-memory test bundle only. Count characters passed to the PB lexer rather than
// asserting a wall-clock limit that would depend on the runner's frame rate.
export const backspaceProbe = { name:'pb-backspace-probe', setup(build) {
  build.onLoad({filter:/[\\/]highlight\.js$/}, async ({path}) => {
    const source = await readFile(path,'utf8'), anchor = 'function scanCode(source, spec, resume, lineState) {'
    assert.ok(source.includes(anchor))
    return { contents:source.replace(anchor, anchor + '\nif (window.countPB && spec === CODE_SPECS.powerbuilder) window.scanChars += source.length - (resume?.offset || 0)'), loader:'js' }
  })
  build.onLoad({filter:/srw-code-editor\.js$/}, async ({path}) => {
    const src = await readFile(path,'utf8'), anchor = 'editor.current = view'; assert.ok(src.includes(anchor))
    return { contents:src.replace(anchor, anchor+'; window.testScriptView = view'), loader:'js' }
  })
} }

export async function testBackspace(page, editor) {
  const script = Array.from({length:850}, (_,i) => i===170 ? '// '+ 'x'.repeat(100) + 'MARK_CHAR'
    : i===180 ? '/* COLOR */\nreturn 42 // PROBE'
    : i===350 ? '// blank lines\n'+'\n'.repeat(90)+'// MARK_JOIN' : `if li_arg > ${i} then li_ret = li_ret + 1 // item ${i}`).join('\n')
  const exported = sample.replace('MessageBox("Help", "Index")',script)
  await page.evaluate(source => { window.saved = source },exported)
  const button = (el,name) => el.getByRole('button',{name,exact:true})
  await button(editor,'m_test.SRM').dblclick(); await button(editor.getByRole('region',{name:'菜单树'}),'Help').click()
  await button(editor.getByRole('region',{name:'菜单预览'}),'Index').dblclick()
  for (const isScript of [true,false]) {
    if (!isScript) await button(editor,'返回源码').click()
    const input = editor.getByRole('textbox',{name:isScript?'编辑 m_index.clicked':'编辑 m_test.SRM',exact:true})
    const original = isScript ? script : exported
    const place = at => input.evaluate((el,{at,isScript}) => {
      if (isScript) {
        const cm = window.testScriptView; cm.focus()
        cm.dispatch({selection:{anchor:at}, effects:cm.constructor.scrollIntoView(at,{y:'center'})})
      } else {
        el.focus(); el.setSelectionRange(at,at)
        el.scrollTop = (el.value.slice(0,at).split('\n').length-1)*parseFloat(getComputedStyle(el).lineHeight)-el.clientHeight/2
      }
    },{at,isScript})
    for (const [marker,char] of [['MARK_CHAR','x'],['// MARK_JOIN','\n']]) {
      const at = original.indexOf(marker), count = 30
      assert.equal(original.slice(at-count,at),char.repeat(count))
      await place(at)
      await page.waitForTimeout(150)
      await page.evaluate(() => { window.scanChars = 0; window.countPB = true })
      for (let i=0;i<count;i++) { await page.keyboard.down('Backspace'); await page.waitForTimeout(33) }
      await page.keyboard.up('Backspace'); await page.waitForTimeout(120)
      const snapshot = () => input.evaluate((el,cm) => cm
        ? {value:window.testScriptView.state.doc.toString(), pos:window.testScriptView.state.selection.main.head}
        : {value:el.value,pos:el.selectionStart},isScript)
      const chars = await page.evaluate(() => { window.countPB = false; return window.scanChars })
      assert.deepEqual(await snapshot(),{value:original.slice(0,at-count)+original.slice(at),pos:at-count})
      assert.ok(chars < original.length, `repeated ${marker} deletion scanned ${chars} characters`)
      // Browser textarea and CM can group undo differently; both must restore the exact draft and caret.
      let restored = await snapshot()
      for (let i=0; i<count && restored.value!==original; i++) {await input.press('Control+z'); restored=await snapshot()}
      assert.deepEqual(restored,{value:original,pos:at})
      console.log(`${isScript?'Script':'Source'} ${marker}: ${count} Backspaces, ${chars} lexer characters; undo OK`)
    }
    // Removing a comment terminator changes the incoming state even on identical later lines.
    await place(original.indexOf('/* COLOR */')+'/* COLOR */'.length)
    const surface = isScript ? input : editor.locator('.world-vscode-highlight:visible')
    const keyword = surface.locator('.world-vscode-tok-ctl').filter({hasText:/^return$/})
    const comment = surface.locator('.world-vscode-tok-cmt').filter({hasText:'return 42 // PROBE'})
    await keyword.first().waitFor(); await input.press('Backspace'); await comment.waitFor()
    await input.press('Control+z'); await comment.waitFor({state:'detached'}); await keyword.first().waitFor()
  }
}
