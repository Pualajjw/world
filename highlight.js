/**
 * A small, dependency-free syntax tokenizer for the built-in editor.
 *
 * It never rewrites the text: every token keeps its original bytes, so joining
 * one line's tokens reproduces that line exactly. The editor paints these rows
 * underneath a transparent textarea, which is what keeps the caret, selection
 * and native scrolling intact while the text is coloured.
 */

/** Above this many characters colouring costs more than it is worth; the editor falls back to plain text. */
export const MAX_HIGHLIGHT = 200_000

const TYPE_ALIAS = { kw: 'kw', ctl: 'ctl', fn: 'fn', type: 'type', str: 'str', num: 'num', cmt: 'cmt', key: 'key', tag: 'tag', attr: 'attr', var: 'var', meta: 'meta' }

/** Collects tokens into per-line buckets, splitting on newlines inside a token. */
function createBuilder() {
  const lines = [[]]
  let current = lines[0]
  const push = (type, text) => {
    const last = current[current.length - 1]
    if (last && last.type === type) { last.text += text; return }
    current.push({ type: TYPE_ALIAS[type] ?? 'punc', text })
  }
  return {
    lines,
    text(type, value) {
      if (!value) return
      let start = 0
      for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) !== 10) continue
        const head = value.slice(start, index)
        if (head) push(type, head)
        lines.push(current = [])
        start = index + 1
      }
      if (start < value.length) push(type, value.slice(start))
    },
  }
}

const JS_CONTROL = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
  'throw', 'try', 'catch', 'finally', 'await', 'yield', 'async', 'of', 'in', 'instanceof',
])
const JS_KEYWORD = new Set([
  'const', 'let', 'var', 'function', 'class', 'extends', 'new', 'this', 'super', 'import',
  'export', 'from', 'as', 'default', 'static', 'get', 'set', 'typeof', 'delete', 'void',
  'debugger', 'with', 'enum', 'implements', 'interface', 'package', 'private', 'protected',
  'public', 'abstract', 'declare', 'namespace', 'readonly', 'satisfies', 'keyof', 'infer',
])
const JS_CONSTANT = new Set(['null', 'undefined', 'true', 'false', 'NaN', 'Infinity'])

const PY_CONTROL = new Set([
  'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return', 'try', 'except',
  'finally', 'raise', 'with', 'as', 'pass', 'await', 'yield', 'async', 'lambda', 'not',
  'and', 'or', 'in', 'is', 'assert', 'del', 'global', 'nonlocal', 'match', 'case',
])
const PY_KEYWORD = new Set(['def', 'class', 'import', 'from', 'self', 'None', 'True', 'False'])

const SH_CONTROL = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'return', 'break', 'continue', 'in'])
const SH_KEYWORD = new Set(['function', 'export', 'local', 'readonly', 'declare', 'source', 'set', 'unset', 'echo', 'cd', 'eval', 'exit', 'shift', 'trap'])

const PS_CONTROL = new Set(['if', 'elseif', 'else', 'switch', 'foreach', 'for', 'while', 'do', 'until', 'try', 'catch', 'finally', 'return', 'break', 'continue', 'throw', 'in'])
const PS_KEYWORD = new Set(['function', 'param', 'begin', 'process', 'end', 'filter', 'class', 'enum', 'using', 'exit'])

const LUA_CONTROL = new Set(['if', 'then', 'else', 'elseif', 'end', 'for', 'while', 'do', 'repeat', 'until', 'return', 'break', 'and', 'or', 'not', 'in'])
const LUA_KEYWORD = new Set(['function', 'local', 'nil', 'true', 'false', 'self', 'require'])

const SQL_CONTROL = new Set([
  'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by',
  'order', 'having', 'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'alter', 'drop', 'table', 'and', 'or', 'not', 'in', 'as', 'union', 'case', 'when', 'then', 'else', 'end',
])
const SQL_KEYWORD = new Set(['null', 'true', 'false', 'primary', 'key', 'foreign', 'references', 'default', 'unique', 'index', 'view'])

