/** One World desktop lifetime. No console hooks, persistence, per-write listeners or payload serialization. */
export const LOG_LIMIT = 1000
const apps = { vscode: 'VSCode', terminal: '终端', browser: '浏览器', lanchat: '局域网聊天', settings: '设置', dsh: 'DSH' }
export const appName = id => Object.hasOwn(apps, id) ? apps[id] : typeof id === 'string' && /^plugin:[a-z][a-z0-9-]{0,60}$/.test(id) ? id : 'World'
const owners = { terminal: '终端', ssh: '终端', journal: '日记', tasks: '待办', internet: '网络', storage: '进程管理器', processes: '进程管理器', 'lan-chat': '局域网聊天' }
const quiet = new Set(['poll','versions','probe','ready','connection','snapshot','status','update'])
const methodPattern = /^(world-[a-z0-9-]+|pbnpm(?:-pbd)?-project)\/([a-z][a-z0-9-]*)$/
export function createDebugLog() {
  const ring = new Array(LOG_LIMIT), pending = new Map()
  let count = 0, sequence = 0, skipped = 0
  const trace = () => ++sequence
  // Callers supply static labels / method names / numbers only. Don't pass errors, argv or request bodies.
  function add(id, from, to, event, level = 'info', ms = null, time = Date.now()) {
    const n = ++count
    ring[(n-1) % LOG_LIMIT] = { n, id, time, from, to, event, level, ms }
  }
  function snapshot() {
    const rows = [], first = Math.max(0, count - LOG_LIMIT)
    for (let i = count - 1; i >= first; --i) rows.push(ring[i % LOG_LIMIT])
    return { count, skipped, rows }
  }
  // PB status is already polled by the editor. Consume each fixed-size worker fact once,
  // never its output. The viewer can catch up a closed editor's job using the existing guarded RPC.
  function observe(job, rec) {
    const d = job?.diagnostics
    if (!d || d.id !== rec.jobId) return
    const emit = (key, to, event, level = 'info', ms = null) => {
      if (rec[key]) return
      rec[key] = true; add(rec.id, 'PB', to, event, level, ms)
    }
    if (d.spawned) emit('spawn', 'worker', '启动 PB worker')
    const temp = { system: '默认临时目录可用', private: '使用任务专用临时目录', unavailable: '没有可写临时目录' }
    if (Object.hasOwn(temp, d.temp)) emit('temp', 'TEMP', temp[d.temp], d.temp === 'unavailable' ? 'error' : 'info')
    if (!job.running) {
      const code = Number.isInteger(d.exitCode) ? ` · 退出码 ${d.exitCode}` : ''
      emit('end', 'World', (job.error ? '任务失败' : '任务结束') + code, job.error ? 'error' : 'info', d.elapsedMs)
      pending.delete(rec.jobId)
    }
  }
  function watch(job, id, payload, rpc) {
    if (!job?.diagnostics?.id) return // older host
    const rec = { id, jobId: job.diagnostics.id, rpc, target: {root: payload.root, sessionId: payload.sessionId}, last: Date.now() }
    if (pending.size >= 4) pending.delete(pending.keys().next().value) // host admits at most four jobs
    pending.set(rec.jobId, rec); observe(job, rec)
  }
  function status(job) {
    const rec = pending.get(job?.diagnostics?.id)
    if (rec) { rec.last = Date.now(); observe(job, rec) }
  }
  function catchUp(signal) {
    for (const rec of pending.values()) {
      if (rec.busy || Date.now()-rec.last < 3000) continue
      rec.last = Date.now(); rec.busy = true
      void Promise.resolve().then(() => rec.rpc.call('/api', 'world-vscode-pb/status', rec.target, signal)).then(r => {
        if (signal.aborted || !pending.has(rec.jobId)) return
        if (r?.ok && r.value?.diagnostics?.id === rec.jobId) observe(r.value, rec)
        else { add(rec.id,'PB','World','任务状态已不可用','warn'); pending.delete(rec.jobId) }
      }).catch(() => {}).finally(() => { rec.busy = false })
    }
  }
  function wrap(rpc, caller) {
    if (!rpc?.call) return rpc
    const terminalJobs = new Map() // correlate run/poll without retaining command lines or output
    return { async call(base, method, payload, signal) {
      const match = base === '/api' && typeof method === 'string' && method.length < 96 && methodPattern.exec(method)
      if (!match) return rpc.call(base, method, payload, signal)
      const [, service, op] = match, pb = service === 'world-vscode-pb', start = pb && (op === 'run' || op === 'build')
      const from = caller || (service.startsWith('world-vscode-') ? 'VSCode' : owners[service.slice(6)] || 'World')
      const terminal = service === 'world-terminal'
      const launchesJob = terminal && (op === 'run' || op === 'pbtest')
      const id = (terminal && terminalJobs.get(payload?.jobId)) || (start || launchesJob ? trace() : 0)
      const then = performance.now()
      if (start) add(id, from, 'PB', op === 'run' ? '运行项目（F5）' : '打包 EXE')
      const end = (level, suffix) => add(id || trace(), from, service, op + suffix, level, Math.round(performance.now()-then))
      try {
        const r = await rpc.call(base, method, payload, signal)
        if (r?.ok === false) end('error', ' · 请求失败' + safeCode(r.error?.code))
        else {
          if (launchesJob && typeof r?.value?.jobId === 'string') {
            if (terminalJobs.size >= 64) terminalJobs.delete(terminalJobs.keys().next().value)
            terminalJobs.set(r.value.jobId, id)
          }
          if (terminal && op === 'poll' && id && r?.value?.running === false) {
            const v = r.value, failed = Boolean(v.error || v.signal || v.exitCode)
            add(id, service, from, '进程结束' + (Number.isInteger(v.exitCode) ? ` · 退出码 ${v.exitCode}` : ''),
              v.cancelled ? 'warn' : failed ? 'error' : 'info', Number.isFinite(v.durationMs) ? v.durationMs : null)
            terminalJobs.delete(payload.jobId)
          } else if (quiet.has(op)) ++skipped
          else end('info', op === 'pbtest' && launchesJob ? ' · 已启动' : ' · 完成')
          if (start) watch(r?.value, id, payload, rpc)
          else if (pb && op === 'status') status(r?.value)
        }
        return r
      } catch (error) { end(signal?.aborted ? 'warn' : 'error', signal?.aborted ? ' · 已取消' : ' · 传输失败'); throw error }
    } }
  }
  return { trace, add, snapshot, wrap, catchUp, get count() { return count }, get skipped() { return skipped } }
}
function safeCode(code) { return typeof code === 'string' && /^(WORLD|FS|SANDBOX|SUBPROCESS)_[A-Z_]{1,54}$/.test(code) ? ` (${code})` : '' }
export function traceText(rows, id) {
  return rows.filter(r => r.id === id).reverse().map(r => `${new Date(r.time).toISOString()} #${r.id} ${r.level} ${r.from} → ${r.to} ${r.event}${r.ms == null ? '' : ` (${r.ms} ms)`}`).join('\n')
}
