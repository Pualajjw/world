import assert from 'node:assert/strict'
import test from 'node:test'
import { Text } from '@codemirror/state'
import { indexMarkdownTests, scheduleTestIndex } from '../vscode-test-index.js'
import { markdownTestBlocks } from '../highlight.js'

const drain = index => { for (;;) {const step = index.next(); if (step.done) return step.value} }
test('large Markdown reuses unchanged leaves but invalidates changed lexical context', t => {
  const n = 200000, cache = new WeakMap(); let scans = 0, visits = 0
  const store = {
    get(k) { visits++; return cache.get(k) },
    set(k, v) { if (!k.children) scans++; cache.set(k, v) },
  }
  const source = Text.of(['```pbtest','subroutine test_a()', ...Array.from({length:n},(_,i)=>`ll_count = ${i}`), 'end subroutine','```'])
  const work = (doc) => { visits = scans = 0; const start = performance.now(); const blocks = drain(indexMarkdownTests(doc,store)); return {blocks,visits,ms:(performance.now()-start).toFixed(2)} }
  const cold = work(source), total = scans; assert.deepEqual(cold.blocks[0].cases,[{name:'test_a',line:2}])
  const row = source.line(n>>1), changed = source.replace(row.from,row.to,Text.of(['ll_count = 0']))
  const warm = work(changed); assert.deepEqual(warm.blocks,cold.blocks); assert.ok(scans <= 3, `retokenized ${scans} leaves`)
  assert.ok(warm.visits < 256, `single edit visited ${warm.visits} text nodes`)
  t.diagnostic(`200k assignments: cold ${cold.ms}ms/${total} leaves; edit ${warm.ms}ms/${scans} new leaves, ${warm.visits} node visits (total CPU, sliced in UI)`)
  // An insertion before a shared subtree shifts all later declarations without changing its contents.
  const appended = changed.replace(changed.length,changed.length,Text.of(['','```pbtest','subroutine test_tail()','end subroutine','```']))
  const expected = work(appended).blocks
  const shifted = work(appended.replace(row.from,row.from,Text.of(['// inserted','']))).blocks
  assert.deepEqual(shifted[0], expected[0]); assert.equal(shifted[1].line, expected[1].line+1)
  assert.deepEqual(shifted[1].cases,[{name:'test_tail',line:expected[1].cases[0].line+1}])
  const commented = changed.replace(9,9,Text.of(['','/*']))
  assert.deepEqual(work(commented).blocks[0].cases,[])
  const fixture = ['```pbtest', 'subroutine test_ab()', 'end subroutine', 'subroutine test_a()', 'end subroutine', '```'].join('\n')
  assert.deepEqual(work(Text.of(fixture.split('\n'))).blocks,markdownTestBlocks(fixture))
})
test('skipping an event-free branch preserves comment state at the next declaration', () => {
  const rows = Array(16000).fill('ll_count = 1'), cache = new WeakMap()
  rows[0] = '```pbtest'; rows[2000] = '/*'; rows[8000] = 'subroutine test_hidden()'; rows[8001] = 'end subroutine'
  rows[12000] = '*/'; rows[14000] = 'subroutine test_visible()'; rows[14001] = 'end subroutine'; rows[15999] = '```'
  const doc = Text.of(rows), cases = d => drain(indexMarkdownTests(d,cache))[0].cases.map(c => c.name)
  assert.deepEqual(cases(doc),['test_visible'])
  const edit = doc.replace(doc.line(2).to,doc.line(2).to,Text.of(['1']))
  assert.deepEqual(cases(edit),['test_visible'])
  const opener = edit.line(2001)
  assert.deepEqual(cases(edit.replace(opener.from,opener.to,Text.empty)),['test_hidden','test_visible'])
})
test('a cancelled index never publishes a retired draft', async () => {
  const cache = new WeakMap(), doc = Text.of(['```pbtest','```']); let stale = false
  scheduleTestIndex(doc,cache,()=>{stale=true})()
  const blocks = await new Promise(resolve=>scheduleTestIndex(doc,cache,resolve))
  assert.equal(stale,false); assert.equal(blocks.length,1)
})
