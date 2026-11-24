import assert from 'node:assert/strict'
import test from 'node:test'
import { findTextOffsets, MAX_TEXT_MATCHES, replaceAllText } from '../text-find.js'

test('literal find keeps Chinese and UTF-16 offsets, symbols, and case rules', () => {
  assert.deepEqual(findTextOffsets('中文😀 a+b A+B [x]', 'a+b'), [5, 9])
  assert.deepEqual(findTextOffsets('alpha ALPHA', 'alpha', true), [0])
  assert.deepEqual(findTextOffsets('[] .* $&', '.*'), [3])
  assert.deepEqual(findTextOffsets('anything', ''), [])
})

test('start offsets reconstruct exact literal ranges, including adjacent and surrogate matches', () => {
  for (const [source, query] of [['😀😀x😀', '😀'], ['AaAaa', 'aa'], ['İİi', 'i'], ['Σςσ', 'σ'],
    ['x\r\ny\r\nz', '\r\n'], ['a^b^', '^'], ['$&$&!', '$&'], ['abc', 'absent']]) {
    for (const matchCase of [false, true]) {
      const starts = findTextOffsets(source, query, matchCase)
      let pos = 0, rebuilt = ''
      for (const start of starts) { rebuilt += source.slice(pos, start) + '!'; pos = start + query.length }
      assert.deepEqual({ source: rebuilt + source.slice(pos), count: starts.length }, replaceAllText(source, query, '!', matchCase))
    }
  }
})

test('replacement is literal and counts non-overlapping matches without changing other text', () => {
  assert.deepEqual(replaceAllText('foo FOO 中文foo', 'foo', '$&'), { source: '$& $& 中文$&', count: 3 })
  assert.deepEqual(replaceAllText('foo FOO', 'foo', '', true), { source: ' FOO', count: 1 })
  assert.deepEqual(replaceAllText('aaaaa', 'aa', 'x'), { source: 'xxa', count: 2 })
  assert.deepEqual(replaceAllText('same', '', 'x'), { source: 'same', count: 0 })
})

test('match collection stops at the cap so a huge file cannot flood the UI', () => {
  const source = 'x'.repeat(50000)
  assert.equal(findTextOffsets(source, 'x').length, MAX_TEXT_MATCHES)
  // 上限之内仍然精确
  assert.equal(findTextOffsets(source, 'x', false, 100).length, 100)
  assert.equal(findTextOffsets(source, 'x', false, 7).at(-1), 6)
  // 查询里的正则元字符按字面量处理，`^` 不会变成锚点
  assert.deepEqual(findTextOffsets('a^b', '^'), [1])
})
