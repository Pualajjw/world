/** The tokenizer must never lose or reorder a single character: the editor paints its rows instead of the text. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { highlight, createHighlighter, powerScriptLineTokens, languageOf, plainLines, syntaxLine } from '../highlight.js'

const SAMPLES = {
  powerbuilder: '$PBExportHeader$w_test.srw\n@w_test.srw.event open;\nString ls_text = "中文~"引号~""\n/* 块注释\n第二行 */\nIF IsNull(ls_text) THEN\nMessageBox("标题", ls_text, Information!)\nEND IF\n@end event\n',
  ini: '[section]\nname = "world"\nflag = true\n; comment\n',
  javascript: 'const answer = 42 // 注释\nfunction greet(name) {\n  return `hi ${name}`\n}\n/* 块注释\n   第二行 */\nclass Thing extends Base {}\n',
  typescript: 'import type { A } from "./a"\nexport interface B<T> { value: T }\nconst x: number = 1_000\n',
  json: '{\n  "name": "world",\n  "count": 3,\n  "ok": true,\n  "list": [1, 2.5, -3e4]\n}\n',
  css: ':root { --gap: 8px; }\n.card .title:hover, #app > a[href="x"] {\n  color: #ff0000;\n  margin: 0 auto !important;\n  /* 注释 */\n}\n@media (max-width: 720px) { .card { display: none } }\n',
  html: '<!DOCTYPE html>\n<div class="app" data-id=\'x\'>\n  <!-- 注释 -->\n  <span>text &amp; more</span>\n</div>\n',
  markdown: '# 标题\n\n- 项目一\n- 项目二\n\n```js\nconst a = 1\n```\n\n**加粗** 与 *斜体* 和 `code`，[链接](https://example.com)\n',
  python: 'import os\n\n@decorator\ndef main(name: str = "x") -> None:\n    """doc\n    string"""\n    if name:\n        print(name)  # 注释\n    return None\n',
  shell: '#!/bin/sh\nset -e\nNAME="world"\necho "hi $NAME"\nif [ -f file ]; then\n  exit 0\nfi\n',
  yaml: 'name: world\nlist:\n  - one\n  - two\nnested:\n  key: "value"\nflag: true\n',
  toml: '[package]\nname = "world"\nversion = "0.1.0"\n\n[build]\ntarget = "node"\n',
  batch: '@echo off\nrem 注释\nset NAME=world\necho %NAME%\nif exist file.txt echo ok\n',
  powershell: 'param([string]$Name = "world")\n# 注释\nWrite-Host "hi $Name"\nif ($Name) { exit 0 }\n',
  clike: '#include <stdio.h>\nint main(void) {\n  // 注释\n  printf("hi %d\\n", 42);\n  return 0;\n}\n',
  sql: 'SELECT id, name FROM users WHERE id = 1 -- 注释\n/* 块 */\nORDER BY name;\n',
  ruby: 'class Greeter\n  def hello(name)\n    puts "hi #{name}" # 注释\n  end\nend\n',
  lua: 'local function greet(name)\n  print("hi " .. name) -- 注释\nend\n',
  xml: '<?xml version="1.0"?>\n<root a="1">\n  <child />\n</root>\n',
  text: 'plain text\nwith two lines\n',
}

const flatten = lines => lines.map(line => line.map(token => token.text).join('')).join('\n')

test('incremental highlighting matches a fresh scan through edits, undo and language switches', () => {
  const cached = createHighlighter()
  let seed = 173
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit }
  const insertions = ['a', '\n', '/*', '*/', '//', '\\', '~', '"', "'", '`', '"""', "'''", '--[[', ']]', '#', '']
  for (const [language, original] of Object.entries(SAMPLES)) {
    let source = original
    for (let step = 0; step < 80; step++) {
      const result = cached(source, language)
      assert.deepEqual(result, highlight(source, language), `${language}, edit ${step}`)
      const saved = JSON.stringify(result)
      const from = random(source.length + 1), to = Math.min(source.length, from + random(5))
      source = source.slice(0, from) + insertions[random(insertions.length)] + source.slice(to)
      assert.deepEqual(cached(source, language), highlight(source, language), `${language}, after edit ${step}`)
      assert.equal(JSON.stringify(result), saved, 'cached prefix must never mutate a previous render')
      if (step % 9 === 0) source = original
    }
  }
})

test('incremental highlighting reuses complete prefix rows and restarts multiline tokens safely', () => {
  const cached = createHighlighter()
  const source = 'const a = 1\n/* first\nsecond */\nconst b = 2\n'
  const first = cached(source, 'javascript')
  assert.equal(cached(source, 'javascript'), first)
  const appended = cached(source + 'const c = 3', 'javascript')
  for (let i = 0; i < 4; i++) assert.equal(appended.lines[i], first.lines[i], 'unchanged prefix row is reused')
  const edited = source.replace('second */', 'second') + 'const c = 3'
  const comment = cached(edited, 'javascript')
  assert.equal(comment.lines[0], first.lines[0])
  assert.deepEqual(comment, highlight(edited, 'javascript'), 'deleting a block terminator recolours the following code')
  assert.deepEqual(cached(source, 'javascript'), first, 'undo restores all original token types')
})