const CODE_SPECS = {
  javascript: { line: ['//'], block: [['/*', '*/']], quotes: '\'"`', control: JS_CONTROL, keyword: JS_KEYWORD, constant: JS_CONSTANT },
  typescript: { line: ['//'], block: [['/*', '*/']], quotes: '\'"`', control: JS_CONTROL, keyword: JS_KEYWORD, constant: JS_CONSTANT },
  clike: { line: ['//'], block: [['/*', '*/']], quotes: '\'"', control: JS_CONTROL, keyword: JS_KEYWORD, constant: JS_CONSTANT },
  python: { line: ['#'], block: [], quotes: '\'"', triples: ['"""', "'''"], control: PY_CONTROL, keyword: PY_KEYWORD, constant: new Set(['None', 'True', 'False']), decorator: true },
  ruby: { line: ['#'], block: [], quotes: '\'"', control: new Set(['if', 'elsif', 'else', 'end', 'unless', 'while', 'until', 'for', 'in', 'do', 'begin', 'rescue', 'ensure', 'return', 'yield', 'break', 'next', 'and', 'or', 'not']), keyword: new Set(['def', 'class', 'module', 'require', 'require_relative', 'attr_accessor', 'nil', 'true', 'false', 'self', 'new', 'puts']) },
  lua: { line: ['--'], block: [['--[[', ']]']], quotes: '\'"', control: LUA_CONTROL, keyword: LUA_KEYWORD },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: '\'"', control: SQL_CONTROL, keyword: SQL_KEYWORD, insensitive: true },
  shell: { line: ['#'], block: [], quotes: '\'"', control: SH_CONTROL, keyword: SH_KEYWORD, varRe: /(?:^|[^\\])\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/y, keys: /[ \t]*[A-Za-z_]\w*(?=[ \t]*=)/y },
  batch: { line: ['::', 'rem '], block: [], quotes: '"', control: new Set(['if', 'else', 'for', 'goto', 'call', 'exit', 'not', 'exist', 'errorlevel']), keyword: new Set(['echo', 'set', 'setlocal', 'endlocal', 'cd', 'pushd', 'popd', 'start', 'echo.', 'pause', 'type', 'del', 'copy', 'move', 'mkdir']), insensitive: true, varRe: /%[^%\n]*%/y },
  powershell: { line: ['#'], block: [['<#', '#>']], quotes: '\'"', control: PS_CONTROL, keyword: PS_KEYWORD, varRe: /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*)/y },
  yaml: { line: ['#'], block: [], quotes: '\'"', control: new Set([]), keyword: new Set([]), constant: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']), keys: /[ \t]*(?:-[ \t]+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s:#][^:#\n]*?)(?=[ \t]*:(?:[ \t]|$))/y },
  toml: { line: ['#'], block: [], quotes: '\'"', control: new Set(['true', 'false']), keyword: new Set([]), keys: /[ \t]*[A-Za-z0-9_.-]+(?=[ \t]*=)/y, sections: true },
  ini: { line: [';', '#'], block: [], quotes: '\'"', control: new Set(['true', 'false', 'on', 'off', 'yes', 'no']), keyword: new Set([]), keys: /[ \t]*[A-Za-z0-9_.-]+(?=[ \t]*=)/y, sections: true, insensitive: true },
}

const EXTENSIONS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', astro: 'html',
  xml: 'xml', svg: 'xml', xsl: 'xml', plist: 'xml', csproj: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', rst: 'markdown',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby',
  lua: 'lua',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell',
  bat: 'batch', cmd: 'batch',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini', editorconfig: 'ini',
  c: 'clike', h: 'clike', cc: 'clike', cpp: 'clike', cxx: 'clike', hpp: 'clike', hh: 'clike',
  java: 'clike', cs: 'clike', go: 'clike', rs: 'clike', php: 'clike', swift: 'clike',
  kt: 'clike', kts: 'clike', scala: 'clike', dart: 'clike', m: 'clike', mm: 'clike',
}
const FILENAMES = {
  dockerfile: 'shell', makefile: 'shell', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  '.gitignore': 'shell', '.gitattributes': 'ini', '.npmrc': 'ini', '.editorconfig': 'ini',
}

