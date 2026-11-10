import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dayKey, hhmm } from './companion-time.js'

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const SELF_CAP = 4000
const EXCERPT = 200
const SCAN_LIMIT = 20000
const MAX_QUERY = 200

const text = (value, name, maximum, required = false) => {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name}不能为空。`)
    return ''
  }
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${name}最多 ${maximum} 字。`)
  if (required && !value.trim()) throw new Error(`${name}不能为空。`)
  return value
}

/** Visible text of a message: text blocks only, attachments noted by kind so a picture is not silently dropped. */
export function visibleText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'image') return ['[图片]']
    if (block.type === 'file') return ['[文件]']
    return []
  }).join('\n').trim()
}

/** The live wake word is ours, not the user's: it is archived so she can find it, but never read as the user speaking. */
const LIFE_SOURCE = 'world-life'
/** Every wake word starts with this; the compaction and the archive both rely on it. */
export const LIFE_MARK = '【我的时间】'

/**
 * One conversation row, or undefined when the event carries nothing worth remembering.
 * The user's own words are `user`; a wake message the life line sent is `life`; her replies are `assistant`.
 */
export function conversationRow(event) {
  if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return undefined
  const message = event.type === 'user/message' ? event.data : event.data?.message
  if (!message || typeof message !== 'object') return undefined
  const body = visibleText(message.content)
  if (!body) return undefined
  // The host hands every prompt over as a user message; the wake words are ours, and they say so in the first line.
  const role = event.type === 'assistant/message' ? 'assistant'
    : message.source?.kind === LIFE_SOURCE || body.startsWith(LIFE_MARK) ? 'life'
      : message.source?.kind === 'user' ? 'user' : undefined
  if (!role) return undefined
  const time = new Date(event.time ?? Date.now())
  return { id: typeof message.id === 'string' ? message.id : `${event.seq}`, time: time.toISOString(), role, text: body }
}

const who = role => role === 'user' ? '用户' : role === 'assistant' ? '我' : '我的时间'
const clip = (value, maximum) => {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > maximum ? `${chars.slice(0, maximum).join('')}…` : chars.join('')
}

/**
 * Her memory on disk: conversation text by day, unchanged, plus the self-description she writes herself.
 * Nothing is indexed or rewritten; older turns are found by scanning the text, which is enough at this size.
 */
