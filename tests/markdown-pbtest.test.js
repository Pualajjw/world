import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { highlight, markdownTestBlocks, syntaxLine } from '../highlight.js'

const guide = new URL('../../../../docs/pbnpm-cpb-零pbvm普通库调用pbidea-json.md', import.meta.url)
test('the PbIdea guide exposes its two real cases and colours C and PB without shifting the source', { skip: !existsSync(guide) }, () => {
  const document = readFileSync(guide, 'utf8')
  const [block, ...rest] = markdownTestBlocks(document)
  assert.equal(rest.length, 0)
  assert.deepEqual(block.cases.map(c => c.name), ['test_plain_library_full_lifecycle', 'test_plain_library_repeated_lifecycle'])
  const rows = document.split('\n'), tokens = highlight(document, 'markdown').lines
  assert.equal(rows[block.line - 1].trim(), '```pbtest')
  for (const c of block.cases) assert.ok(tokens[c.line - 1].some(t => t.type === 'fn' && t.text === c.name))
  const state = {}
  for (let i = 0; i < rows.length; ++i) {
    assert.equal(tokens[i].map(t => t.text).join(''), rows[i])
    assert.deepEqual(syntaxLine(rows[i], 'markdown', state), tokens[i])
  }
  const cpp = tokens[rows.findIndex(l => l.includes('static int cycle(void)'))]
  assert.ok(cpp.some(t => t.type === 'type' && t.text === 'void'))
  assert.ok(tokens.flat().some(t => t.type === 'fn' && t.text === 'pbtest_assert_equals'))
})

test('ordinals and cases ignore quoted fences, native code, prototypes, comments and incomplete routines', () => {
  const source = ['````text', '```pbtest', 'subroutine test_fake()', '```', '````', '~~~PowerScript:shared',
    'function long test_external() library "a"', '~~~', '```PowerBuilder', '/*', '@c a.dll', 'subroutine test_comment()', 'end subroutine', '*/',
    '@c a.dll', 'subroutine test_native()', 'end subroutine', '@end c', 'forward prototypes', 'function int test_proto()', 'end prototypes',
    'public function long test_Real() // note', 'return 0', 'end function', 'subroutine TEST_real_two()', 'end subroutine',
    'subroutine test_unfinished()', '```'].join('\r\n')
  const blocks = markdownTestBlocks(source)
  assert.deepEqual(blocks.map(b => b.index), [1, 2]); assert.equal(blocks[0].cases.length, 0)
  assert.deepEqual(blocks[1].cases, [{ name: 'test_Real', line: 22, ambiguous: true }, { name: 'TEST_real_two', line: 25 }])
})