const LANGUAGE_LABEL = {
  javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', css: 'CSS', html: 'HTML',
  xml: 'XML', markdown: 'Markdown', python: 'Python', ruby: 'Ruby', lua: 'Lua', sql: 'SQL',
  shell: 'Shell', batch: 'Batch', powershell: 'PowerShell', yaml: 'YAML', toml: 'TOML',
  ini: 'INI', clike: 'C-like',
}

/** Language id for a path, or null when the editor should not colour it. */
export function languageOf(path) {
  const name = String(path || '').split('/').pop().toLowerCase()
  if (!name) return null
  if (FILENAMES[name]) return FILENAMES[name]
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return EXTENSIONS[name.slice(dot + 1)] ?? null
}

export function languageLabel(language) {
  return LANGUAGE_LABEL[language] ?? ''
}

const NUMBER_RE = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?:[a-zA-Z]{1,3}\b)?/y
const IDENT_START = /[A-Za-z_$]/u
const IDENT_PART = /[\w$]/u

function atLineHead(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const code = source.charCodeAt(cursor)
    if (code === 10) return true
    if (code !== 32 && code !== 9 && code !== 13) return false
  }
  return true
}

/** Plain token rows, used for huge files and unknown languages. */
export function plainLines(source) {
  const builder = createBuilder()
  builder.text('punc', source)
  return builder.lines
}

/** Scan a C-like language: line/block comments, quoted strings, numbers, keywords. */
function scanCode(source, spec) {
  const builder = createBuilder()
  const length = source.length
  const { control, keyword, constant } = spec
  let index = 0
  while (index < length) {
    const code = source.charCodeAt(index)
    if (code === 10) { builder.text('punc', '\n'); index++; continue }

    // section headers: [table] in TOML / INI
    if (spec.sections && code === 91 && atLineHead(source, index)) {
      const end = source.indexOf(']', index)
      if (end > index && !source.slice(index, end).includes('\n')) {
        builder.text('tag', source.slice(index, end + 1)); index = end + 1; continue
      }
    }

    if (spec.keys && atLineHead(source, index)) {
      spec.keys.lastIndex = index
      const match = spec.keys.exec(source)
      if (match && match[0].trim()) { builder.text('key', match[0]); index = spec.keys.lastIndex; continue }
    }

    if (spec.line?.length) {
      const marker = spec.line.find(item => source.startsWith(item, index)
        && (item !== 'rem ' || atLineHead(source, index)))
      if (marker) {
        let end = source.indexOf('\n', index)
        if (end < 0) end = length
        builder.text('cmt', source.slice(index, end)); index = end; continue
      }
    }

    if (spec.block?.length) {
      const pair = spec.block.find(([open]) => source.startsWith(open, index))
      if (pair) {
        const close = source.indexOf(pair[1], index + pair[0].length)
        const end = close < 0 ? length : close + pair[1].length
        builder.text('cmt', source.slice(index, end)); index = end; continue
      }
    }

    if (code === 34 || code === 39 || code === 96) {
      const triple = spec.triples?.find(marker => source.startsWith(marker, index))
      const quote = triple ?? source[index]
      const multiLine = Boolean(triple) || quote === '`'
      let cursor = index + quote.length
      while (cursor < length) {
        const current = source[cursor]
        if (current === '\\' && source[cursor + 1] !== '\n') { cursor += 2; continue }
        if (source.startsWith(quote, cursor)) { cursor += quote.length; break }
        if (current === '\n' && !multiLine) break
        cursor++
      }
      builder.text('str', source.slice(index, Math.min(cursor, length)))
      index = Math.min(cursor, length); continue
    }

    if (spec.varRe && (code === 36 || code === 37)) {
      spec.varRe.lastIndex = index
      const match = spec.varRe.exec(source)
      if (match && match[0].length) { builder.text('var', match[0]); index = spec.varRe.lastIndex; continue }
    }

    if (code >= 48 && code <= 57) {
      NUMBER_RE.lastIndex = index
      const match = NUMBER_RE.exec(source)
      if (match && match[0].length) { builder.text('num', match[0]); index = NUMBER_RE.lastIndex; continue }
    }

    const char = source[index]
    if (spec.decorator && code === 64 && IDENT_START.test(source[index + 1] ?? '')) {
      let cursor = index + 1
      while (cursor < length && IDENT_PART.test(source[cursor])) cursor++
      builder.text('fn', source.slice(index, cursor)); index = cursor; continue
    }

    if (IDENT_START.test(char)) {
      let cursor = index + 1
      while (cursor < length && IDENT_PART.test(source[cursor])) cursor++
      const word = source.slice(index, cursor)
      const folded = spec.insensitive ? word.toLowerCase() : word
      let probe = cursor
      while (probe < length && source[probe] === ' ') probe++
      let type = 'punc'
      if (constant?.has(folded)) type = 'num'
      else if (control?.has(folded)) type = 'ctl'
      else if (keyword?.has(folded)) type = 'kw'
      else if (source[probe] === '(' && !spec.insensitive) type = 'fn'
      else if (/^[A-Z][a-z]/u.test(word)) type = 'type'
      else if (/^[A-Z][A-Z0-9_]{2,}$/u.test(word)) type = 'var'
      builder.text(type, word)
      index = cursor; continue
    }

    builder.text('punc', char)
    index++
  }
  return builder.lines
}

