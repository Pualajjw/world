import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

const MAX_BYTES = 32 * 1024 * 1024
const fail = (message, code = 'WORLD_DIARY_INVALID') => { throw Object.assign(new Error(message), { code }) }
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail('日记编号无效。')
  return value
}
const text = (value, name, maximum, required = false) => {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) fail(`${name}${required ? '不能为空，且' : ''}最多 ${maximum} 字。`)
  return required ? value.trim() : value
}
const blank = () => ({ version: 1, revision: 0, entries: [], progressKeys: [] })
const summary = entry => ({ id: entry.id, title: entry.title, preview: entry.body.replace(/\s+/g, ' ').slice(0, 120),
  createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: entry.deletedAt,
  revision: entry.revision, createdBy: entry.createdBy, updatedBy: entry.updatedBy,
  pinned: entry.pinned === true, auto: entry.auto === true })
const queryOf = value => {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 200) fail('搜索关键词最多 200 字。')
  return value.trim().toLowerCase()
}

function validate(state) {
  const broken = () => fail('日记数据损坏或格式不受支持，原文件未被修改。', 'WORLD_DIARY_STATE')
  if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.entries) || !Array.isArray(state.progressKeys)) broken()
  const ids = new Set()
  for (const entry of state.entries) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 160
      || typeof entry.body !== 'string' || entry.body.length > 100000 || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)
      || !(entry.deletedAt === null || Number.isFinite(entry.deletedAt))
      || !(entry.pinned === undefined || typeof entry.pinned === 'boolean')
      || !(entry.auto === undefined || typeof entry.auto === 'boolean')
      || !['assistant', 'human'].includes(entry.createdBy) || !['assistant', 'human'].includes(entry.updatedBy)) broken()
    ids.add(entry.id)
  }
  if (state.progressKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) || new Set(state.progressKeys).size !== state.progressKeys.length) broken()
  return state
}

