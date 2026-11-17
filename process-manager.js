import { spawn } from 'node:child_process'
import { stat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { win32, posix } from 'node:path'
import { createUnixProcessCollector } from './process-manager-unix.js'

const fail = (message, code = 'WORLD_PROCESSES') => { throw Object.assign(new Error(message), { code }) }
const identity = row => `${row.pid}:${row.startedAt}`
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const pidOf = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff

/** Membership comes from parent links and creation times, never from executable names. */
export function dshProcessTree(rows, rootPid, rootStartedAt) {
  const byPid = new Map((Array.isArray(rows) ? rows : []).filter(row => pidOf(row?.pid)).map(row => [row.pid, row]))
  const root = byPid.get(rootPid)
  if (!root || !root.startedAt || rootStartedAt && root.startedAt !== rootStartedAt) return []
  const selected = new Map([[rootPid, root]])
  let changed = true
  while (changed) {
    changed = false
    for (const row of byPid.values()) {
      const parent = selected.get(row.parentPid)
      // Windows may recycle a parent PID after the original parent exits.
      if (!selected.has(row.pid) && parent && row.startedAt && row.startedAt >= parent.startedAt) {
        selected.set(row.pid, row); changed = true
      }
    }
  }
  return [...selected.values()]
}

/** Read-only Windows collector. Each request is bounded and all helpers die with the service. */
export function createProcessCollector({ spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  const helper = fileURLToPath(new URL('./process-manager.ps1', import.meta.url))
  const children = new Set()
  let disposed = false
  return {
    collect(operation, { rootPid, path }, signal) {
      if (disposed) return Promise.reject(new Error('进程管理器已关闭。'))
      signal?.throwIfAborted()
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
        '-RootProcessId', String(rootPid), '-Mode', operation === 'files' ? 'Files' : operation === 'ports' ? 'Ports' : 'Snapshot']
      // User paths are data, never PowerShell code or positional command switches.
      if (path) args.push('-TargetFileBase64', Buffer.from(path, 'utf8').toString('base64'))
      return new Promise((resolve, reject) => {
        let child, output = '', errorOutput = '', settled = false
        const finish = (error, value) => {
          if (settled) return
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
          children.delete(child)
          if (error) { try { child?.kill() } catch {} reject(error) } else resolve(value)
        }
        const abort = () => finish(signal?.reason || new Error('查询已取消。'))
        const timer = setTimeout(() => finish(new Error('读取 DSH 进程超时，请重试。')), timeoutMs)
        try {
          child = spawnProcess('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
          children.add(child)
          child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
          child.stdout.on('data', chunk => {
            output += chunk
            if (output.length > 4 * 1024 * 1024) finish(new Error('进程信息过多，读取已停止。'))
          })
          child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-4000) })
          child.once('error', error => finish(error))
          child.once('close', code => {
            try {
              const result = JSON.parse(output.replace(/^\uFEFF/u, '').trim())
              if (result.error) finish(new Error(result.error))
              else if (code !== 0) finish(new Error(errorOutput.trim() || `读取进程失败（${code}）。`))
              else finish(null, result)
            } catch { finish(new Error(errorOutput.trim() || (code !== 0 ? `读取进程失败（${code}）。` : '无法解析 DSH 进程信息。'))) }
          })
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        } catch (error) { finish(error) }
      })
    },
    dispose() { disposed = true; for (const child of children) child.kill(); children.clear() },
  }
}