test('incremental cache preserves tokens across the former size limit', () => {
  const cached = createHighlighter(), source = 'let value = 1\n'
  cached(source, 'javascript')
  const large = 'x'.repeat(200_001)
  assert.deepEqual(cached(large, 'javascript'), highlight(large, 'javascript'))
  assert.deepEqual(cached(source, 'javascript'), highlight(source, 'javascript'))
  assert.deepEqual(cached(source, null), highlight(source, null))
})

test('tokenizing is lossless for every supported language', () => {
  for (const [language, source] of Object.entries(SAMPLES)) {
    const { lines } = highlight(source, language === 'text' ? null : language)
    assert.equal(flatten(lines), source, `${language} lost or reordered text`)
    assert.equal(lines.length, source.split('\n').length, `${language} line count differs`)
  }
})

test('PowerBuilder export syntax, case-insensitive keywords, tilde escapes and enums are lossless', () => {
  const source = '$PBExportHeader$w_test.srw\n@w_test.srw.event open;\nGLOBAL TYPE w_test FROM window\nString ls_text = "中文~"引号~"和 C:\\path\\"\nIF IsNull(ls_text) THEN\n  MessageBox("标题", ls_text, Information!) // 中文注释\nEND IF\n/* 第一行\n第二行 */\n@end event\n'
  const result = highlight(source, 'powerbuilder'), tokens = result.lines.flat()
  assert.equal(result.plain, false)
  assert.equal(flatten(result.lines), source)
  for (const ext of ['sra', 'sru', 'srw', 'srd', 'srm', 'srf', 'srs', 'srq', 'pb', 'pbtest']) {
    assert.equal(languageOf(`C:\\源码\\app.${ext.toUpperCase()}`), 'powerbuilder')
  }
  assert.equal(languageOf('library.pbl'), null, 'binary PB libraries are not source files')
  assert.ok(tokens.some(t => t.type === 'type' && t.text === 'String'))
  assert.ok(tokens.some(t => t.type === 'ctl' && t.text === 'IF'))
  assert.ok(tokens.some(t => t.type === 'fn' && t.text === 'MessageBox'))
  assert.ok(tokens.some(t => t.type === 'num' && t.text === 'Information!'))
  assert.ok(tokens.some(t => t.type === 'str' && t.text.includes('~"引号~"')))
  assert.ok(tokens.some(t => t.type === 'meta' && t.text.startsWith('@w_test')))
  assert.ok(tokens.some(t => t.type === 'cmt' && t.text.includes('中文注释')))
  assert.ok(tokens.some(t => t.type === 'cmt' && t.text.includes('第二行')))
})

test('javascript colours keywords, strings, numbers and comments', () => {
  const { lines, plain } = highlight(SAMPLES.javascript, 'javascript')
  assert.equal(plain, false)
  const kinds = type => lines.flat().filter(token => token.type === type).map(token => token.text)
  assert.ok(kinds('kw').includes('const'))
  assert.ok(kinds('ctl').includes('return'))
  assert.ok(kinds('fn').includes('greet'))
  assert.ok(kinds('type').includes('Thing'))
  assert.ok(kinds('num').includes('42'))
  assert.ok(kinds('str').includes('`hi ${name}`'))
  assert.ok(kinds('cmt').some(text => text.startsWith('//')))
  assert.ok(kinds('cmt').some(text => text.includes('第二行')))
})

test('json keys are told apart from values', () => {
  const { lines } = highlight(SAMPLES.json, 'json')
  const keys = lines.flat().filter(token => token.type === 'key').map(token => token.text)
  assert.deepEqual(keys, ['"name"', '"count"', '"ok"', '"list"'])
  const strings = lines.flat().filter(token => token.type === 'str').map(token => token.text)
  assert.deepEqual(strings, ['"world"'])
  assert.ok(lines.flat().some(token => token.type === 'num' && token.text === 'true'))
})

test('css separates selectors, properties and values', () => {
  const { lines } = highlight(SAMPLES.css, 'css')
  const tokens = lines.flat()
  assert.ok(tokens.some(token => token.type === 'type' && token.text === '.card'))
  assert.ok(tokens.some(token => token.type === 'attr' && token.text === 'color'))
  assert.ok(tokens.some(token => token.type === 'num' && token.text === '#ff0000'))
  assert.ok(tokens.some(token => token.type === 'kw' && token.text === '!important'))
  assert.ok(tokens.some(token => token.type === 'fn' && token.text === ':hover'))
})

test('markup colours tags, attributes and comments', () => {
  const { lines } = highlight(SAMPLES.html, 'html')
  const tokens = lines.flat()
  assert.ok(tokens.some(token => token.type === 'tag' && token.text === 'div'))
  assert.ok(tokens.some(token => token.type === 'attr' && token.text === 'class'))
  assert.ok(tokens.some(token => token.type === 'str' && token.text === '"app"'))
  assert.ok(tokens.some(token => token.type === 'cmt' && token.text.includes('注释')))
})

