import assert from 'node:assert/strict'
import test from 'node:test'
import '../lan-chat/markdown.js'

const { mdToHtml, inline, escapeHtml } = globalThis.LanChatMarkdown

test('html in messages is escaped instead of executed', () => {
  const html = mdToHtml('<img src=x onerror="alert(1)"> 正常文字')
  assert.equal(html.includes('<img'), false)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.match(html, /正常文字/)
})

test('headings, emphasis, inline code and mentions render as elements', () => {
  const html = mdToHtml('## 结论\n\n这是 **重点**，也有 *斜体* 和 `code`，还有 @DeepSeek-V4-Pro 接手。')
  assert.match(html, /<div class="lc-h lc-h2">结论<\/div>/)
  assert.match(html, /<strong>重点<\/strong>/)
  assert.match(html, /<em>斜体<\/em>/)
  assert.match(html, /<code class="lc-icode">code<\/code>/)
  assert.match(html, /<span class="lc-mention">@DeepSeek-V4-Pro<\/span>/)
})

test('fenced code blocks keep content verbatim and are not parsed as markdown', () => {
  const html = mdToHtml(['```js', 'const a = 1 * 2', '**不是加粗**', '```'].join('\n'))
  assert.match(html, /<div class="lc-code">/)
  assert.match(html, /<span>js<\/span>/)
  assert.match(html, /const a = 1 \* 2/)
  assert.match(html, /\*\*不是加粗\*\*/)
  assert.equal(html.includes('<strong>'), false)
  assert.equal(html.includes('lc-code-copy'), true)
})

test('lists, quotes, rules and tables', () => {
  assert.match(mdToHtml('- 一\n- 二'), /<ul class="lc-list"><li>一<\/li><li>二<\/li><\/ul>/)
  assert.match(mdToHtml('1. 甲\n2. 乙'), /<ol class="lc-list"><li>甲<\/li><li>乙<\/li><\/ol>/)
  assert.match(mdToHtml('> 引用一行'), /<blockquote>引用一行<\/blockquote>/)
  assert.match(mdToHtml('---'), /<hr class="lc-hr">/)
  const table = mdToHtml('| 名字 | 角色 |\n| --- | --- |\n| 阿哲 | 前端 |')
  assert.match(table, /<table class="lc-table">/)
  assert.match(table, /<th>名字<\/th><th>角色<\/th>/)
  assert.match(table, /<td>阿哲<\/td><td>前端<\/td>/)
})

test('only http(s) links are clickable', () => {
  assert.match(mdToHtml('[文档](https://example.com/a?b=1)'), /<a href="https:\/\/example.com\/a\?b=1" target="_blank"/)
  const dangerous = mdToHtml('[点我](javascript:alert(1))')
  assert.equal(dangerous.includes('<a '), false)
  assert.match(dangerous, /javascript:alert\(1\)/)
  // 裸链接自动成链，但不会破坏已有链接
  const bare = mdToHtml('见 https://example.com/x 谢谢')
  assert.match(bare, /<a href="https:\/\/example.com\/x"/)
  const linked = mdToHtml('[站点](https://example.com/x)')
  assert.equal((linked.match(/<a /g) || []).length, 1)
})

test('plain text keeps blank-line paragraphs and hard breaks', () => {
  const html = mdToHtml('第一段\n第二行\n\n第二段')
  assert.match(html, /<p>第一段<br>第二行<\/p><p>第二段<\/p>/)
  assert.equal(inline(escapeHtml('<b>x</b>')), '&lt;b&gt;x&lt;/b&gt;')
  assert.equal(mdToHtml(''), '')
})
