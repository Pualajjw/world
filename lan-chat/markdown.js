/**
 * 聊天消息用的轻量 Markdown 渲染器（无依赖、纯字符串拼接）。
 *
 * 设计目标：模型回复里常见的标题 / 列表 / 代码块 / 引用 / 表格 / 行内强调能正常显示，
 * 同时**先转义再拼 HTML**，HTML 标签与危险协议一律当纯文本，不会引入 XSS。
 * 浏览器里挂到 `window.LanChatMarkdown`；node --test 里 import 本文件后从 globalThis 取。
 */
;(function (root) {
  'use strict'

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ESC[c] }) }

  /** 代码块里抠出来的行内代码用占位符保护，避免 `*` `_` `[` 被当成语法。 */
  function inline(escaped) {
    var codes = []
    var out = String(escaped).replace(/`([^`\n]+)`/g, function (_match, code) {
      codes.push('<code class="lc-icode">' + code + '</code>')
      return '\u0000' + (codes.length - 1) + '\u0000'
    })
    // 链接只放行 http/https，`javascript:` 之类保持原文
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_match, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
    })
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    out = out.replace(/(^|[\s(（])(https?:\/\/[^\s<>"'）)]+)/g, function (match, lead, url) {
      if (out.indexOf('<a href="' + url + '"') >= 0) return match
      return lead + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'
    })
    // @ 高亮（行内代码已用占位符隔开，不会误伤）
    out = out.replace(/(@[\w\u4e00-\u9fa5.:\/-]+)/g, '<span class="lc-mention">$1</span>')
    return out.replace(/\u0000(\d+)\u0000/g, function (_match, index) { return codes[Number(index)] })
  }

  var FENCE = /^\s*```+\s*([\w+#.-]*)\s*$/
  var FENCE_END = /^\s*```+\s*$/
  var HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
  var RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
  var QUOTE = /^\s{0,3}>\s?/
  var ITEM = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/
  var TABLE_HEAD = /^[\s|:-]+$/

  function cellsOf(row) {
    return String(row).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (cell) {
      return cell.trim()
    })
  }

  function mdToHtml(source) {
    var lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n')
    var html = ''
    var i = 0
    while (i < lines.length) {
      var line = lines[i]

      var fence = FENCE.exec(line)
      if (fence) {
        var lang = fence[1]
        var buffer = []
        i += 1
        while (i < lines.length && !FENCE_END.test(lines[i])) { buffer.push(lines[i]); i += 1 }
        i += 1
        html += '<div class="lc-code"><div class="lc-code-bar"><span>' + esc(lang || 'code') + '</span>' +
          '<button type="button" class="lc-code-copy">复制</button></div>' +
          '<pre><code>' + esc(buffer.join('\n')) + '</code></pre></div>'
        continue
      }

      if (!line.trim()) { i += 1; continue }

      var heading = HEADING.exec(line)
      if (heading) {
        var level = heading[1].length
        html += '<div class="lc-h lc-h' + level + '">' + inline(esc(heading[2])) + '</div>'
        i += 1
        continue
      }

      if (RULE.test(line)) { html += '<hr class="lc-hr">'; i += 1; continue }

      if (QUOTE.test(line)) {
        var quote = []
        while (i < lines.length && QUOTE.test(lines[i])) { quote.push(lines[i].replace(QUOTE, '')); i += 1 }
        html += '<blockquote>' + quote.map(function (row) { return inline(esc(row)) }).join('<br>') + '</blockquote>'
        continue
      }

      // 表格：表头行 + 分隔行（|---|:--:|）才算，否则当普通段落
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && TABLE_HEAD.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = cellsOf(line)
        i += 2
        var rows = []
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) { rows.push(cellsOf(lines[i])); i += 1 }
        html += '<table class="lc-table"><thead><tr>' + head.map(function (cell) {
          return '<th>' + inline(esc(cell)) + '</th>'
        }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
          return '<tr>' + row.map(function (cell) { return '<td>' + inline(esc(cell)) + '</td>' }).join('') + '</tr>'
        }).join('') + '</tbody></table>'
        continue
      }

      var item = ITEM.exec(line)
      if (item) {
        var ordered = /\d/.test(item[1])
        var entries = []
        while (i < lines.length) {
          var next = ITEM.exec(lines[i])
          if (!next || /\d/.test(next[1]) !== ordered) break
          entries.push('<li>' + inline(esc(next[2])) + '</li>')
          i += 1
        }
        var tag = ordered ? 'ol' : 'ul'
        html += '<' + tag + ' class="lc-list">' + entries.join('') + '</' + tag + '>'
        continue
      }

      var paragraph = []
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) &&
        !QUOTE.test(lines[i]) && !ITEM.test(lines[i]) && !RULE.test(lines[i])) {
        paragraph.push(lines[i]); i += 1
      }
      if (!paragraph.length) { paragraph.push(line); i += 1 }
      html += '<p>' + paragraph.map(function (row) { return inline(esc(row)) }).join('<br>') + '</p>'
    }
    return html
  }

  var api = { mdToHtml: mdToHtml, escapeHtml: esc, inline: inline }
  root.LanChatMarkdown = api
  if (typeof module === 'object' && module && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
