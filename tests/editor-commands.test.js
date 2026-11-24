import assert from 'node:assert/strict'
import test from 'node:test'
import { commentPrefixOf, duplicateLineBlock, moveLineBlock, toggleCommentBlock } from '../editor-commands.js'

/**
 * 命令同时返回整份结果和「只覆盖变化区间」的 from/to/text。
 * 后者是给编辑器做局部替换用的（整段替换在大文件里要 120ms 以上），
 * 所以每条用例都顺手验证：把 text 拼回原文必须等于 value。
 */
const patched = (value, result) => value.slice(0, result.from) + result.text + value.slice(result.to)
const core = result => result && { value: result.value, start: result.start, end: result.end }
const check = (value, result, expected) => {
  assert.deepEqual(core(result), expected)
  assert.equal(patched(value, result), result.value, 'from/to/text 拼回去要和 value 一致')
}

test('moving a block up and down swaps whole lines', () => {
  const value = 'a\nb\nc'
  // 光标在第二行中间：整行上移，选区跟着走
  check(value, moveLineBlock(value, 3, 3, -1), { value: 'b\na\nc', start: 1, end: 1 })
  check(value, moveLineBlock(value, 3, 3, 1), { value: 'a\nc\nb', start: 5, end: 5 })
  // 多行块整体平移：b、c 两行一起下移
  check('a\nb\nc\nd', moveLineBlock('a\nb\nc\nd', 2, 4, 1), { value: 'a\nd\nb\nc', start: 4, end: 6 })
  check('a\nb\nc\nd', moveLineBlock('a\nb\nc\nd', 2, 4, -1), { value: 'b\nc\na\nd', start: 0, end: 2 })
  // 到顶 / 到底 = 什么都不做
  assert.equal(moveLineBlock(value, 0, 0, -1), null)
  assert.equal(moveLineBlock(value, 5, 5, 1), null)
  // 末尾没有换行也要能移动到最后一行
  assert.equal(moveLineBlock('a\nb', 2, 2, 1), null)
  check('a\nb', moveLineBlock('a\nb', 0, 0, 1), { value: 'b\na', start: 2, end: 2 })
})

test('the replaced region only covers the lines that actually moved', () => {
  // 1000 行里移动第 500 行：替换区间应当是这两行，而不是整份文本
  const value = Array.from({ length: 1000 }, (_, index) => `line ${index}`).join('\n')
  const start = value.indexOf('line 500')
  const result = moveLineBlock(value, start, start, -1)
  assert.ok(result.from > start - 40 && result.from < start, `区间应从上一行开始：${result.from}`)
  assert.ok(result.to - result.from < 40, `区间应只覆盖两行，实际 ${result.to - result.from}`)
})

test('duplicating a block puts the caret in the copy below', () => {
  check('a\nb', duplicateLineBlock('a\nb', 0, 0), { value: 'a\na\nb', start: 2, end: 2 })
  check('a\nb\nc', duplicateLineBlock('a\nb\nc', 2, 4), { value: 'a\nb\nc\nb\nc', start: 6, end: 8 })
  check('only', duplicateLineBlock('only', 0, 4), { value: 'only\nonly', start: 5, end: 9 })
  // 复制只插入，不删任何字符
  const result = duplicateLineBlock('a\nb', 0, 0)
  assert.equal(result.from, result.to)
})

test('comment toggling follows indent and skips blank lines', () => {
  // 加注释：写在缩进之后，空行不动
  check('  a\n\n  b', toggleCommentBlock('  a\n\n  b', 3, 3, '//'), { value: '  // a\n\n  b', start: 6, end: 6 })
  // 全是注释 → 去掉，连同后面那一个空格
  check('  // a\n  // b', toggleCommentBlock('  // a\n  // b', 4, 10, '//'), { value: '  a\n  b', start: 1, end: 7 })
  // 混着来：只要有一行没注释就整体加注释
  check('// a\nb', toggleCommentBlock('// a\nb', 0, 6, '//'), { value: '// // a\n// b', start: 3, end: 9 })
  // 没有注释符的语言、或整块都是空行：不动
  assert.equal(toggleCommentBlock('a', 0, 1, ''), null)
  assert.equal(toggleCommentBlock('\n\n', 0, 2, '//'), null)
  // 缩进用 4 个空格时，注释符仍然贴在缩进后面
  check('    const a = 1', toggleCommentBlock('    const a = 1', 4, 4, '//'),
    { value: '    // const a = 1', start: 7, end: 7 })
})

test('comment prefixes only cover languages with line comments', () => {
  assert.equal(commentPrefixOf('javascript'), '//')
  assert.equal(commentPrefixOf('powerbuilder'), '//')
  assert.equal(commentPrefixOf('python'), '#')
  assert.equal(commentPrefixOf('sql'), '--')
  assert.equal(commentPrefixOf('json'), '')
  assert.equal(commentPrefixOf('markdown'), '')
  assert.equal(commentPrefixOf(null), '')
})
