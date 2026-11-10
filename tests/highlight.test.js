/** The tokenizer must never lose or reorder a single character: the editor paints its rows instead of the text. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { highlight, languageOf, plainLines, MAX_HIGHLIGHT } from '../highlight.js'

const SAMPLES = {
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

test('tokenizing is lossless for every supported language', () => {
  for (const [language, source] of Object.entries(SAMPLES)) {
    const { lines } = highlight(source, language === 'text' ? null : language)
    assert.equal(flatten(lines), source, `${language} lost or reordered text`)
    assert.equal(lines.length, source.split('\n').length, `${language} line count differs`)
  }
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

test('oversized and unknown sources fall back to plain rows', () => {
  const huge = 'a'.repeat(MAX_HIGHLIGHT + 1)
  const big = highlight(huge, 'javascript')
  assert.equal(big.plain, true)
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
