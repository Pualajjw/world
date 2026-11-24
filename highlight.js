/**
 * A small, dependency-free syntax tokenizer for the built-in editor.
 *
 * It never rewrites the text: every token keeps its original bytes, so joining
 * one line's tokens reproduces that line exactly. The editor paints these rows
 * underneath a transparent textarea, which is what keeps the caret, selection
 * and native scrolling intact while the text is coloured.
 */

const TYPE_ALIAS = { kw: 'kw', ctl: 'ctl', fn: 'fn', type: 'type', str: 'str', num: 'num', cmt: 'cmt', key: 'key', tag: 'tag', attr: 'attr', var: 'var', meta: 'meta' }

/** Collects tokens into per-line buckets, splitting on newlines inside a token. */
function createBuilder(prefix = []) {
  const lines = [...prefix, []]
  let current = lines[lines.length - 1]
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

export const PB_CONTROL = new Set(('if then else elseif end for to step next do loop while until choose case return exit continue try catch finally throw halt goto on event call trigger select from where into using connect disconnect commit rollback fetch declare cursor open close execute prepare describe').split(' '))
export const PB_KEYWORD = new Set(('global local shared public private protected type within forward prototypes variables function subroutine library alias system rpc ref readonly autoinstantiate and or not mod create destroy this super parent ancestor throws dynamic sqlsa sqlca true false null').split(' '))
export const PB_TYPES = new Set(('any blob boolean byte char character date datetime decimal dec double integer int long longlong longptr real string time uint unsignedinteger ulong unsignedlong window userobject application transaction datawindow datastore commandbutton statictext singlelineedit multilineedit').split(' '))

const CODE_SPECS = {
  powerbuilder: { line: ['//'], block: [['/*', '*/']], quotes: '\'"', control: PB_CONTROL, keyword: PB_KEYWORD,
    types: PB_TYPES, insensitive: true, escape: '~', enums: true, functions: true,
    metadata: /(?:@[^\n]*|\$PBExport(?:Header|Comments)\$[^\n]*)/iy },
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
  yaml: { line: ['#'], block: [], quotes: '\'"', control: new Set([]), keyword: new Set([]), constant: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']), keys: /[ \t]*(?:-[ \t]+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s:#][^:#\n]*?)(?=[ \t]*:(?:[ \t\n]|$))/y },
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
  sra: 'powerbuilder', sru: 'powerbuilder', srw: 'powerbuilder', srd: 'powerbuilder', srm: 'powerbuilder',
  srf: 'powerbuilder', srs: 'powerbuilder', srq: 'powerbuilder', srp: 'powerbuilder',
  pb: 'powerbuilder', pbtest: 'powerbuilder', powerscript: 'powerbuilder',
}
const FILENAMES = {
  dockerfile: 'shell', makefile: 'shell', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  '.gitignore': 'shell', '.gitattributes': 'ini', '.npmrc': 'ini', '.editorconfig': 'ini',
}

const LANGUAGE_LABEL = {
  javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', css: 'CSS', html: 'HTML',
  xml: 'XML', markdown: 'Markdown', python: 'Python', ruby: 'Ruby', lua: 'Lua', sql: 'SQL',
  shell: 'Shell', batch: 'Batch', powershell: 'PowerShell', yaml: 'YAML', toml: 'TOML',
  ini: 'INI', clike: 'C-like', powerbuilder: 'PowerBuilder',
}

/** Language id for a path, or null when the editor should not colour it. */
export function languageOf(path) {
  const name = String(path || '').split(/[\\/]/u).pop().toLowerCase()
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

/** Plain token rows for files with no known syntax. */
export function plainLines(source) {
  const builder = createBuilder()
  builder.text('punc', source)
  return builder.lines
}

function resumeComment(source, builder, state, marker) {
  if (!state?.blockComment) return 0
  const close = source.indexOf(marker), end = close < 0 ? source.length : close + marker.length
  state.blockComment = close < 0
  builder.text('cmt', source.slice(0, end))
  return end
}

function quotedEnd(source, cursor, quote, escape, multiline, state) {
  while (cursor < source.length) {
    if (source[cursor] === escape && source[cursor + 1] !== '\n') { cursor += 2; continue }
    if (source.startsWith(quote, cursor)) { if (state) state.quote = ''; return cursor + quote.length }
    if (source[cursor] === '\n' && !multiline) break
    cursor++
  }
  if (state) state.quote = multiline ? quote : ''
  return Math.min(cursor, source.length)
}

/** Scan a C-like language: line/block comments, quoted strings, numbers, keywords. */
function scanCode(source, spec, resume, lineState) {
  const builder = createBuilder(resume?.lines)
  const length = source.length
  const { control, keyword, constant } = spec
  let index = resume?.offset || resumeComment(source, builder, lineState, spec.block?.[0]?.[1])
  if (lineState?.quote) {
    index = quotedEnd(source, 0, lineState.quote, spec.escape || '\\', true, lineState)
    builder.text('str', source.slice(0, index))
  }
  while (index < length) {
    const code = source.charCodeAt(index)
    if (code === 10) {
      builder.text('punc', '\n'); index++
      // Only top-level newlines are restart points, never lines inside a string/comment.
      resume?.checkpoints.push({ offset: index, line: builder.lines.length - 1 })
      continue
    }

    if (spec.metadata && (code === 64 || code === 36) && atLineHead(source, index)) {
      spec.metadata.lastIndex = index
      const match = spec.metadata.exec(source)
      if (match) { builder.text('meta', match[0]); index = spec.metadata.lastIndex; continue }
    }

    // section headers: [table] in TOML / INI
    if (spec.sections && code === 91 && atLineHead(source, index)) {
      const end = source.indexOf(']', index)
      if (end > index && !source.slice(index, end).includes('\n')) {
        builder.text('tag', source.slice(index, end + 1)); index = end + 1; continue
      }
    }

    if (spec.keys && (index === 0 || source[index - 1] === '\n')) {
      spec.keys.lastIndex = index
      const match = spec.keys.exec(source)
      if (match && match[0].trim()) { builder.text('key', match[0]); index = spec.keys.lastIndex; continue }
    }

    if (code === 32 || code === 9) {
      let end = index + 1
      while (end < length && (source[end] === ' ' || source[end] === '\t')) end++
      builder.text('punc', source.slice(index, end)); index = end; continue
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
        if (lineState) lineState.blockComment = close < 0
        const end = close < 0 ? length : close + pair[1].length
        builder.text('cmt', source.slice(index, end)); index = end; continue
      }
    }

    if (spec.quotes.includes(source[index])) {
      const triple = spec.triples?.find(marker => source.startsWith(marker, index))
      const quote = triple ?? source[index]
      const multiLine = Boolean(triple) || quote === '`'
      const end = quotedEnd(source, index + quote.length, quote, spec.escape || '\\', multiLine, lineState)
      builder.text('str', source.slice(index, end)); index = end
      continue
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
      if (spec.enums && source[cursor] === '!') {
        builder.text('num', source.slice(index, cursor + 1)); index = cursor + 1; continue
      }
      if (constant?.has(folded)) type = 'num'
      else if (control?.has(folded)) type = 'ctl'
      else if (keyword?.has(folded)) type = 'kw'
      else if (spec.types?.has(folded)) type = 'type'
      else if (source[probe] === '(' && (!spec.insensitive || spec.functions)) type = 'fn'
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

/** One physical line for the live SRW stream parser. Only block comments cross lines
 * in this tokenizer. Both editor surfaces share token rules and theme class names. */
export function powerScriptLineTokens(line, state) {
  return scanCode(line, CODE_SPECS.powerbuilder, undefined, state)[0]
}

/** A PB line is determined by its text and its incoming block-comment state.
 * Reuse rows across newline insertions/deletions without keeping old document revisions.
 * Store only .rows after the pass; retaining the scanner would chain previous passes.
 * One entry per unique line means roughly 9× the text size (a 200 KiB draft ≈ 2 MiB,
 * the ceiling of the native editor), and the map is rebuilt per pass. */
export function powerScriptPass(previous) {
  const rows = [new Map(), new Map()]
  function scan(line, state) {
    const mode = state.blockComment ? 1 : 0, map = rows[mode]
    let entry = map.get(line) || previous?.[mode].get(line)
    if (!entry) {
      // A substring can pin an entire textarea snapshot through a single surviving token.
      // Make one independent UTF-16 string on a miss, not one copy per token or keystroke.
      // 前缀拼接再切片会生成一个不共享父 buffer 的扁平字符串，比 JSON 往返便宜得多。
      const own = (' ' + line).slice(1)
      const tokens = powerScriptLineTokens(own, state)
      entry = { text: own, tokens, blockComment: Boolean(state.blockComment) }
    }
    map.set(entry.text, entry); state.blockComment = entry.blockComment
    return entry.tokens
  }
  return { rows, scan }
}

/** JSON: keys, strings, numbers and literals. */
function scanJson(source, state) {
  const builder = createBuilder()
  const length = source.length
  let index = resumeComment(source, builder, state, '*/')
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
      if (state) state.blockComment = end < 0
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
function scanCss(source, state) {
  const builder = createBuilder()
  const length = source.length
  let index = resumeComment(source, builder, state, '*/')
  let inBlock = state?.inBlock || false
  while (index < length) {
    const char = source[index]
    if (char === '\n') { builder.text('punc', '\n'); index++; continue }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (state) state.blockComment = end < 0
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
  if (state) state.inBlock = inBlock
  return builder.lines
}

/** HTML/XML: comments, tag names, attribute names and values. */
function scanMarkup(source, state) {
  const builder = createBuilder()
  const length = source.length
  let index = resumeComment(source, builder, state, '-->')
  let inTag = state?.inTag || false
  while (index < length) {
    const char = source[index]
    if (char === '\n') { builder.text('punc', '\n'); index++; continue }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      if (state) state.blockComment = end < 0
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
  if (state) state.inTag = inTag
  return builder.lines
}

// Keep only primitives in state: the viewport tokenizer checkpoints it with a shallow copy.
const PB_FENCES = new Set(['pbtest', 'powerscript', 'powerbuilder'])
const embeddedCpp = { ...CODE_SPECS.clike,
  keyword: new Set('alignas auto const constexpr extern inline namespace new nullptr operator private public sizeof static struct template typedef typename union using virtual volatile'.split(' ')),
  types: new Set('bool char double float int int32_t int64_t long short signed uint32_t uint64_t unsigned void'.split(' ')) }

export function markdownRegion(line, state) {
  // Without a backtick or tilde no fence marker can start, so the line keeps the current
  // region. This is the per-line hot path for prose and for code inside a fence.
  if (line.indexOf('`') < 0 && line.indexOf('~') < 0) return state.fence ? (state.pbFence ? 'pb' : 'other') : 'prose'
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.replace(/\r$/u, ''))
  if (state.fence) {
    if (!match || match[1][0] !== state.fence[0] || match[1].length < state.fence.length || match[2].trim())
      return state.pbFence ? 'pb' : 'other'
    state.fence = ''; state.fenceLang = ''; state.pbFence = false
    return 'close'
  }
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return 'prose'
  state.fence = match[1]
  state.fenceLang = match[2].trim().split(/[\s:;,?{]/u, 1)[0].toLowerCase()
  state.pbFence = PB_FENCES.has(state.fenceLang)
  state.blockComment = false; state.quote = ''; state.native = ''
  return 'open'
}

function embeddedLine(line, state) {
  if (!state.blockComment && !state.quote) {
    if (!state.native) {
      const begin = /^\s*@(c|cpb|cs|cspb|rust|rustpb|go|gopb|pypb)(?:\s|$)/iu.exec(line)
      if (begin) { state.native = begin[1].toLowerCase(); return [{ type: 'meta', text: line }] }
    } else if (/^\s*@end\s+(\w+)\s*$/iu.exec(line)?.[1].toLowerCase() === state.native) {
      state.native = ''; return [{ type: 'meta', text: line }]
    }
  }
  const spec = !state.native ? CODE_SPECS.powerbuilder : state.native === 'pypb' ? CODE_SPECS.python : embeddedCpp
  return scanCode(line, spec, undefined, state)[0]
}

/** Local fence ordinals match pbnpm --markdown-block (including shared-only PB fences).
 * Leave includes, metadata, and test compilation to the CLI, using the original file. */
// The lexical part is independent of line numbers and previously discovered tests.
// A CM leaf can replay its sparse events whenever its incoming fence/comment state matches.
const testLead = /^(?:@|(?:end|forward|type|public|private|protected|global|local|subroutine|function)\b)/i
export function markdownTestEvent(line, state) {
  const region = markdownRegion(line, state)
  if (region === 'open' && state.pbFence) return true
  if (region !== 'pb') return null
  // In ordinary PB strings close at EOL. A non-declaration only needs the lexer
  // when it might change the state carried into the next line.
  if (!state.native && !state.quote && !state.blockComment && !line.includes('/*') && !testLead.test(line.trimStart())) return null
  const tokens = embeddedLine(line, state)
  if (state.native) return null
  const code = tokens.map(t => t.type === 'cmt' ? ' ' : t.text).join('').trim()
  return testLead.test(code) ? code : null
}
export function markdownTestCollector() {
  const blocks = []
  let block, routine, section = ''
  function accept(code, n) {
    if (code === true) {
      block = { index: blocks.length + 1, line: n, cases: [] }; blocks.push(block)
      routine = null; section = ''; return
    }
    if (section) { if (section.test(code)) section = ''; return }
    if (/^(?:forward|type)\s+prototypes$/i.test(code)) { section = /^end\s+prototypes$/i; return }
    if (/^@[\w]+\.sr\w\..*;$/i.test(code)) { section = /^@(?:[\w]+\.sr\w\.)?end\s/i; return }
    const signature = /^(?:(?:public|private|protected|global|local)\s+)?(subroutine|function)\s+(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*;?$/i.exec(code)
    if (signature) routine = { kind: signature[1].toLowerCase(), name: signature[2], line: n }
    else if (routine && /^end\s+(subroutine|function)\s*;?$/i.exec(code)?.[1].toLowerCase() === routine.kind) {
      if (/^test_/i.test(routine.name)) block.cases.push({ name: routine.name, line: routine.line })
      routine = null
    }
  }
  function finish() {
    // The native --filter is a substring match. Never label a prefix collision a single-case run.
    for (const { cases } of blocks) {
      const names = cases.map(c => c.name.toLowerCase()).sort()
      const ambiguous = new Set(names.filter((name, i) => names[i + 1]?.startsWith(name)))
      for (const c of cases) if (ambiguous.has(c.name.toLowerCase())) c.ambiguous = true
    }
    return blocks
  }
  return { accept, finish }
}
export function markdownTestBlocks(source) {
  const state = {}, collector = markdownTestCollector()
  let n = 0
  for (const line of source.split('\n')) {
    n++; const event = markdownTestEvent(line, state)
    if (event !== null) collector.accept(event, n)
  }
  return collector.finish()
}

/** Markdown: fences, headings, quotes, list bullets and inline emphasis. */
function scanMarkdown(source, state = {}) {
  const builder = createBuilder()
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], region = markdownRegion(line, state)
    if (region === 'open' || region === 'close') {
      builder.text('kw', line)
    } else if (region === 'pb') {
      for (const token of embeddedLine(line, state)) builder.text(token.type, token.text)
    } else if (region === 'other') {
      builder.text('str', line)
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

const markupScanners = { json: scanJson, css: scanCss, html: scanMarkup, xml: scanMarkup, markdown: scanMarkdown }

function scanKnown(text, language, state) {
  if (Object.hasOwn(CODE_SPECS, language)) return scanCode(text, CODE_SPECS[language], undefined, state)
  if (Object.hasOwn(markupScanners, language)) return markupScanners[language](text, state)
  return null
}

/** Stateful line tokenizer for virtual editors. */
export function syntaxLine(line, language, state) {
  return scanKnown(line, language, state)?.[0] ?? []
}

export function highlight(source, language) {
  const text = String(source ?? ''), lines = scanKnown(text, language)
  return lines ? { lines, plain: false } : { lines: plainLines(text), plain: true }
}

/** Per-editor cache: keep complete unchanged lines and rescan from a safe lexical boundary. */
export function createHighlighter() {
  let previous = null
  return (source, language) => {
    const text = String(source ?? '')
    if (previous?.language === language && previous.text === text) return previous.result
    if (language === 'powerbuilder') {
      const pass = powerScriptPass(previous?.pbRows), state = {}
      const result = { lines: text.split('\n').map(line => pass.scan(line, state)), plain: false }
      previous = { text, language, result, pbRows: pass.rows }
      return result
    }
    if (!Object.hasOwn(CODE_SPECS, language)) {
      const result = highlight(text, language)
      previous = { text, language, result }
      return result
    }
    let offset = 0, lines = [], checkpoints = [{ offset: 0, line: 0 }]
    if (previous?.language === language && previous.checkpoints) {
      const limit = Math.min(text.length, previous.text.length)
      let same = 0
      while (same < limit && text.charCodeAt(same) === previous.text.charCodeAt(same)) same++
      let index = previous.checkpoints.length - 1
      while (index > 0 && previous.checkpoints[index].offset > same) index--
      const point = previous.checkpoints[index]
      offset = point.offset
      lines = previous.result.lines.slice(0, point.line)
      checkpoints = previous.checkpoints.slice(0, index + 1)
    }
    const result = { lines: scanCode(text, CODE_SPECS[language], { offset, lines, checkpoints }), plain: false }
    previous = { text, language, result, checkpoints }
    return result
  }
}
