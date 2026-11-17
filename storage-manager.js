import { lstat, realpath, opendir, unlink, access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DAY = 86400000
const fail = (message, code = 'WORLD_STORAGE') => { throw Object.assign(new Error(message), { code }) }
const within = (root, target, paths = path) => {
  const relative = paths.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative))
}
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':')
const RULES = [
  { id: 'images', label: '附件图片缓存', kind: 'home', prefix: 'cache/attachments/request-images/', note: '图片的派生版本，需要时可重新生成。' },
  { id: 'temporary', label: '附件临时文件', kind: 'home', prefix: 'attachments/v1/tmp/', note: '未完成写入留下的临时文件，保留最近 7 天。' },
  { id: 'logs', label: 'DSH 旧日志', kind: 'home', prefix: 'logs/', note: '清理后无法查看这些旧诊断记录。', logs: true },
  { id: 'desktop-logs', label: '桌面旧日志', kind: 'desktop', prefix: 'logs/', note: '清理后无法查看这些旧诊断记录。', logs: true },
]

/** Server-owned paths only. Never treat a Node binary directory or the whole home as DSH. */
export function storageRootCandidates({ platform = process.platform, env = process.env, home = homedir(),
  executable = process.execPath, electron = Boolean(process.versions.electron) } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const userBase = platform === 'win32' ? env.APPDATA || paths.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || paths.join(home, '.config')
  const candidates = [
    { id: 'home', kind: 'home', group: 'user', label: 'DSH 用户数据', path: env.DSH_HOME || paths.join(home, '.dsh') },
    { id: 'desktop', kind: 'desktop', group: 'user', label: '桌面用户数据', path: paths.join(userBase, '@deepseek-ai', 'dsh-desktop') },
  ]
  if (electron || env.DSH_DESKTOP_NODE_EXECUTABLE) {
    const exe = env.DSH_DESKTOP_NODE_EXECUTABLE || executable
    if (platform === 'linux' && env.APPIMAGE && paths.isAbsolute(env.APPIMAGE))
      candidates.unshift({ id: 'install', kind: 'install', group: 'install', label: 'DSH AppImage', path: env.APPIMAGE, file: true })
    else {
      const directory = platform === 'darwin' && /\.app\/Contents\/MacOS\//u.test(exe)
        ? exe.slice(0, exe.indexOf('.app/Contents/MacOS/') + 4) : paths.dirname(exe)
      candidates.unshift({ id: 'install', kind: 'install', group: 'install', label: 'DSH 安装目录', path: directory,
        marker: platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar' })
    }
  }
  return candidates.filter(item => paths.isAbsolute(item.path) && paths.resolve(item.path) !== paths.parse(item.path).root
    && paths.resolve(item.path) !== paths.resolve(home)).map(item => ({ ...item, path: paths.resolve(item.path) }))
}

/** Resolve a packaged executable before selecting its directory (Linux launchers are often symlinks). */
export async function discoverStorageRoots() {
  const executable = await realpath(process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath).catch(() => process.execPath)
  const roots = storageRootCandidates({ executable, env: { ...process.env,
    ...(process.env.DSH_DESKTOP_NODE_EXECUTABLE ? { DSH_DESKTOP_NODE_EXECUTABLE: executable } : {}) } })
  if (!roots.some(root => root.kind === 'install') && process.argv[1]) {
    let directory = path.dirname(await realpath(process.argv[1]).catch(() => process.argv[1]))
    for (let depth = 0; depth < 6 && path.isAbsolute(directory) && directory !== path.dirname(directory); depth++) {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
        if (manifest.name === '@deepseek-ai/dsh') {
          roots.unshift({ id: 'install', kind: 'install', group: 'install', label: 'DSH CLI 安装目录', path: directory, marker: 'package.json' })
          break
        }
      } catch {}
      directory = path.dirname(directory)
    }
  }
  return roots
}

function cleanupRule(root, relative, stat, now) {
  if (!stat.isFile() || stat.nlink !== 1 || Math.max(stat.mtimeMs, stat.atimeMs) > now - 7 * DAY) return null
  const name = relative.split(path.sep).join('/')
  return RULES.find(rule => root.kind === rule.kind && name.startsWith(rule.prefix)
    && (!rule.logs || /\.(?:log|txt|json)$/iu.test(name)))?.id || null
}

/** Bounded, cancellable inventory; cleanup only unlinks individually revalidated whitelist files. */
export function createWorldStorage({ roots = discoverStorageRoots, now = Date.now,
  maxEntries = 200000, maxScanMs = 120000, removeFile = unlink } = {}) {
  let job, inventory, disposed = false
  const previews = new Map()
  const stopped = current => disposed || current.cancelled
  const currentScan = id => {
    if (!inventory || inventory.id !== id || job?.state === 'running') fail('统计已更新或正在执行，请重新扫描。', 'WORLD_STORAGE_STALE')
    return inventory
  }
  async function validateRoot(root) {
    const stat = await lstat(root.path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !(root.file && stat.isFile()))) fail('目录是链接或类型已改变。')
    const canonical = await realpath(root.path)
    if (canonical !== root.canonical || `${stat.dev}:${stat.ino}` !== root.identity) fail('DSH 目录已改变，请重新扫描。')
  }
  async function validateFile(root, entry) {
    await validateRoot(root)
    const relative = path.relative(root.path, entry.path)
    if (!relative || !within(root.path, entry.path)) fail('文件不在允许的清理目录内。')
    let cursor = root.path
    const parts = relative.split(path.sep)
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index])
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail('文件路径包含链接或已改变。')
    }
    if (await realpath(entry.path) !== path.join(root.canonical, relative)) fail('文件已移出 DSH 目录。')
    const stat = await lstat(entry.path)
    if (signature(stat) !== entry.signature || cleanupRule(root, relative, stat, now()) !== entry.ruleId)
      fail('文件已变化或正在使用，已跳过。')
    return stat
  }
  async function scan(current) {
    const data = { id: current.id, timestamp: now(), roots: [], entries: new Map(), rules: RULES.map(rule => ({ ...rule, count: 0, bytes: 0 })),
      totals: { install: 0, user: 0, reclaimable: 0, files: 0 }, warnings: [], partial: false }
    const seen = new Set(), canonicalRoots = [], started = now()
    const warning = message => { if (data.warnings.length < 30) data.warnings.push(message) }
    const candidates = await roots()
    if (!candidates.some(root => root.kind === 'install')) warning('未能识别当前 DSH 安装目录；安装占用未计入。')
    for (const candidate of candidates) {
      if (stopped(current)) break
      const root = { ...candidate, bytes: 0, files: 0, state: 'scanning', skipped: 0 }
      data.roots.push(root)
      try {
        const stat = await lstat(root.path)
        if (stat.isSymbolicLink()) throw new Error('根目录是符号链接，未向外统计。')
        if (!stat.isDirectory() && !(root.file && stat.isFile())) throw new Error('目录类型不匹配。')
        if (root.marker) await access(path.join(root.path, root.marker))
        root.canonical = await realpath(root.path); root.identity = `${stat.dev}:${stat.ino}`
        if (root.kind === 'home' && (root.canonical === await realpath(homedir()).catch(() => homedir()) || root.canonical === path.parse(root.canonical).root))
          throw new Error('拒绝把整个用户目录或磁盘根目录视为 DSH 数据。')
        if (canonicalRoots.some(other => within(other, root.canonical) || within(root.canonical, other))) {
          root.state = 'overlap'; warning(`${root.label} 与已统计目录重叠，未重复计算。`); continue
        }
        canonicalRoots.push(root.canonical)
        const stack = [{ path: root.path, parent: null }]
        while (stack.length && !stopped(current)) {
          if (data.entries.size >= maxEntries || now() - started > maxScanMs) {
            data.partial = true; warning('已达到扫描上限，当前显示部分统计。'); break
          }
          const next = stack.pop()
          current.path = next.path; current.visited = data.entries.size
          try {
            const info = await lstat(next.path)
            if (info.isSymbolicLink()) { root.skipped++; continue }
            const canonical = await realpath(next.path)
            if (!within(root.canonical, canonical)) { root.skipped++; continue }
            const relative = path.relative(root.path, next.path)
            const entry = { id: `${root.id}:${relative}`, rootId: root.id, path: next.path, relative, parent: next.parent,
              name: relative ? path.basename(next.path) : root.label, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
              bytes: 0, size: info.isFile() ? info.size : 0, files: 0, modified: info.mtimeMs, signature: signature(info), ruleId: null }
            if (entry.type === 'other') { root.skipped++; continue }
            data.entries.set(entry.id, entry)
            if (entry.type === 'directory') {
              const directory = await opendir(next.path)
              for await (const child of directory) {
                if (stopped(current)) break
                if (child.isSymbolicLink()) { root.skipped++; continue }
                if (stack.length + data.entries.size >= maxEntries) { data.partial = true; warning('文件数量超过扫描上限。'); break }
                stack.push({ path: path.join(next.path, child.name), parent: entry.id })
              }
            } else {
              const key = info.ino ? `${info.dev}:${info.ino}` : canonical
              entry.duplicate = seen.has(key); seen.add(key)
              entry.bytes = entry.duplicate ? 0 : info.size; entry.files = entry.duplicate ? 0 : 1
              entry.ruleId = cleanupRule(root, relative, info, now())
              root.bytes += entry.bytes; root.files += entry.files
              if (entry.ruleId && !entry.duplicate) {
                const rule = data.rules.find(item => item.id === entry.ruleId); rule.count++; rule.bytes += entry.bytes
              }
              let parent = data.entries.get(entry.parent)
              while (parent) { parent.bytes += entry.bytes; parent.files += entry.files; parent = data.entries.get(parent.parent) }
            }
          } catch (error) { root.skipped++; data.partial = true; warning(`${next.path}：${error.code || error.message}`) }
        }
        if (root.skipped) warning(`${root.label}：跳过 ${root.skipped} 个链接或无法读取的项目。`)
        root.state = stopped(current) ? 'cancelled' : data.partial ? 'partial' : 'ready'
        data.totals[root.group] += root.bytes; data.totals.files += root.files
      } catch (error) {
        root.state = error.code === 'ENOENT' ? 'missing' : 'error'
        root.error = error.code === 'ENOENT' ? '未找到此目录' : error.message
        if (root.state === 'error') { data.partial = true; warning(`${root.label}：${root.error}`) }
      }
    }
    data.totals.reclaimable = data.rules.reduce((sum, rule) => sum + rule.bytes, 0)
    for (const group of ['install', 'user']) if (!data.roots.some(root => root.group === group && ['ready', 'partial', 'cancelled'].includes(root.state))) data.totals[group] = null
    if (stopped(current)) data.partial = true
    inventory = data; previews.clear()
    return summary(data)
  }
  const summary = data => ({ scanId: data.id, timestamp: data.timestamp, roots: data.roots.map(({ canonical, identity, marker, ...root }) => root),
    totals: data.totals, rules: data.rules.map(({ prefix, kind, logs, ...rule }) => rule), warnings: data.warnings, partial: data.partial })
  async function preview(payload) {
    const data = currentScan(payload.scanId)
    if (!Array.isArray(payload.ruleIds) || !payload.ruleIds.length || payload.ruleIds.some(id => !RULES.some(rule => rule.id === id))) fail('请选择可清理的类别。')
    const entries = [...data.entries.values()].filter(entry => entry.ruleId && payload.ruleIds.includes(entry.ruleId) && !entry.duplicate)
    if (!entries.length) fail('没有符合条件的文件，请重新扫描。')
    const token = randomUUID(), bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    // A bounded preview cache prevents unattended clients retaining arbitrary inventories.
    for (const [id, value] of previews) if (now() - value.created > 5 * 60000) previews.delete(id)
    if (previews.size >= 8) previews.delete(previews.keys().next().value)
    previews.set(token, { created: now(), scanId: data.id, entries, roots: data.roots })
    return { token, count: entries.length, bytes, categories: data.rules.filter(rule => payload.ruleIds.includes(rule.id)).map(rule => rule.label) }
  }
  async function clean(current, plan) {
    const result = { removed: 0, bytes: 0, skipped: 0, failures: [] }
    for (const entry of plan.entries) {
      if (stopped(current)) break
      current.path = entry.path; current.total = plan.entries.length
      try {
        const root = plan.roots.find(root => root.id === entry.rootId)
        await validateFile(root, entry)
        if (stopped(current)) break
        await removeFile(entry.path)
        result.removed++; result.bytes += entry.bytes
      } catch (error) {
        result.skipped++
        if (result.failures.length < 30) result.failures.push({ path: entry.path, reason: error.code || error.message })
      }
      current.visited = result.removed + result.skipped
      current.result = { ...result }
    }
    inventory = null; previews.clear()
    return { ...result, cancelled: stopped(current) }
  }
  return {
    async call(operation, payload = {}) {
      if (disposed) fail('存储管理器已关闭。')
      if (operation === 'start') {
        if (job?.state === 'running') fail('已有扫描或清理正在执行。', 'WORLD_STORAGE_BUSY')
        const mode = payload.mode || 'scan'
        if (!['scan', 'cleanup'].includes(mode)) fail('未知存储操作。')
        let plan
        if (mode === 'cleanup') {
          plan = previews.get(payload.token)
          if (payload.confirmed !== true || !plan || now() - plan.created > 5 * 60000 || inventory?.id !== plan.scanId)
            fail('清理预览已失效，请重新预览并确认。', 'WORLD_STORAGE_STALE')
          previews.delete(payload.token)
        }
        const current = job = { id: randomUUID(), mode, state: 'running', visited: 0, path: '', cancelled: false }
        void (mode === 'scan' ? scan(current) : clean(current, plan)).then(result => {
          current.result = result; current.state = current.cancelled ? 'cancelled' : 'done'
        }).catch(error => { current.error = error.message; current.state = 'error' })
        return { jobId: current.id }
      }
      if (operation === 'status' || operation === 'cancel') {
        if (operation === 'status' && !payload.jobId) return job ? structuredClone(job) : { state: 'idle' }
        if (!job || job.id !== payload.jobId) fail('任务已失效，请重新扫描。', 'WORLD_STORAGE_STALE')
        if (operation === 'cancel') job.cancelled = true
        return structuredClone(job)
      }
      if (operation === 'preview') return preview(payload)
      if (operation === 'list') {
        const data = currentScan(payload.scanId), root = data.roots.find(item => item.id === payload.rootId)
        if (!root) fail('请选择 DSH 目录。')
        const parent = data.entries.get(payload.parentId || `${root.id}:`)
        if (!parent || parent.rootId !== root.id) return { items: [], total: 0, parent: null }
        const query = String(payload.query || '').toLocaleLowerCase().slice(0, 200)
        const rows = [...data.entries.values()].filter(entry => entry.rootId === root.id && (parent.type === 'file' ? entry.id === parent.id : query
          ? entry.relative && within(parent.path, entry.path) && entry.id !== parent.id && entry.relative.toLocaleLowerCase().includes(query) : entry.parent === parent.id))
          .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
        const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0
        const items = rows.slice(offset, offset + 100).map(({ signature, ...entry }) => entry)
        return { items, total: rows.length, offset, parent: { id: parent.id, parentId: parent.parent, path: parent.path } }
      }
      fail('不支持的存储操作。')
    },
    dispose() { disposed = true; if (job) job.cancelled = true; previews.clear() },
  }
}
