/** QR Model 2, byte mode, error correction L, versions 1–10. No runtime imports. */
const BLOCKS = [null, [[1, 26, 19]], [[1, 44, 34]], [[1, 70, 55]], [[1, 100, 80]],
  [[1, 134, 108]], [[2, 86, 68]], [[2, 98, 78]], [[2, 121, 97]], [[2, 146, 116]], [[2, 86, 68], [2, 87, 69]]]
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
const exp = new Uint8Array(512), log = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= 0x11d }
for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
const mul = (a, b) => a && b ? exp[log[a] + log[b]] : 0
function parity(data, count) {
  let generator = [1]
  for (let i = 0; i < count; i++) {
    const next = new Array(generator.length + 1).fill(0)
    generator.forEach((value, j) => { next[j] ^= value; next[j + 1] ^= mul(value, exp[i]) })
    generator = next
  }
  const result = [...data, ...new Array(count).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const factor = result[i]
    generator.forEach((value, j) => { result[i + j] ^= mul(value, factor) })
  }
  return result.slice(-count)
}
function bch(value, polynomial) {
  let result = value
  const degree = n => 31 - Math.clz32(n)
  while (result && degree(result) >= degree(polynomial)) result ^= polynomial << (degree(result) - degree(polynomial))
  return result
}
const masks = [(r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => r * c % 2 + r * c % 3 === 0, (r, c) => (r * c % 2 + r * c % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + r * c % 3) % 2 === 0]
function score(grid) {
  const n = grid.length
  let result = 0, dark = 0
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    dark += Number(grid[r][c])
    if (r && c && grid[r][c] === grid[r - 1][c] && grid[r][c] === grid[r][c - 1] && grid[r][c] === grid[r - 1][c - 1]) result += 3
  }
  for (let axis = 0; axis < 2; axis++) for (let i = 0; i < n; i++) {
    const line = Array.from({ length: n }, (_, j) => Number(axis ? grid[j][i] : grid[i][j])).join('')
    for (const run of line.matchAll(/0{5,}|1{5,}/g)) result += run[0].length - 2
    for (let j = 0; j <= n - 11; j++) if (['00001011101', '10111010000'].includes(line.slice(j, j + 11))) result += 40
  }
  return result + Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10
}
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text)
  const version = BLOCKS.findIndex((blocks, v) => v && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= blocks.reduce((sum, [count, _total, data]) => sum + count * data, 0) * 8)
  if (version < 1) throw new Error('连接地址过长，无法生成二维码。')
  const capacity = BLOCKS[version].reduce((sum, [count, _total, data]) => sum + count * data, 0)
  const bits = []
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  put(4, 4); put(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) put(byte, 8)
  put(0, Math.min(4, capacity * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0))
  for (let i = 0; data.length < capacity; i++) data.push(i % 2 ? 0x11 : 0xec)
  const blocks = [], checks = []
  let offset = 0
  for (const [count, total, length] of BLOCKS[version]) for (let i = 0; i < count; i++) {
    const block = data.slice(offset, offset += length)
    blocks.push(block); checks.push(parity(block, total - length))
  }
  const code = []
  for (const list of [blocks, checks]) for (let i = 0; i < Math.max(...list.map(row => row.length)); i++)
    for (const row of list) if (i < row.length) code.push(row[i])
  const n = version * 4 + 17
  const base = Array.from({ length: n }, () => new Array(n).fill(null))
  for (const [top, left] of [[0, 0], [0, n - 7], [n - 7, 0]]) for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
    if (top + r < 0 || left + c < 0 || top + r >= n || left + c >= n) continue
    base[top + r][left + c] = r >= 0 && r <= 6 && c >= 0 && c <= 6
      && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
  }
  for (const r of ALIGN[version]) for (const c of ALIGN[version]) {
    if (base[r][c] !== null) continue
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) base[r + y][c + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1
  }
  for (let i = 8; i < n - 8; i++) { if (base[i][6] === null) base[i][6] = i % 2 === 0; if (base[6][i] === null) base[6][i] = i % 2 === 0 }
  if (version >= 7) {
    const value = (version << 12) | bch(version << 12, 0x1f25)
    for (let i = 0; i < 18; i++) { base[Math.floor(i / 3)][n - 11 + i % 3] = Boolean(value & (1 << i)); base[n - 11 + i % 3][Math.floor(i / 3)] = Boolean(value & (1 << i)) }
  }
  let best, minimum = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map(row => [...row])
    const format = (((8 | mask) << 10) | bch((8 | mask) << 10, 0x537)) ^ 0x5412
    for (let i = 0; i < 15; i++) {
      const bit = Boolean(format & (1 << i))
      grid[i < 6 ? i : i < 8 ? i + 1 : n - 15 + i][8] = bit
      grid[8][i < 8 ? n - i - 1 : i < 9 ? 7 : 14 - i] = bit
    }
    grid[n - 8][8] = true
    let row = n - 1, direction = -1, index = 0
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--
      while (true) {
        for (let x = 0; x < 2; x++) if (grid[row][col - x] === null) {
          const bit = index < code.length * 8 && Boolean(code[index >>> 3] & (1 << (7 - index % 8)))
          grid[row][col - x] = bit !== masks[mask](row, col - x); index++
        }
        row += direction
        if (row < 0 || row >= n) { row -= direction; direction = -direction; break }
      }
    }
    const penalty = score(grid)
    if (penalty < minimum) { minimum = penalty; best = grid }
  }
  return best
}
export function qrSvg(text) {
  const grid = qrMatrix(text), size = grid.length + 8
  const path = grid.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : [])).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="#000" d="${path}"/></svg>`
}