export function createCompanionMemory({ dir, now = () => new Date(), atomic } = {}) {
  const raw = () => typeof dir === 'function' ? dir() : dir
  const conversations = () => join(raw(), 'conversations')
  const selfFile = () => join(raw(), 'self.md')
  const seen = new Set()
  let loadedDay = '', cachedSelf
  let chain = Promise.resolve()

  const once = async () => {
    const day = dayKey(now())
    if (day === loadedDay) return
    loadedDay = day
    // Only today's file has to be de-duplicated: a restart can replay the newest events of the open day.
    try {
      const lines = (await readFile(join(conversations(), `${day}.jsonl`), 'utf8')).split('\n')
      for (const line of lines.slice(-500)) {
        try { const row = JSON.parse(line); if (row?.id) seen.add(row.id) } catch { /* a torn last line is not an id */ }
      }
    } catch { /* first write of the day */ }
  }
  const files = async () => {
    let names
    try { names = await readdir(conversations()) } catch { return [] }
    return names.filter(name => DAY_FILE.test(name)).sort().reverse()
  }

  function append(row) {
    if (!row) return Promise.resolve(false)
    const task = chain.then(async () => {
      await once()
      if (seen.has(row.id)) return false
      await mkdir(conversations(), { recursive: true, mode: 0o700 })
      await appendFile(join(conversations(), `${dayKey(new Date(row.time))}.jsonl`), `${JSON.stringify(row)}\n`)
      seen.add(row.id)
      return true
    })
    chain = task.then(() => {}, () => {})
    return task.catch(() => false)
  }

  async function readDay(day) {
    try {
      const content = await readFile(join(conversations(), `${day}.jsonl`), 'utf8')
      return content.split('\n').flatMap((line, index) => {
        if (!line.trim()) return []
        try {
          const row = JSON.parse(line)
          return typeof row?.text === 'string' ? [{ ...row, line: index }] : []
        } catch { return [] }
      })
    } catch { return [] }
  }

  /** Newest rows first, reading only as many day files as the count needs. */
  async function recent(limit = 40) {
    const rows = []
    for (const name of await files()) {
      const day = await readDay(DAY_FILE.exec(name)[1])
      for (let index = day.length - 1; index >= 0 && rows.length < limit; index--) rows.push(day[index])
      if (rows.length >= limit) break
    }
    return rows.reverse()
  }

  /** Recent turns as one block: who said it, when to the minute, what — no ids, no channels, nothing to re-read. */
  async function recentText(limit = 40) {
    const rows = await recent(limit)
    if (!rows.length) return ''
    return rows.map(row => `${hhmm(new Date(row.time))} ${who(row.role)}：${clip(row.text, 300)}`).join('\n')
  }

  const refOf = (day, line) => `conv:${day}:${line}`

  async function find({ query, from, to, limit = 8, cursor = 0 } = {}) {
    const needle = text(query, 'query', MAX_QUERY)
    const size = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 8))
    const skip = Number.isInteger(cursor) && cursor > 0 ? cursor : 0
    const fromMs = from ? Date.parse(from) : undefined
    const toMs = to ? Date.parse(to) : undefined
    if (from !== undefined && !Number.isFinite(fromMs)) throw new Error('from 需要带时区的 ISO 时间。')
    if (to !== undefined && !Number.isFinite(toMs)) throw new Error('to 需要带时区的 ISO 时间。')
    const items = []
    let scanned = 0, matched = 0
    for (const name of await files()) {
      const day = DAY_FILE.exec(name)[1]
      const rows = await readDay(day)
      for (let index = rows.length - 1; index >= 0; index--) {
        if (scanned++ >= SCAN_LIMIT) break
        const row = rows[index]
        const at = Date.parse(row.time)
        if (Number.isFinite(fromMs) && at < fromMs) continue
        if (Number.isFinite(toMs) && at >= toMs) continue
        if (needle && !row.text.includes(needle)) continue
        if (matched++ < skip) continue
        if (items.length >= size) continue
        items.push({ ref: refOf(day, row.line), time: row.time, kind: 'conversation', who: row.role, text: clip(row.text, EXCERPT) })
      }
      if (items.length >= size) break
    }
    return { items, nextCursor: items.length >= size ? skip + size : null, scanned, query: needle }
  }

  /** The original passage, page by character so a page never cuts a character in half. */
  async function read({ ref, offset = 0, limit = 2000 } = {}) {
    const match = /^conv:(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(String(ref ?? ''))
    if (!match) throw new Error('ref 需要是 memory 返回的那种引用，不要手写。')
    const day = match[1], line = Number(match[2])
    const rows = await readDay(day)
    const row = rows.find(item => item.line === line)
    if (!row) throw new Error('这段原文已经找不到了，请重新查找。')
    const chars = Array.from(row.text)
    const start = Math.min(chars.length, Math.max(0, Number.isInteger(offset) ? offset : 0))
    const size = Math.min(16000, Math.max(1, Number.isInteger(limit) ? limit : 2000))
    return { ref, time: row.time, who: row.role, offset: start, totalChars: chars.length,
      text: chars.slice(start, start + size).join(''), nextOffset: start + size < chars.length ? start + size : null }
  }

  /** What she wrote about herself. Unreadable is reported, never replaced with an invented one. */
  async function readSelf() {
    if (cachedSelf !== undefined) return cachedSelf
    try { cachedSelf = (await readFile(selfFile(), 'utf8')).trim() }
    catch (error) { if (error.code !== 'ENOENT') throw error; cachedSelf = '' }
    return cachedSelf
  }
  async function writeSelf(content) {
    const value = text(content, '我是谁', 100000, true)
    await mkdir(raw(), { recursive: true, mode: 0o700 })
    await writeFile(selfFile(), value.endsWith('\n') ? value : `${value}\n`, { mode: 0o600 })
    cachedSelf = value.trim()
    return cachedSelf
  }
  /** Keeps today's version beside it before a look back, so every change she makes can be seen again. */
  async function keepSelf(day = dayKey(now())) {
    let current
    try { current = await readFile(selfFile(), 'utf8') } catch { return undefined }
    const history = join(raw(), 'self.history')
    await mkdir(history, { recursive: true, mode: 0o700 })
    const copy = join(history, `${day}.md`)
    await writeFile(copy, current)
    return copy
  }

  return {
    append, recent, recentText, find, read, readSelf, writeSelf, keepSelf,
    selfText() {
      return readSelf().then(value => {
        const chars = Array.from(value)
        return chars.length > SELF_CAP
          ? `${chars.slice(0, SELF_CAP).join('')}\n（后面还有 ${chars.length - SELF_CAP} 字没读进来；挑最要紧的留下吧。）`
          : value
      })
    },
    /** The capped self as the system prompt needs it now; empty until the first read fills the cache. */
    selfTextSync() {
      const chars = Array.from(cachedSelf ?? '')
      return chars.length > SELF_CAP ? chars.slice(0, SELF_CAP).join('') : chars.join('')
    },
    async refreshSelf() { cachedSelf = undefined; return readSelf() },
    fileOf: day => join(conversations(), `${day}.jsonl`),
    selfPath: selfFile,
  }
}
