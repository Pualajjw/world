import test from 'node:test'
import assert from 'node:assert/strict'
import { foldScanner, nativeFoldRows } from '../vscode-folding.js'

test('fold nested PB blocks only inside a complete matching pbtest fence; never across fences', () => {
  const lines = ['# Heading', '```powershell', 'if true then', 'end if', '```', '~~~~PBTest:shared',
    'public subroutine test_a()', 'if true then', 'for i = 1 to 3', 'next', 'end if', 'end subroutine',
    'if true then', '~~~~', '```pbtest', 'end if', '```', '```powerscript', 'if true then', 'end if', '```']
  assert.deepEqual([...nativeFoldRows(lines.join('\r\n'), 'markdown')], [[9,10],[8,11],[7,12],[1,21]])
})
test('PB folding ignores strings, comments, inline if, external declarations and native bodies', () => {
  const lines = ['type prototypes','function long ext()', 'end prototypes', 'function long ext() library "a.dll"',
    'event open;for i = 1 to 3', 'if x then return 1', 's = "; end event"', '/*', 'end event', '*/', 'next', 'end event',
    '@c a.dll','if true then','end if','@end c', 'try','do while true','loop','end try']
  assert.deepEqual([...nativeFoldRows(lines.join('\n'), 'powerbuilder')], [[1,3],[5,12],[13,16],[18,19],[17,20]])
  assert.equal(nativeFoldRows('if true then\nend if', null), null)
})

test('ATX sections keep same-level siblings visible, trim trailing blanks and finish at EOF', () => {
  const lines = ['# First','intro','   ### Child','text','###### Deep','body','', '### Sibling','',
    '# Second', '# Empty', '# Last', 'tail', '']
  assert.deepEqual([...nativeFoldRows(lines.join('\r\n'), 'markdown')], [[5,6],[3,6],[1,8],[12,13]])
})

test('Setext and ATX sections share heading levels; fence contents are not headings', () => {
  const lines = ['文档', '====', '描述', '', '示例', '----', '````pbtest', '# Not a heading', 'if true then',
    'return', 'end if', '````', '~~~text', 'fake', '====', '~~~', '', '下一章', '====', '正文']
  assert.deepEqual([...nativeFoldRows(lines.join('\n'), 'markdown')], [[9,11],[5,16],[1,16],[18,20]])
})

test('ignore escaped hashes, indented code, comments, thematic breaks and hashes without a space', () => {
  const lines = ['# First', '\\# Literal', '#hashtag', '####### Too deep','    # code', '<!--', '# ignored', '```', '-->',
    '', '---', '', '> quoted', '---', '# Next', 'text']
  assert.deepEqual([...nativeFoldRows(lines.join('\n'), 'markdown')], [[1,14],[15,16]])
})

test('fold cache skips ordinary assignments and bounds unique structural candidates', () => {
  const cache = {}, scan = foldScanner('powerbuilder', cache)
  for (let i=0; i<200000; i++) scan.line(`ll_count = ${i}`, i+1)
  assert.equal(cache.token[0].size, 0)
  for (let i=0; i<3000; i++) {scan.line(`if x = ${i} then`, 200001+i*2); scan.line('end if', 200002+i*2)}
  assert.equal(scan.finish().size, 3000); assert.ok(cache.token[0].size <= 2048)
})
