/**
 * 编辑器行级命令：移动行、复制行、切换注释。
 * 全是纯函数：吃整段文本 + 选区，返回替换后的文本与新区选，方便单测、也不碰 DOM。
 * 「行块」= 选区触及的整行（VSCode 也是这样：光标停在一行里就动整行）。
 */

function pickLines(value, start, end) {
  const lines = value.split('\n')
  const first = value.slice(0, start).split('\n').length - 1
  const last = value.slice(0, end).split('\n').length - 1
  return { lines, first, last }
}

const join = lines => lines.join('\n')

/**
 * 第 `index` 行的起始偏移。
 * 只为了算替换区间，不必给全文做前缀和：调用方永远只问相邻的一两个行首。
 */
const lineOffset = (lines, index) => {
  let offset = 0
  for (let at = 0; at < index; at++) offset += lines[at].length + 1
  return offset
}

/** `value` 是整份结果（便于单测比对），`from` / `to` / `text` 只覆盖真正变了的区间。 */
const edit = (lines, start, end, from, to, text) => ({ value: join(lines), start, end, from, to, text })

/** Alt+↑ / Alt+↓：整块与相邻行交换。到顶或到底返回 null，调用方不做任何事。 */
export function moveLineBlock(value, start, end, direction) {
  const { lines, first, last } = pickLines(value, start, end)
  if (direction < 0) {
    if (first === 0) return null
    const above = lines[first - 1]
    const block = lines.slice(first, last + 1)
    // 区间必须在改 lines 之前算：交换后前几行的长度变了，行首偏移跟着变
    const from = lineOffset(lines, first - 1)
    const to = from + above.length + 1 + block.join('\n').length
    lines.splice(first - 1, 1)
    lines.splice(last, 0, above)
    const shift = above.length + 1
    return edit(lines, start - shift, end - shift, from, to, [...block, above].join('\n'))
  }
  if (last >= lines.length - 1) return null
  const below = lines[last + 1]
  const block = lines.slice(first, last + 1)
  const from = lineOffset(lines, first)
  const to = lineOffset(lines, last + 1) + below.length
  lines.splice(last + 1, 1)
  lines.splice(first, 0, below)
  const shift = below.length + 1
  return edit(lines, start + shift, end + shift, from, to, [below, ...block].join('\n'))
}

/** Shift+Alt+↓：整块复制到下方，选区落在新复制出来的那一块（和 VSCode 一致）。 */
export function duplicateLineBlock(value, start, end) {
  const { lines, first, last } = pickLines(value, start, end)
  const block = lines.slice(first, last + 1)
  const at = lineOffset(lines, last) + lines[last].length
  lines.splice(last + 1, 0, ...block)
  const shift = block.join('\n').length + 1
  return edit(lines, start + shift, end + shift, at, at, `\n${block.join('\n')}`)
}

const indentOf = line => /^[ \t]*/u.exec(line)[0]

/**
 * Ctrl+/：把行块加注释或去掉注释。
 * 注释符写在缩进之后；判断「已注释」时忽略前导空白，全空的行不参与。
 * `prefix` 由语言决定（`//`、`#`、`--`…），没有注释符的语言直接返回 null。
 */
export function toggleCommentBlock(value, start, end, prefix) {
  if (!prefix) return null
  const { lines, first, last } = pickLines(value, start, end)
  const targets = []
  for (let index = first; index <= last; index++) if (lines[index].trim()) targets.push(index)
  if (!targets.length) return null
  const commented = targets.every(index => lines[index].slice(indentOf(lines[index]).length).startsWith(prefix))
  const from = lineOffset(lines, first)
  const to = lineOffset(lines, last) + lines[last].length
  let cursorDelta = 0
  for (const index of targets) {
    const indent = indentOf(lines[index])
    const body = lines[index].slice(indent.length)
    if (commented) {
      const stripped = body.slice(prefix.length).replace(/^ /u, '')
      if (index === first) cursorDelta = -(body.length - stripped.length)
      lines[index] = indent + stripped
    } else {
      if (index === first) cursorDelta = prefix.length + 1
      lines[index] = `${indent}${prefix} ${body}`
    }
  }
  return edit(lines, start + cursorDelta, end + cursorDelta, from, to, lines.slice(first, last + 1).join('\n'))
}

/** 行注释符：只列能整行注释的语言，其余（json / css / html / markdown / batch）返回空串，命令直接不生效。 */
const COMMENT_PREFIX = {
  javascript: '//', typescript: '//', clike: '//', powerbuilder: '//',
  python: '#', ruby: '#', shell: '#', yaml: '#', toml: '#', ini: '#',
  powershell: '#',
  lua: '--', sql: '--',
}

export function commentPrefixOf(language) {
  return COMMENT_PREFIX[String(language || '')] ?? ''
}