/** JSON: keys, strings, numbers and literals. */
function scanJson(source) {
  const builder = createBuilder()
  const length = source.length
  let index = 0
  while (index < length) {
    const char = source[index]
    if (char === '\n') { builder.text('punc', '\n'); index++; continue }
    if (char === '"') {
      let cursor = index + 1
      while (cursor < length && source[cursor] !== '"') cursor += source[cursor] === '\\' ? 2 : 1
      cursor = Math.min(cursor + 1, length)
      let probe = cursor
      while (probe < length && /\s/u.test(source[probe])) probe++
      builder.text(source[probe] === ':' ? 'key' : 'str', source.slice(index, cursor))
      index = cursor; continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      const stop = end < 0 ? length : end
      builder.text('cmt', source.slice(index, stop)); index = stop; continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? length : end + 2
      builder.text('cmt', source.slice(index, stop)); index = stop; continue
    }
    if (/[-\d]/u.test(char)) {
      NUMBER_RE.lastIndex = index
      const match = NUMBER_RE.exec(source)
      if (match && match[0].length) { builder.text('num', match[0]); index = NUMBER_RE.lastIndex; continue }
    }
    if (IDENT_START.test(char)) {
      let cursor = index + 1
      while (cursor < length && IDENT_PART.test(source[cursor])) cursor++
      const word = source.slice(index, cursor)
      builder.text(['true', 'false', 'null'].includes(word) ? 'num' : 'punc', word)
      index = cursor; continue
    }
    builder.text('punc', char)
    index++
  }
  return builder.lines
}