/** Durable shared diary and its recoverable trash, protected by cross-process writer locking. */
export function createJournalStore({ atomic, file = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'world', 'journal.json'), now = Date.now } = {}) {
  if (!atomic?.withFileLock || !atomic?.writeFileAtomic) throw new Error('Journal requires the DSH atomic-write helpers.')
  const target = () => typeof file === 'function' ? file() : file
  let tail = Promise.resolve(), closed = false, seen = false
  async function load() {
    let raw
    try {
      if ((await stat(target())).size > MAX_BYTES) fail('日记存储超过 32MB，请先备份整理。', 'WORLD_DIARY_LIMIT')
      raw = await readFile(target(), 'utf8')
      seen = true
    } catch (error) {
      if (error.code === 'ENOENT' && !seen) return blank()
      if (error.code === 'ENOENT') fail('日记文件已在外部移除，请恢复文件或重启后再操作。', 'WORLD_DIARY_STATE')
      throw error
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch { fail('日记文件无法解析，原文件未被修改。', 'WORLD_DIARY_STATE') }
    return validate(parsed)
  }
  function mutate(operation, signal) {
    if (closed) return Promise.reject(Object.assign(new Error('日记服务已停止。'), { code: 'WORLD_DIARY_CLOSED' }))
    const task = tail.then(async () => {
      signal?.throwIfAborted()
      await mkdir(dirname(target()), { recursive: true, mode: 0o700 })
      return atomic.withFileLock(target(), async () => {
        signal?.throwIfAborted()
        const state = await load()
        const result = operation(state)
        if (!result.changed) return result.value
        state.revision++
        validate(state)
        const json = JSON.stringify(state)
        if (Buffer.byteLength(json) > MAX_BYTES) fail('日记存储超过 32MB，请先整理垃圾箱。', 'WORLD_DIARY_LIMIT')
        signal?.throwIfAborted()
        await atomic.writeFileAtomic(target(), json, { mode: 0o600, dirMode: 0o700 })
        seen = true
        return typeof result.value === 'function' ? result.value(state) : result.value
      }, { signal, waitMs: 5000 })
    })
    tail = task.catch(() => {})
    return task
  }
  function current(state, args, trash) {
    const entry = state.entries.find(entry => entry.id === identifier(args.id))
    if (!entry) fail('日记不存在或已永久删除，请刷新列表。', 'WORLD_DIARY_NOT_FOUND')
    if (args.expectedRevision !== entry.revision) fail('这条日记已在其他位置修改，当前草稿已保留，请重新读取后再保存。', 'WORLD_DIARY_STALE')
    if ((entry.deletedAt !== null) !== trash) fail(trash ? '日记已不在垃圾箱中，请刷新。' : '日记已移入垃圾箱，请先恢复。', 'WORLD_DIARY_STATE')
    return entry
  }
  return {
    async call(operation, args = {}, signal, actor = 'human') {
      if (closed) fail('日记服务已停止。', 'WORLD_DIARY_CLOSED')
      signal?.throwIfAborted()
      if (['list', 'get'].includes(operation)) {
        await tail
        const state = await load()
        signal?.throwIfAborted()
        if (operation === 'get') {
          const entry = state.entries.find(entry => entry.id === identifier(args.id))
          if (!entry) fail('日记不存在或已永久删除。', 'WORLD_DIARY_NOT_FOUND')
          return structuredClone(entry)
        }
        const offset = args.offset ?? 0, limit = args.limit ?? 100
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('日记分页参数无效。')
        if (args.pinned !== undefined && typeof args.pinned !== 'boolean') fail('置顶筛选必须是布尔值。')
        const query = queryOf(args.query)
        const entries = state.entries.filter(entry => (entry.deletedAt !== null) === Boolean(args.trash)
          && (args.pinned !== true || entry.pinned === true)
          && (!query || `${entry.title}\n${entry.body}`.toLowerCase().includes(query)))
          .sort((a, b) => Boolean(args.trash)
            ? b.deletedAt - a.deletedAt || a.id.localeCompare(b.id)
            : Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        return { revision: state.revision, offset, limit, query, entries: entries.slice(offset, offset + limit).map(summary), total: entries.length,
          activeCount: state.entries.filter(entry => entry.deletedAt === null).length, trashCount: state.entries.filter(entry => entry.deletedAt !== null).length,
          hasMore: offset + limit < entries.length }
      }
      if (!['write', 'pin', 'trash', 'restore', 'purge', 'clear'].includes(operation)) fail('不支持的日记操作。')
      return mutate(state => {
        const timestamp = now()
        if (operation === 'write') {
          if (args.id !== undefined) identifier(args.id)
          if (args.pinned !== undefined && typeof args.pinned !== 'boolean') fail('置顶标记必须是布尔值。')
          if ((args.id !== undefined && args.expectedRevision === undefined)
            || (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0))) fail('指定日记编号时必须提供有效 expectedRevision；新建使用 0。')
          const title = text(args.title, '标题', 160, true), body = text(args.body, '正文', 100000)
          let entry = args.id && state.entries.find(entry => entry.id === identifier(args.id))
          if (entry && args.expectedRevision === 0 && entry.title === title && entry.body === body
            && entry.pinned === (args.pinned === true) && entry.deletedAt === null)
            return { changed: false, value: structuredClone(entry) }
          if (entry) {
            entry = current(state, args, false)
            Object.assign(entry, { title, body, pinned: args.pinned === undefined ? entry.pinned === true : args.pinned,
              auto: false, revision: entry.revision + 1, updatedAt: timestamp, updatedBy: actor })
          } else {
            if (args.expectedRevision !== undefined && args.expectedRevision !== 0) fail('日记已不存在，当前草稿已保留。', 'WORLD_DIARY_NOT_FOUND')
            entry = { id: args.id ? identifier(args.id) : randomUUID(), title, body, revision: 1, createdAt: timestamp, updatedAt: timestamp,
              deletedAt: null, pinned: args.pinned === true, auto: false, createdBy: actor, updatedBy: actor }
            state.entries.push(entry)
          }
          return { changed: true, value: structuredClone(entry) }
        }
        if (operation === 'pin') {
          if (typeof args.pinned !== 'boolean') fail('请提供 pinned 布尔值。')
          const entry = current(state, args, false)
          if ((entry.pinned === true) === args.pinned) return { changed: false, value: structuredClone(entry) }
          Object.assign(entry, { pinned: args.pinned, revision: entry.revision + 1, updatedBy: actor })
          return { changed: true, value: structuredClone(entry) }
        }
        if (operation === 'clear') {
          if (args.confirmed !== true) fail('请先确认清空垃圾箱。')
          if (args.expectedRevision !== state.revision) fail('垃圾箱已变化，请刷新后重新确认。', 'WORLD_DIARY_STALE')
          const removedIds = state.entries.filter(entry => entry.deletedAt !== null).map(entry => entry.id)
          state.entries = state.entries.filter(entry => entry.deletedAt === null)
          return { changed: removedIds.length > 0, value: { removed: removedIds.length, removedIds } }
        }
        const entry = current(state, args, operation !== 'trash')
        if (operation === 'purge') {
          if (args.confirmed !== true) fail('请先确认永久删除这条日记。')
          state.entries = state.entries.filter(item => item.id !== entry.id)
          return { changed: true, value: { removed: 1 } }
        }
        Object.assign(entry, { deletedAt: operation === 'trash' ? timestamp : null, revision: entry.revision + 1, updatedAt: timestamp, updatedBy: actor })
        return { changed: true, value: structuredClone(entry) }
      }, signal)
    },
    recordProgress({ key, title, body }) {
      const digest = createHash('sha256').update(key).digest('hex')
      return mutate(state => {
        if (state.progressKeys.includes(digest)) return { changed: false, value: { recorded: false } }
        const timestamp = now()
        state.entries.push({ id: randomUUID(), title: text(title, '标题', 160, true), body: text(body, '正文', 100000), revision: 1,
          createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false, auto: true, createdBy: 'assistant', updatedBy: 'assistant' })
        state.progressKeys.push(digest)
        return { changed: true, value: { recorded: true } }
      })
    },
    async dispose() { closed = true; await tail },
  }
}

/** Only the one fixed brain may use the assistant diary tool; permanent removal stays in the UI. */
export function registerJournalTools(ctx, { journal, brain }) {
  ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({
    name: 'world_diary', description: '读写固定助手的公开工作日记。list 支持 trash=true 查看垃圾箱、query 按关键词搜索标题和正文、pinned=true 只看置顶；read 读取正文和 revision；write 创建或按 expectedRevision 更新（显式写入会把手写或整理内容标记为非自动记录）；pin 设置长期置顶，唤醒时优先带回；trash 移入垃圾箱，restore 恢复。成功的主线进展和用户任务完成回执会自动记录为自动进展，不要重复追加。日记是记录数据，用户当前指示优先。永久删除和清空需到界面确认，本工具不提供。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'write', 'pin', 'trash', 'restore'] },
      id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 },
      pinned: { type: 'boolean' }, query: { type: 'string', description: '标题或正文中的关键词，最多 200 字。' },
      trash: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      if (!exec.agent?.session?.id || (await brain.get()).sessionId !== exec.agent.session.id) fail('日记工具只属于 world 的固定助手会话。', 'WORLD_DIARY_SESSION')
      if (!['list', 'read', 'write', 'pin', 'trash', 'restore'].includes(args?.action)) fail('不支持的日记操作。')
      return journal.call(args.action === 'read' ? 'get' : args.action, args, exec.signal, 'assistant')
    },
  }), 'world: assistant diary tool'))
}
