import assert from 'node:assert/strict'
import test from 'node:test'
import { NO_STYLE, charWidth, colorCss, createScreen } from '../ansi.js'

const write = (screen, text) => { screen.write(text); return screen.snapshot() }
const plain = screen => screen.snapshot().rows.map(row => row.map(run => run.text).join(''))

test('plain text becomes one row per newline', () => {
  const screen = createScreen()
  write(screen, 'first\nsecond\n')
  assert.deepEqual(plain(screen), ['first', 'second'])
  // 结尾的换行不额外留下一个空行，否则每条命令后面都会多出两行空白
  assert.equal(screen.snapshot().cursor.row, 1)
})

test('CRLF and a trailing newline do not leave blank rows', () => {
  const screen = createScreen()
  write(screen, 'a\r\nb\r\n')
  assert.deepEqual(plain(screen), ['a', 'b'])
})

test('basic SGR colours split a line into styled runs', () => {
  const screen = createScreen()
  const snapshot = write(screen, '\x1b[31mred\x1b[0m plain')
  assert.equal(snapshot.rows.length, 1)
  assert.deepEqual(snapshot.rows[0].map(run => run.text), ['red', ' plain'])
  assert.equal(snapshot.rows[0][0].style.fg, 'i1')
  assert.equal(snapshot.rows[0][1].style, NO_STYLE)
})

test('bright, bold, 256-colour and truecolour all survive', () => {
  const screen = createScreen()
  const snapshot = write(screen, '\x1b[1;92mA\x1b[38;5;208mB\x1b[38;2;1;2;3mC\x1b[0m')
  const [bold, cube, exact] = snapshot.rows[0]
  assert.equal(bold.style.fg, 'i10')
  assert.equal(bold.style.bold, true)
  assert.equal(cube.style.fg, 'i208')
  assert.equal(exact.style.fg, '#010203')
})

test('carriage return overwrites the progress line instead of stacking it', () => {
  const screen = createScreen()
  write(screen, 'downloading  10%\rdownloading  90%\rdownloading 100%\n')
  assert.deepEqual(plain(screen), ['downloading 100%'])
})

test('erase-line and erase-display clear what a spinner expects', () => {
  const screen = createScreen()
  write(screen, 'old text\r\x1b[2Kok\nleft\x1b[2Jtop')
  assert.deepEqual(plain(screen), ['top'])
})

test('erase to end of line keeps the text before the cursor', () => {
  const screen = createScreen()
  write(screen, 'keep me\r\x1b[2C\x1b[K')
  assert.deepEqual(plain(screen), ['ke'])
})

test('cursor up plus overscore rewrites a previous line', () => {
  const screen = createScreen()
  write(screen, 'abc\r\nxyz\x1b[1A\r\x1b[2Cz')
  assert.deepEqual(plain(screen), ['abz', 'xyz'])
})

test('tabs land on eight-column stops and backspace eats one cell', () => {
  const screen = createScreen()
  write(screen, 'a\tb\x08c')
  // 制表符把光标推到第 8 列（补 7 个空格），写 b 后回退一格，c 盖掉 b
  assert.deepEqual(plain(screen), ['a       c'])
})

test('OSC titles and unknown private sequences are dropped quietly', () => {
  const screen = createScreen()
  write(screen, '\x1b]0;window title\x07\x1b[?25lvisible\x1b[?25h')
  assert.deepEqual(plain(screen), ['visible'])
})

test('the colour table maps 16 ANSI slots to CSS variables and beyond that to rgb', () => {
  assert.equal(colorCss('i0'), 'var(--world-term-ansi-0)')
  assert.equal(colorCss('i15'), 'var(--world-term-ansi-15)')
  assert.equal(colorCss('i196'), 'rgb(255 0 0)')
  assert.equal(colorCss('i244'), 'rgb(128 128 128)')
  assert.equal(colorCss('#0a0b0c'), '#0a0b0c')
  assert.equal(colorCss(''), '')
})

test('scrollback is bounded and reports how much was dropped', () => {
  const screen = createScreen({ maxRows: 30 })
  for (let index = 0; index < 100; index += 1) write(screen, `line ${index}\n`)
  const lines = plain(screen)
  assert.equal(lines.length, 30)
  assert.equal(lines.at(-1), 'line 99')
  assert.equal(screen.trimmed, 70)
})

test('clear forgets the screen but keeps the dropped-line counter', () => {
  const screen = createScreen({ maxRows: 30 })
  for (let index = 0; index < 60; index += 1) write(screen, `x${index}\n`)
  screen.clear()
  assert.deepEqual(plain(screen), [])
  assert.equal(screen.trimmed, 30)
})

test('a single very long line wraps instead of exhausting the cell budget', () => {
  const screen = createScreen({ maxColumns: 40 })
  write(screen, 'x'.repeat(100))
  const lines = plain(screen)
  assert.equal(lines.length, 3)
  assert.equal(lines[0].length, 40)
  assert.equal(lines.at(-1).length, 20)
})

test('atLineStart tells the prompt whether it needs its own line', () => {
  const screen = createScreen()
  assert.equal(screen.atLineStart(), true)
  write(screen, 'partial progress 40%\rpartial progress 80%')
  assert.equal(screen.atLineStart(), false)
  write(screen, '\n')
  assert.equal(screen.atLineStart(), true)
})

test('empty writes are a no-op', () => {
  const screen = createScreen()
  write(screen, '')
  write(screen, undefined)
  assert.deepEqual(plain(screen), [])
})

test('wide characters take two columns and keep their text intact', () => {
  const screen = createScreen()
  write(screen, '中文abc')
  // 两个汉字四列 + 三个字母 = 7，光标位置就是这个宽度
  assert.equal(screen.snapshot().cursor.col, 7)
  assert.deepEqual(plain(screen), ['中文abc'])
  // 两格宽的字只产出一段文本，不会多一个占位空格
  assert.deepEqual(screen.snapshot().rows[0].map(run => run.text), ['中文abc'])
})

test('overwriting half of a wide character clears the whole character', () => {
  const screen = createScreen()
  write(screen, '中文\rX')
  // 光标回到第 0 列盖住「中」的前半格，后半格也得跟着消失
  assert.equal(plain(screen)[0], 'X 文')
  write(screen, '\r\x1b[3CX\x1b[0m')
  // 再盖住「文」的后半格：剩下的前半格不能留着当半个汉字
  assert.equal(plain(screen)[0].includes('文'), false)
})

test('emoji survive as one code point instead of two broken halves', () => {
  const screen = createScreen()
  write(screen, '👍 ok')
  assert.equal(plain(screen)[0], '👍 ok')
  assert.equal(screen.snapshot().cursor.col, 5)
  assert.equal(charWidth(0x1f44d), 2)
})

test('combining marks ride along with the previous cell', () => {
  const screen = createScreen()
  write(screen, 'e\u0301x')
  assert.equal(plain(screen)[0], 'e\u0301x')
  assert.equal(screen.snapshot().cursor.col, 2)
  assert.equal(charWidth(0x0301), 0)
})

test('a wide character never straddles the last column', () => {
  const screen = createScreen({ maxColumns: 40 })
  write(screen, `${'a'.repeat(39)}中w`)
  const lines = plain(screen)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].length, 39)
  assert.equal(lines[1], '中w')
})

test('erase-to-end never leaves half a wide character behind', () => {
  const screen = createScreen()
  write(screen, '中a\r')
  // 光标停在第 0 列，EL 到行尾：整个屏幕该被抹干净
  write(screen, '\x1b[K')
  assert.deepEqual(plain(screen), [])
})