/** CSS/SCSS: selectors before `{`, declarations inside it. */
function scanCss(source) {
  const builder = createBuilder()
  const length = source.length
  let index = 0
  let inBlock = false
  while (index < length) {
    const char = source[index]
    if (char === '\n') { builder.text('punc', '\n'); index++; continue }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? length : end + 2
      builder.text('cmt', source.slice(index, stop)); index = stop; continue
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1
      while (cursor < length && source[cursor] !== char && source[cursor] !== '\n') {
        cursor += source[cursor] === '\\' ? 2 : 1
      }
      builder.text('str', source.slice(index, Math.min(cursor + 1, length))); index = Math.min(cursor + 1, length); continue
    }
    if (char === '{') { builder.text('punc', char); inBlock = true; index++; continue }
    if (char === '}') { builder.text('punc', char); inBlock = false; index++; continue }
    if (char === '@') {
      let cursor = index + 1
      while (cursor < length && /[\w-]/u.test(source[cursor])) cursor++
      builder.text('kw', source.slice(index, cursor)); index = cursor; continue
    }
    if (inBlock) {
      if (char === '#' && /[\da-fA-F]/u.test(source[index + 1] ?? '')) {
        let cursor = index + 1
        while (cursor < length && /[\w-]/u.test(source[cursor])) cursor++
        builder.text('num', source.slice(index, cursor)); index = cursor; continue
      }
      if (char === '!' && source.startsWith('!important', index)) {
        builder.text('kw', '!important'); index += 10; continue
      }
      if (char === '$' || char === '-' || char === '_' || IDENT_START.test(char)) {
        let cursor = index + 1
        while (cursor < length && /[\w-]/u.test(source[cursor])) cursor++
        let probe = cursor
        while (probe < length && /\s/u.test(source[probe])) probe++
        builder.text(source[probe] === ':' ? 'attr' : 'punc', source.slice(index, cursor))
        index = cursor; continue
      }
      if (char >= '0' && char <= '9') {
        NUMBER_RE.lastIndex = index
        const match = NUMBER_RE.exec(source)
        if (match && match[0].length) { builder.text('num', match[0]); index = NUMBER_RE.lastIndex; continue }
      }
      builder.text('punc', char); index++; continue
    }
    // Selector positions
    if (char === '.' || char === '#') {
      let cursor = index + 1
      while (cursor < length && /[\w-]/u.test(source[cursor])) cursor++
      if (cursor > index + 1) { builder.text('type', source.slice(index, cursor)); index = cursor; continue }
    }
    if (char === ':') {
      let cursor = index + 1
      if (source[cursor] === ':') cursor++
      while (cursor < length && /[\w-]/u.test(source[cursor])) cursor++
      if (cursor > index + 1) { builder.text('fn', source.slice(index, cursor)); index = cursor; continue }
    }
    if (char === '[') {
      const end = source.indexOf(']', index)
      if (end > index && !source.slice(index, end).includes('\n')) {
        builder.text('attr', source.slice(index, end + 1)); index = end + 1; continue
      }
    }
    if (IDENT_START.test(char) || char === '-') {
      let cursor = index + 1
      while (cursor < length && /[\w-]/u.test(source[cursor])) cursor++
      builder.text('tag', source.slice(index, cursor)); index = cursor; continue
    }
    builder.text('punc', char); index++
  }
  return builder.lines
}

