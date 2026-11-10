import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_ITEMS = 1000
const MAX_ACTIVE = 300
const STATUSES = ['pending', 'doing', 'blocked', 'done']
const ORDER = { doing: 0, pending: 1, blocked: 2, done: 3 }
const fail = (message, code = 'WORLD_TASKS_INVALID') => { throw Object.assign(new Error(message), { code }) }
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail('待办编号无效。')
  return value
}
const text = (value, name, maximum, required = false) => {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) fail(`${name}${required ? '不能为空，且' : ''}最多 ${maximum} 字。`)
  return required ? value.trim() : value
}
const statusOf = value => {
  if (!STATUSES.includes(value)) fail('状态必须是 pending / doing / blocked / done。')
  return value
}
const blank = () => ({ version: 1, revision: 0, items: [] })
const summary = item => ({ id: item.id, title: item.title, note: item.note, next: item.next, status: item.status,
  revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt, doneAt: item.doneAt,
  createdBy: item.createdBy, updatedBy: item.updatedBy })

function validate(state) {
  const broken = () => fail('待办数据损坏或格式不受支持，原文件未被修改。', 'WORLD_TASKS_STATE')
  if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items)) broken()
  if (state.items.length > MAX_ITEMS) broken()
  const ids = new Set()
  for (const item of state.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) || ids.has(item.id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200
      || typeof item.note !== 'string' || item.note.length > 4000
      || typeof item.next !== 'string' || item.next.length > 500
      || !STATUSES.includes(item.status)
      || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)
      || !(item.doneAt === null || Number.isFinite(item.doneAt))
      || !['assistant', 'human'].includes(item.createdBy) || !['assistant', 'human'].includes(item.updatedBy)) broken()
    ids.add(item.id)
  }
  return state
}

