/**
 * 迷你终端屏幕：把子进程吐出来的 ANSI 文本按真实终端的方式落进格子里。
 *
 * 只实现「看得见」的那部分——SGR 颜色、回车覆盖、清行清屏、光标移动。终端里最容易
 * 糊成一团的东西全靠这几条：git 的彩色输出、npm/pip 的进度条、vite 的原地刷新。
 *
 * 列宽按真实终端算：汉字、假名、全角标点、emoji 占两格，组合符号占零格。不这么做的话
 * 「中文 + 英文」的表格会从第一行就开始错位，进度条用 `\r` 回写的宽度也对不上。
 * 滚动区域、鼠标协议、备用屏幕之类一律不做。
 */

const DEFAULT_MAX_ROWS = 2000
const DEFAULT_MAX_COLUMNS = 512
/** 格子总量上限：行数没超但每行都很长时，也得从头部丢，否则一篇日志就能把页面拖死。 */
const DEFAULT_MAX_CELLS = 60000
const TAB_WIDTH = 8

/**
 * 东亚宽字符区间（Unicode East Asian Width 的 W/F，加上 emoji）。一张手写表比引入依赖
 * 划算：终端输出里会出现的宽字符基本都在这几段里，剩下的按一格处理也不会更糟。
 */
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f5ff], [0x1f600, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

/** 组合符号、变体选择符、零宽连接符：贴在上一格里，不单独占宽。 */
function isZeroWidth(point) {
  return point === 0x200b || point === 0x200c || point === 0x200d || point === 0xfeff || point === 0xfe0f
    || (point >= 0x0300 && point <= 0x036f) || (point >= 0x20d0 && point <= 0x20f0)
}

/** 一个码点占几列。控制字符由 write 提前吃掉，这里只处理可打印字符。 */
export function charWidth(point) {
  if (!Number.isFinite(point) || point < 0) return 1
  if (isZeroWidth(point)) return 0
  for (const [low, high] of WIDE_RANGES) {
    if (point < low) return 1 // 区间是按顺序排的，提前退出省得每次扫到底
    if (point <= high) return 2
  }
  return 1
}

/** 没有样式：默认前景/背景色由主题决定，这里只留空。 */
export const NO_STYLE = Object.freeze({ fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, inverse: false })

/** 16 色以内交给 CSS 变量（深浅色各一套），再往上按 xterm 的规则算成具体颜色。 */
export function colorCss(token) {
  if (!token) return ''
  if (token.startsWith('#')) return token
  const index = Number(token.slice(1))
  if (!Number.isInteger(index) || index < 0) return ''
  if (index < 16) return `var(--world-term-ansi-${index})`
  if (index < 232) {
    const cube = index - 16
    const step = value => (value === 0 ? 0 : 55 + value * 40)
    return `rgb(${step(Math.floor(cube / 36))} ${step(Math.floor((cube % 36) / 6))} ${step(cube % 6)})`
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10
    return `rgb(${level} ${level} ${level})`
  }
  return ''
}

const styleKey = style => `${style.fg}|${style.bg}|${style.bold ? 1 : 0}${style.dim ? 1 : 0}`
  + `${style.italic ? 1 : 0}${style.underline ? 1 : 0}${style.inverse ? 1 : 0}`

/** 样式对象要能被 `===` 比较，渲染时才能把相邻同样式的格子拼成一段。 */
function createPalette() {
  const cache = new Map([[styleKey(NO_STYLE), NO_STYLE]])
  return {
    intern(style) {
      const key = styleKey(style)
      let hit = cache.get(key)
      if (!hit) { hit = Object.freeze({ ...style }); cache.set(key, hit) }
      return hit
    },
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * 建一屏。写入是增量的：`write` 只吃掉新到的字节，`snapshot` 才把格子整理成渲染用的行。
 * @param {{ maxRows?: number, maxColumns?: number, maxCells?: number }} [options]
 */
export function createScreen(options = {}) {
  const maxRows = Math.max(20, options.maxRows ?? DEFAULT_MAX_ROWS)
  const maxColumns = Math.max(20, options.maxColumns ?? DEFAULT_MAX_COLUMNS)
  const maxCells = Math.max(2000, options.maxCells ?? DEFAULT_MAX_CELLS)
  const palette = createPalette()

  /** @type {{ ch: string, style: object, w: number }[][]} */
  let rows = []
  let cursorRow = 0
  let cursorCol = 0
  let style = NO_STYLE
  let trimmed = 0
  let cells = 0
  let cache = null

  const invalidate = () => { cache = null }

  function trimHead() {
    while (rows.length > maxRows || cells > maxCells) {
      const dropped = rows.shift()
      if (!dropped) break
      cells -= dropped.length
      trimmed += 1
      cursorRow = Math.max(0, cursorRow - 1)
    }
  }

  function rowAt(index) {
    while (rows.length <= index) rows.push([])
    return rows[index]
  }

  const BLANK = () => ({ ch: ' ', style: NO_STYLE, w: 1 })

  /**
   * 写一格。覆盖到宽字符的任意一半时，把另一半也换成空格——否则会留下半个汉字，
   * 之后所有列都会跟着错位。行不够长就补空格。
   */
  function setCell(row, index, cell) {
    const existing = row[index]
    if (existing) {
      if (existing.w === 0 && index > 0 && row[index - 1]?.w === 2) row[index - 1] = BLANK()
      else if (existing.w === 2 && row[index + 1]?.w === 0) row[index + 1] = BLANK()
    }
    if (index < row.length) { row[index] = cell; return }
    while (row.length < index) { row.push(BLANK()); cells += 1 }
    row.push(cell)
    cells += 1
  }

  /** 一段区间变成空格；区间边界压在宽字符上时把整个字一起抹掉。 */
  function blankRange(row, from, to) {
    let start = Math.max(0, from)
    let end = Math.min(row.length, to)
    if (end <= start) return
    if (start > 0 && row[start - 1]?.w === 2) start -= 1
    if (end < row.length && row[end]?.w === 0) end += 1
    for (let index = start; index < end; index += 1) row[index] = BLANK()
  }

  /** 组合符号（声调、变体选择符）贴在上一格后面，不占新列。 */
  function appendZeroWidth(text) {
    const row = rows[cursorRow]
    const index = cursorCol - 1
    if (!row || index < 0) return
    const cell = row[index]
    if (!cell || cell.w === 0) return
    row[index] = { ...cell, ch: `${cell.ch}${text}` }
    invalidate()
  }

  function put(ch, width = 1) {
    if (width === 0) { appendZeroWidth(ch); return }
    // 两格宽的字写不进最后一列：真终端会先换行，而不是把它劈成两半
    if (cursorCol + width > maxColumns) { cursorRow += 1; cursorCol = 0 }
    const row = rowAt(cursorRow)
    setCell(row, cursorCol, { ch, style, w: width })
    if (width === 2) setCell(row, cursorCol + 1, { ch: '', style, w: 0 })
    cursorCol += width
    trimHead()
    invalidate()
  }

  function newline() {
    cursorRow += 1
    cursorCol = 0
    trimHead()
    invalidate()
  }

  function applySgr(params) {
    // 没写参数的 `ESC[m` 等于 `ESC[0m`；`;` 空段也当 0（真实终端就是这么宽容）。
    const codes = params.length ? params : [0]
    let next = { ...style }
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]
      if (code === 0) { next = { ...NO_STYLE }; continue }
      if (code === 1) { next.bold = true; continue }
      if (code === 2) { next.dim = true; continue }
      if (code === 3) { next.italic = true; continue }
      if (code === 4) { next.underline = true; continue }
      if (code === 7) { next.inverse = true; continue }
      if (code === 22) { next.bold = false; next.dim = false; continue }
      if (code === 23) { next.italic = false; continue }
      if (code === 24) { next.underline = false; continue }
      if (code === 27) { next.inverse = false; continue }
      if (code >= 30 && code <= 37) { next.fg = `i${code - 30}`; continue }
      if (code === 39) { next.fg = ''; continue }
      if (code >= 40 && code <= 47) { next.bg = `i${code - 40}`; continue }
      if (code === 49) { next.bg = ''; continue }
      if (code >= 90 && code <= 97) { next.fg = `i${code - 90 + 8}`; continue }
      if (code >= 100 && code <= 107) { next.bg = `i${code - 100 + 8}`; continue }
      if (code === 38 || code === 48) {
        const extended = params[index + 1]
        if (extended === 5 && Number.isInteger(params[index + 2])) {
          const token = `i${params[index + 2]}`
          if (code === 38) next.fg = token; else next.bg = token
          index += 2
        } else if (extended === 2 && params.slice(index + 2, index + 5).length === 3) {
          const [r, g, b] = params.slice(index + 2, index + 5)
          const token = `#${[r, g, b].map(value => clamp(value, 0, 255).toString(16).padStart(2, '0')).join('')}`
          if (code === 38) next.fg = token; else next.bg = token
          index += 4
        }
        continue
      }
      // 其余（字体、边框、上划线……）不认，但不影响颜色状态
    }
    style = palette.intern(next)
  }

  function eraseLine(mode) {
    const row = rowAt(cursorRow)
    if (mode === 2) {
      cells -= row.length
      row.length = 0
    } else if (mode === 1) {
      blankRange(row, 0, cursorCol + 1)
    } else if (cursorCol < row.length) {
      blankRange(row, cursorCol, row.length)
      cells -= row.length - cursorCol
      row.length = cursorCol
    }
    trimHead()
    invalidate()
  }

  function eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      rows = []
      cells = 0
      cursorRow = 0
      cursorCol = 0
    } else if (mode === 1) {
      for (let index = 0; index < Math.min(cursorRow, rows.length); index += 1) {
        cells -= rows[index].length
        rows[index] = []
      }
      eraseLine(1)
    } else {
      eraseLine(0)
      for (let index = cursorRow + 1; index < rows.length; index += 1) cells -= rows[index].length
      rows.length = Math.min(rows.length, cursorRow + 1)
    }
    trimHead()
    invalidate()
  }

  /** ESC [ … final：参数按 `;` 切开，`?` 开头的私有序列一律忽略（显隐光标、备用屏幕都不做）。 */
  function applyCsi(raw, final) {
    if (raw.startsWith('?') || raw.startsWith('>') || raw.startsWith('!')) return
    const params = raw.split(';').map(part => (part === '' ? 0 : Number.parseInt(part, 10)))
    const first = Number.isInteger(params[0]) ? params[0] : 0
    if (final === 'm') { applySgr(params); return }
    if (final === 'K') { eraseLine(first); return }
    if (final === 'J') { eraseDisplay(first); return }
    if (final === 'H' || final === 'f') {
      cursorRow = Math.max(0, (Number.isInteger(params[0]) && params[0] > 0 ? params[0] : 1) - 1)
      cursorCol = Math.max(0, (Number.isInteger(params[1]) && params[1] > 0 ? params[1] : 1) - 1)
      invalidate()
      return
    }
    if (final === 'G') { cursorCol = Math.max(0, (first || 1) - 1); invalidate(); return }
    if (final === 'A') { cursorRow = Math.max(0, cursorRow - (first || 1)); invalidate(); return }
    if (final === 'B') { cursorRow += first || 1; invalidate(); return }
    if (final === 'C') { cursorCol += first || 1; invalidate(); return }
    if (final === 'D') { cursorCol = Math.max(0, cursorCol - (first || 1)); invalidate(); return }
    if (final === 'X') {
      blankRange(rowAt(cursorRow), cursorCol, cursorCol + (first || 1))
      invalidate()
    }
  }

  /** 从一个 ESC 后面接着解析，返回下一个待处理字符的下标。 */
  function escape(text, start) {
    const next = text.charCodeAt(start)
    if (next === 0x5b) { // '['
      let index = start + 1
      while (index < text.length) {
        const code = text.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          applyCsi(text.slice(start + 1, index), text[index])
          return index + 1
        }
        index += 1
      }
      return index
    }
    if (next === 0x5d) { // ']' OSC：窗口标题、超链接，整段丢掉
      let index = start + 1
      while (index < text.length) {
        const code = text.charCodeAt(index)
        if (code === 0x07) return index + 1
        if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2
        index += 1
      }
      return index
    }
    if (next === 0x28 || next === 0x29 || next === 0x23) return start + 2 // 字符集、行宽
    return start + 1
  }

  function write(text) {
    const input = String(text ?? '')
    if (!input) return
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index)
      if (code === 0x1b) { index = escape(input, index + 1) - 1; continue }
      if (code === 0x0a) { newline(); continue }
      if (code === 0x0d) { cursorCol = 0; invalidate(); continue }
      if (code === 0x08) { cursorCol = Math.max(0, cursorCol - 1); invalidate(); continue }
      if (code === 0x09) { do { put(' ') } while (cursorCol % TAB_WIDTH !== 0); continue }
      // NUL、BEL、DEL 以及其余控制字符都不占格子
      if (code < 0x20 || code === 0x7f) continue
      // 代理对要作为一个整体写：否则 emoji 会被拆成两个看不见的半字符
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = input.charCodeAt(index + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          const point = input.codePointAt(index)
          put(input.slice(index, index + 2), charWidth(point))
          index += 1
          continue
        }
      }
      put(input[index], charWidth(code))
    }
  }

  function toRuns(row) {
    const runs = []
    for (const cell of row) {
      // 宽字符的后半格没有自己的字：字已经在前一格完整画出来了
      if (cell.w === 0) continue
      const last = runs.at(-1)
      if (last && last.style === cell.style) last.text += cell.ch
      else runs.push({ text: cell.ch, style: cell.style })
    }
    // 行尾空白只留一格：省 DOM，也不影响观感（等宽字体下空白与空格同宽）
    while (runs.length && runs.at(-1).text.trim() === '' && runs.at(-1).style === NO_STYLE) runs.pop()
    return runs
  }

  return {
    write,
    clear() {
      rows = []
      cells = 0
      cursorRow = 0
      cursorCol = 0
      style = NO_STYLE
      invalidate()
    },
    /** 渲染用的快照：行是「同样式的连续格子」，空行给空数组（前端用零宽空格占位）。 */
    snapshot() {
      if (cache) return cache
      const lines = rows.map(toRuns)
      while (lines.length && lines.at(-1).length === 0) lines.pop()
      cache = {
        rows: lines,
        cursor: { row: Math.min(cursorRow, Math.max(0, lines.length - 1)), col: cursorCol },
        trimmed,
      }
      return cache
    },
    /** 纯文本视图：测试和「复制全部」用，丢掉颜色。 */
    text() {
      return rows.map(row => row.map(cell => (cell.w === 0 ? '' : cell.ch)).join('')).join('\n')
    },
    /**
     * 光标是否在行首。窗口要在写提示行之前问一句：命令没换行就结束（进度条、`write` 不带 \n）
     * 时，提示行会黏在输出尾巴上——真终端里也一样难看。
     */
    atLineStart() {
      return cursorCol === 0
    },
    get trimmed() { return trimmed },
  }
}