/** HTML/XML: comments, tag names, attribute names and values. */
function scanMarkup(source) {
  const builder = createBuilder()
  const length = source.length
  let index = 0
  let inTag = false
  while (index < length) {
    const char = source[index]
    if (char === '\n') { builder.text('punc', '\n'); index++; continue }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      const stop = end < 0 ? length : end + 3
      builder.text('cmt', source.slice(index, stop)); index = stop; continue
    }
    if (!inTag && char === '<') {
      inTag = true
      builder.text('punc', '<'); index++
      if (source[index] === '/') { builder.text('punc', '/'); index++ }
      if (source[index] === '!' || source[index] === '?') {
        let cursor = index
        while (cursor < length && source[cursor] !== '>' && source[cursor] !== '\n') cursor++
        builder.text('kw', source.slice(index, cursor)); index = cursor; continue
      }
      let cursor = index
      while (cursor < length && /[\w:.-]/u.test(source[cursor])) cursor++
      if (cursor > index) { builder.text('tag', source.slice(index, cursor)); index = cursor }
      continue
    }
    if (inTag) {
      if (char === '>') { builder.text('punc', '>'); inTag = false; index++; continue }
      if (char === '/' && source[index + 1] === '>') { builder.text('punc', '/>'); inTag = false; index += 2; continue }
      if (char === '"' || char === "'") {
        let cursor = index + 1
        while (cursor < length && source[cursor] !== char && source[cursor] !== '\n') cursor++
        builder.text('str', source.slice(index, Math.min(cursor + 1, length))); index = Math.min(cursor + 1, length); continue
      }
      if (/[\w:@#.[\]-]/u.test(char)) {
        let cursor = index + 1
        while (cursor < length && /[\w:@#.[\]-]/u.test(source[cursor])) cursor++
        builder.text('attr', source.slice(index, cursor)); index = cursor; continue
      }
      builder.text('punc', char); index++; continue
    }
    if (char === '&') {
      let cursor = index + 1
      while (cursor < length && cursor - index < 12 && source[cursor] !== ';' && source[cursor] !== '\n') cursor++
      if (source[cursor] === ';') { builder.text('num', source.slice(index, cursor + 1)); index = cursor + 1; continue }
    }
    let cursor = index
    while (cursor < length && source[cursor] !== '\n' && source[cursor] !== '<' && source[cursor] !== '&') cursor++
    if (cursor === index) { builder.text('punc', char); index++; continue }
    builder.text('punc', source.slice(index, cursor))
    index = cursor
  }
  return builder.lines
}

/** Markdown: fences, headings, quotes, list bullets and inline emphasis. */
function scanMarkdown(source) {
  const builder = createBuilder()
  const lines = source.split('\n')
  let fence = ''
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      builder.text('str', line)
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = ''
    } else if (fenceMatch) {
      fence = fenceMatch[1]
      builder.text('kw', line)
    } else if (/^\s*#{1,6}\s/u.test(line)) {
      builder.text('kw', line)
    } else if (/^\s*>/u.test(line)) {
      builder.text('cmt', line)
    } else if (/^\s*(?:[-*+]|\d+[.)])\s/u.test(line)) {
      builder.text('num', /^\s*(?:[-*+]|\d+[.)])/u.exec(line)[0])
      builder.text('punc', line.slice(/^\s*(?:[-*+]|\d+[.)])/u.exec(line)[0].length))
    } else {
      // inline: `code`, **bold**, *italic*, [text](url)
      const inline = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]*\])(\([^)\n]*\))/gu
      let start = 0
      let match
      while ((match = inline.exec(line))) {
        if (match.index > start) builder.text('punc', line.slice(start, match.index))
        if (match[1]) builder.text('str', match[1])
        else if (match[2]) builder.text('type', match[2])
        else if (match[3]) builder.text('type', match[3])
        else { builder.text('fn', match[4]); builder.text('var', match[5]) }
        start = inline.lastIndex
      }
      if (start < line.length) builder.text('punc', line.slice(start))
    }
    if (index < lines.length - 1) builder.text('punc', '\n')
  }
  return builder.lines
}

/**
 * Token rows for `source`. Unknown languages and oversized files come back as a
 * single plain token per line so the caller can paint them exactly like before.
 */
export function highlight(source, language) {
  const text = String(source ?? '')
  if (!language || text.length > MAX_HIGHLIGHT) return { lines: plainLines(text), plain: true }
  let lines
  if (language === 'json') lines = scanJson(text)
  else if (language === 'css') lines = scanCss(text)
  else if (language === 'html' || language === 'xml') lines = scanMarkup(text)
  else if (language === 'markdown') lines = scanMarkdown(text)
  else if (CODE_SPECS[language]) lines = scanCode(text, CODE_SPECS[language])
  else lines = plainLines(text)
  return { lines, plain: false }
}