/** A shared, durable task list: the diary records what happened, this records what is still open. */
export function createTasksStore({ atomic, file = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'world', 'tasks.json'), now = Date.now } = {}) {
  if (!atomic?.withFileLock || !atomic?.writeFileAtomic) throw new Error('Tasks require the DSH atomic-write helpers.')
  const target = () => typeof file === 'function' ? file() : file
  let tail = Promise.resolve(), closed = false, seen = false
  async function load() {
    let raw
    try {
      if ((await stat(target())).size > MAX_BYTES) fail('待办存储超过 8MB，请先整理。', 'WORLD_TASKS_LIMIT')
      raw = await readFile(target(), 'utf8')
      seen = true
    } catch (error) {
      if (error.code === 'ENOENT' && !seen) return blank()
      if (error.code === 'ENOENT') fail('待办文件已在外部移除，请恢复文件或重启后再操作。', 'WORLD_TASKS_STATE')
      throw error
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch { fail('待办文件无法解析，原文件未被修改。', 'WORLD_TASKS_STATE') }
    return validate(parsed)
  }
  function mutate(operation, signal) {
    if (closed) return Promise.reject(Object.assign(new Error('待办服务已停止。'), { code: 'WORLD_TASKS_CLOSED' }))
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
        if (Buffer.byteLength(json) > MAX_BYTES) fail('待办存储超过 8MB，请先整理。', 'WORLD_TASKS_LIMIT')
        signal?.throwIfAborted()
        await atomic.writeFileAtomic(target(), json, { mode: 0o600, dirMode: 0o700 })
        seen = true
        return typeof result.value === 'function' ? result.value(state) : result.value
      }, { signal, waitMs: 5000 })
    })
    tail = task.catch(() => {})
    return task
  }
  function current(state, args) {
    const item = state.items.find(item => item.id === identifier(args.id))
    if (!item) fail('待办不存在或已删除，请刷新列表。', 'WORLD_TASKS_NOT_FOUND')
    if (args.expectedRevision !== item.revision) fail('这条待办已在其他位置修改，当前草稿已保留，请重新读取后再保存。', 'WORLD_TASKS_STALE')
    return item
  }
  const counts = state => ({ pending: state.items.filter(item => item.status === 'pending').length,
    doing: state.items.filter(item => item.status === 'doing').length,
    blocked: state.items.filter(item => item.status === 'blocked').length,
    done: state.items.filter(item => item.status === 'done').length,
    active: state.items.filter(item => item.status !== 'done').length })
  return {
    async call(operation, args = {}, signal, actor = 'human') {
      if (closed) fail('待办服务已停止。', 'WORLD_TASKS_CLOSED')
      signal?.throwIfAborted()
      if (['list', 'get'].includes(operation)) {
        await tail
        const state = await load()
        signal?.throwIfAborted()
        if (operation === 'get') {
          const item = state.items.find(item => item.id === identifier(args.id))
          if (!item) fail('待办不存在或已删除。', 'WORLD_TASKS_NOT_FOUND')
          return structuredClone(item)
        }
        if (args.status !== undefined) statusOf(args.status)
        if (args.all !== undefined && typeof args.all !== 'boolean') fail('all 必须是布尔值。')
        const limit = args.limit ?? 200
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('待办分页参数无效。')
        const items = state.items.filter(item => args.status !== undefined ? item.status === args.status : args.all === true || item.status !== 'done')
          .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        return { revision: state.revision, items: items.slice(0, limit).map(summary), total: items.length, counts: counts(state) }
      }
      if (!['write', 'remove', 'clearDone'].includes(operation)) fail('不支持的待办操作。')
      return mutate(state => {
        const timestamp = now()
        if (operation === 'write') {
          if (args.id !== undefined) identifier(args.id)
          if ((args.id !== undefined && args.expectedRevision === undefined)
            || (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0))) fail('指定待办编号时必须提供有效 expectedRevision；新建使用 0。')
          if (args.status !== undefined) statusOf(args.status)
          const title = args.title === undefined ? undefined : text(args.title, '标题', 200, true)
          const note = args.note === undefined ? undefined : text(args.note, '备注', 4000)
          const next = args.next === undefined ? undefined : text(args.next, '下一步', 500)
          let item = args.id ? state.items.find(item => item.id === identifier(args.id)) : undefined
          if (item) {
            item = current(state, args)
            if (title === undefined && note === undefined && next === undefined && args.status === undefined)
              fail('请至少提供标题、备注、下一步或状态中的一项。')
            const same = (value, previous) => value === undefined || value === previous
            if (same(title, item.title) && same(note, item.note) && same(next, item.next)
              && (args.status === undefined || args.status === item.status))
              return { changed: false, value: structuredClone(item) }
            const status = args.status === undefined ? item.status : args.status
            if (status !== 'done' && item.status === 'done' && counts(state).active >= MAX_ACTIVE)
              fail('未完成待办已达上限，请先清理。', 'WORLD_TASKS_LIMIT')
            Object.assign(item, { title: title ?? item.title, note: note ?? item.note, next: next ?? item.next, status,
              doneAt: status === 'done' ? (item.status === 'done' ? item.doneAt : timestamp) : null,
              revision: item.revision + 1, updatedAt: timestamp, updatedBy: actor })
            return { changed: true, value: structuredClone(item) }
          }
          if (args.expectedRevision !== undefined && args.expectedRevision !== 0) fail('待办已不存在，当前草稿已保留。', 'WORLD_TASKS_NOT_FOUND')
          if (title === undefined) fail('新建待办需要标题。')
          if (state.items.length >= MAX_ITEMS) fail('待办已达到上限，请先清理已完成项。', 'WORLD_TASKS_LIMIT')
          const status = args.status ?? 'pending'
          if (status !== 'done' && counts(state).active >= MAX_ACTIVE) fail('未完成待办已达上限，请先清理。', 'WORLD_TASKS_LIMIT')
          item = { id: args.id ? args.id : randomUUID(), title, note: note ?? '', next: next ?? '', status,
            revision: 1, createdAt: timestamp, updatedAt: timestamp, doneAt: status === 'done' ? timestamp : null,
            createdBy: actor, updatedBy: actor }
          state.items.push(item)
          return { changed: true, value: structuredClone(item) }
        }
        if (operation === 'remove') {
          if (args.confirmed !== true) fail('请先确认删除这条待办。')
          const item = current(state, args)
          state.items = state.items.filter(row => row.id !== item.id)
          return { changed: true, value: { removed: 1, id: item.id } }
        }
        if (args.confirmed !== true) fail('请先确认清理已完成待办。')
        if (args.expectedRevision !== state.revision) fail('待办已变化，请刷新后重新确认。', 'WORLD_TASKS_STALE')
        const removedIds = state.items.filter(item => item.status === 'done').map(item => item.id)
        state.items = state.items.filter(item => item.status !== 'done')
        return { changed: removedIds.length > 0, value: { removed: removedIds.length, removedIds } }
      }, signal)
    },
    async dispose() { closed = true; await tail },
  }
}

/** Only the fixed brain may use the assistant task tool; single-item removal stays in the UI. */
export function registerTasksTools(ctx, { tasks, brain }) {
  ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({
    name: 'world_tasks', description: '读写固定助手与用户共用的待办清单。这是「还没做什么」，日记是「发生过什么」。list 默认只返回未结项（doing 优先），可用 status 或 all 查看；add 新建；update 按 expectedRevision 修改标题、备注、下一步或状态。完成一项就改成 done，不要重复建同样的条目，也不要用待办代替真实的验证与交付。删除待办和清理已完成只在界面确认。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'add', 'update'] },
      id: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' }, next: { type: 'string' },
      status: { type: 'string', enum: STATUSES }, expectedRevision: { type: 'integer', minimum: 0 },
      all: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      if (!exec.agent?.session?.id || (await brain.get()).sessionId !== exec.agent.session.id) fail('待办工具只属于 world 的固定助手会话。', 'WORLD_TASKS_SESSION')
      if (!['list', 'add', 'update'].includes(args?.action)) fail('不支持的待办操作。')
      if (args.action === 'list') return tasks.call('list', { status: args.status, all: args.all, limit: args.limit }, exec.signal, 'assistant')
      if (args.action === 'add') {
        const item = await tasks.call('write', { expectedRevision: 0, title: args.title, note: args.note, next: args.next, status: args.status }, exec.signal, 'assistant')
        return item
      }
      return tasks.call('write', { id: args.id, expectedRevision: args.expectedRevision, title: args.title, note: args.note, next: args.next, status: args.status }, exec.signal, 'assistant')
    },
  }), 'world: assistant task tool'))
}