test('markdown fences and headings are block-level, emphasis is inline', () => {
  const { lines } = highlight(SAMPLES.markdown, 'markdown')
  const tokens = lines.flat()
  assert.ok(tokens.some(token => token.type === 'kw' && token.text === '# 标题'))
  assert.ok(tokens.some(token => token.type === 'str' && token.text.includes('const a = 1')))
  assert.ok(tokens.some(token => token.type === 'type' && token.text.includes('加粗')))
  assert.ok(tokens.some(token => token.type === 'str' && token.text === '`code`'))
})

test('yaml and toml colour keys, sections and literals', () => {
  const yaml = highlight(SAMPLES.yaml, 'yaml').lines.flat()
  assert.ok(yaml.some(token => token.type === 'key' && token.text === 'name'))
  assert.ok(yaml.some(token => token.type === 'num' && token.text === 'true'))
  const toml = highlight(SAMPLES.toml, 'toml').lines.flat()
  assert.ok(toml.some(token => token.type === 'tag' && token.text === '[package]'))
  assert.ok(toml.some(token => token.type === 'key' && token.text === 'name'))
})

test('python triple-quoted strings survive multiple lines', () => {
  const { lines } = highlight(SAMPLES.python, 'python')
  const docstring = lines.flat().filter(token => token.type === 'str').map(token => token.text).join('\n')
  assert.ok(docstring.includes('"""doc\n    string"""'))
  assert.ok(lines.flat().some(token => token.type === 'kw' && token.text === 'def'))
})

test('known syntax past 200k remains highlighted; unknown files stay plain', () => {
  const huge = 'a'.repeat(200_001) + ' return 42'
  const big = highlight(huge, 'javascript')
  assert.equal(big.plain, false)
  assert.ok(big.lines[0].some(t => t.text === 'return' && t.type === 'ctl'))
  assert.equal(big.lines.length, 1)
  assert.equal(big.lines[0][0].type, 'punc')
  const unknown = highlight('hello\nworld', null)
  assert.equal(unknown.plain, true)
  assert.equal(flatten(unknown.lines), 'hello\nworld')
  assert.deepEqual(plainLines('a\nb'), [[{ type: 'punc', text: 'a' }], [{ type: 'punc', text: 'b' }]])
})

test('language detection follows extensions and known filenames', () => {
  assert.equal(languageOf('src/app.js'), 'javascript')
  assert.equal(languageOf('a/b/Component.tsx'), 'typescript')
  assert.equal(languageOf('package.json'), 'json')
  assert.equal(languageOf('styles.CSS'), 'css')
  assert.equal(languageOf('README.md'), 'markdown')
  assert.equal(languageOf('Dockerfile'), 'shell')
  assert.equal(languageOf('scripts/build.ps1'), 'powershell')
  assert.equal(languageOf('nope.bin'), null)
  assert.equal(languageOf('no-extension'), null)
})

test('live PowerScript lines match the source lexer across multiline comments, escapes and PB directives', () => {
  const source = SAMPLES.powerbuilder + ' /*a*/ /* still open\n\n*/return 42 // done'
  const state = { blockComment: false }
  assert.deepEqual(source.split('\n').map(line => powerScriptLineTokens(line, state)), highlight(source, 'powerbuilder').lines)
  assert.equal(state.blockComment, false)
})

test('virtual viewport syntax carries lexical context between physical lines', () => {
  for (const [lang, source] of Object.entries(SAMPLES)) {
    if (lang === 'text') continue
    const state = {}, rows = source.split('\n').map(line => syntaxLine(line, lang, state))
    assert.deepEqual(rows, highlight(source, lang).lines, lang)
  }
})

test('PowerScript backspace reuses shifted suffix rows only in the same lexical context', () => {
  const cached = createHighlighter(), code = 'return 42', source = `// title\n/* start\n${code}\n*/\n${code}\n\n${code}\n`
  const old = cached(source,'powerbuilder'), deleted = source.replace(`${code}\n\n`,`${code}\n`)
  const joined = cached(deleted,'powerbuilder')
  assert.equal(joined.lines[5],old.lines[6]); assert.deepEqual(joined, highlight(deleted,'powerbuilder'))
  const open = deleted.replace('*/','*'), recolored = cached(open,'powerbuilder')
  assert.notEqual(recolored.lines[4],joined.lines[4]); assert.equal(recolored.lines[4],joined.lines[2])
  assert.deepEqual(recolored,highlight(open,'powerbuilder')); assert.deepEqual(cached(source,'powerbuilder'),old)
  for (const line of ['string s = "~\"hi~\""', '//\ud800', '$PBExportHeader$m.srm\r', 'x'.repeat(100001)]) {
    const text = `${line}\n/*\n${line}\n*/\n${line}`
    assert.deepEqual(cached(text,'powerbuilder'), highlight(text,'powerbuilder'))
  }
})