export function createWorldProcesses({ platform = process.platform,
  rootPid = process.versions.electron ? process.ppid : process.pid,
  collector = platform === 'win32' ? createProcessCollector() : createUnixProcessCollector({ platform, selectTree: dshProcessTree }),
  inspectFile = stat, resolveFile = realpath,
} = {}) {
  const lifetime = new AbortController()
  let rootStartedAt, previous = new Map(), previousTime = 0, inFlight, portsInFlight
  function supported() {
    if (!['win32', 'linux', 'darwin'].includes(platform)) fail('进程管理器支持 Windows、Linux 和 macOS。', 'WORLD_PROCESSES_UNSUPPORTED')
    if (!pidOf(rootPid)) fail('无法确定当前 DSH 主进程。')
  }
  function scope(raw) {
    const rows = dshProcessTree(raw.rows, rootPid, rootStartedAt)
    if (!rows.length) fail('当前 DSH 主进程已退出或不可读取，请重新打开进程管理器。')
    rootStartedAt ||= rows[0].startedAt
    return rows
  }
  async function snapshot() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const raw = await collector.collect('snapshot', { rootPid }, lifetime.signal)
      const scoped = scope(raw)
      const time = Number(raw.timestamp), cores = Math.max(1, Number(raw.cores) || 1)
      const elapsed = time - previousTime, next = new Map()
      const rows = scoped.map(row => {
        const cpuMs = number(row.cpuMs), before = previous.get(identity(row))
        const cpu = cpuMs !== null && before !== undefined && elapsed > 0 && cpuMs >= before
          ? Math.min(100, (cpuMs - before) / elapsed / cores * 100) : null
        if (cpuMs !== null) next.set(identity(row), cpuMs)
        return { pid: row.pid, parentPid: row.parentPid, startedAt: row.startedAt,
          name: String(row.name || '未知进程'), path: String(row.path || ''),
          role: row.pid === rootPid ? 'DSH 主进程' : row.pid === process.pid ? 'world 宿主' : 'DSH 子进程',
          cpu, workingSet: number(row.workingSet), privateBytes: number(row.privateBytes),
          handles: number(row.handles), threads: number(row.threads) }
      })
      previous = next; previousTime = time
      return { rootPid, timestamp: time, cores, platform, rows, totals: {
        cpu: rows.some(row => row.cpu !== null) ? rows.reduce((sum, row) => sum + (row.cpu || 0), 0) : null,
        workingSet: rows.reduce((sum, row) => sum + (row.workingSet || 0), 0),
        privateBytes: rows.some(row => row.privateBytes !== null) ? rows.reduce((sum, row) => sum + (row.privateBytes || 0), 0) : null, count: rows.length,
      } }
    })().finally(() => { inFlight = null })
    return inFlight
  }
  return {
    async call(operation, payload = {}, signal) {
      supported(); lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
      if (operation === 'snapshot') return snapshot()
      if (operation === 'ports') {
        if (portsInFlight) return portsInFlight
        portsInFlight = (async () => {
          const raw = await collector.collect('ports', { rootPid }, lifetime.signal)
          lifetime.signal.throwIfAborted()
          const allowed = new Map(scope(raw).map(row => [identity(row), row])), seen = new Set()
          const rows = (Array.isArray(raw.ports) ? raw.ports : []).flatMap(port => {
            const owner = allowed.get(identity(port))
            if (!owner || !['TCP', 'UDP'].includes(port.protocol) || !Number.isInteger(port.localPort)
              || port.localPort < 0 || port.localPort > 65535 || !Number.isInteger(port.remotePort)
              || port.remotePort < 0 || port.remotePort > 65535) return []
            const key = JSON.stringify([identity(port), port.protocol, port.localAddress, port.localPort, port.remoteAddress, port.remotePort])
            if (seen.has(key)) return []
            seen.add(key)
            return [{ pid: owner.pid, startedAt: owner.startedAt, name: String(owner.name || '未知进程'),
              protocol: port.protocol, localAddress: String(port.localAddress || ''), localPort: port.localPort,
              remoteAddress: String(port.remoteAddress || ''), remotePort: port.remotePort, state: String(port.state || '') }]
          }).sort((a, b) => a.localPort - b.localPort || a.pid - b.pid || a.protocol.localeCompare(b.protocol))
          return { rootPid, timestamp: raw.timestamp, platform, rows }
        })().finally(() => { portsInFlight = null })
        return portsInFlight
      }
      if (operation !== 'files') fail('不支持的进程管理操作。')
      if (typeof payload.path !== 'string' || !(platform === 'win32' ? win32 : posix).isAbsolute(payload.path.trim()) || payload.path.length > 32767 || /[\x00-\x1f]/u.test(payload.path))
        fail('请输入完整的文件路径。', 'WORLD_PROCESSES_PATH')
      let path
      try {
        path = await resolveFile(payload.path.trim())
        if (!(await inspectFile(path)).isFile()) fail('请选择文件，暂不支持查询整个文件夹。', 'WORLD_PROCESSES_PATH')
      } catch (error) {
        if (error.code === 'WORLD_PROCESSES_PATH') throw error
        fail('文件不存在或无法访问，请检查完整路径。', 'WORLD_PROCESSES_PATH')
      }
      const active = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
      const raw = await collector.collect('files', { rootPid, path }, active)
      active.throwIfAborted()
      const rows = scope(raw), allowed = new Map(rows.map(row => [identity(row), row]))
      const owners = (Array.isArray(raw.owners) ? raw.owners : []).filter(row => allowed.has(identity(row)))
        .map(row => ({ pid: row.pid, startedAt: row.startedAt, name: String(allowed.get(identity(row)).name || '') }))
      return { path, rootPid, owners, timestamp: raw.timestamp }
    },
    dispose() { lifetime.abort(); collector.dispose() },
  }
}
