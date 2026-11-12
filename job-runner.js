/**
 * 「一个子进程 = 一个任务」的公共骨架：本地终端和 SSH 会话都用它。
 *
 * 只有这里知道怎么编号、怎么按字节偏移取增量、怎么在取消 / 超时的时候收掉进程。
 * 两边窗口看到的 poll 语义（偏移、退出码、断线错误）因此不会各说各话——否则一处改了
 * 偏移单位、另一处还在按字符算，慢命令上就会出现重复或丢字的输出。
 *
 * 调用方只负责三件事：把 argv/stdio/env 准备好、给出自己的错误码、提供可选的清理动作
 * （比如删掉临时批处理）。
 */

const DEFAULT_MAX_JOBS = 4
/** 命令结束后还留着的时长，够窗口把最后几段输出读干净。 */
const DEFAULT_KEEP_MS = 5 * 60 * 1000
/** 没有退出迹象的命令到点就收掉，避免一条 `ping -t` 把进程挂到天荒地老。 */
const DEFAULT_MAX_MS = 30 * 60 * 1000

export function createJobRunner({
  spawn, fail,
  maxJobs = DEFAULT_MAX_JOBS,
  keepMs = DEFAULT_KEEP_MS,
  maxMs = DEFAULT_MAX_MS,
  goneCode = 'WORLD_JOB_GONE',
  busyCode = 'WORLD_JOB_BUSY',
  spawnCode = 'WORLD_JOB_SPAWN',
}) {
  const jobs = new Map()

  function forget(id) {
    const job = jobs.get(id)
    if (!job) return
    jobs.delete(id)
    try { job.cleanup?.() } catch { /* 清理失败不该拦住忘记这件事本身 */ }
  }

  function prune() {
    const now = Date.now()
    for (const [id, job] of jobs) {
      const quiet = job.endedAt ? now - job.endedAt > keepMs : now - job.startedAt > maxMs
      if (!quiet) continue
      if (!job.endedAt) job.handle.terminate()
      forget(id)
    }
    // 全是在跑的任务：先挤掉已经结束的，腾不出位置就让调用方拒绝新命令
    if (jobs.size >= maxJobs) {
      for (const [id, job] of jobs) {
        if (job.endedAt) { forget(id); break }
      }
    }
  }

  return {
    get size() { return jobs.size },
    prune,
    full: () => jobs.size >= maxJobs,
    maxJobs,

    /**
     * 起一个任务。`spawn` 收到的就是宿主的 SubprocessSpawnSpec（外加 `code`/`cleanup` 这类
     * 我们自己用的字段，不传给宿主）。
     */
    start(spec) {
      const id = spec.id || `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      let handle
      try {
        handle = spawn({
          argv: spec.argv, cwd: spec.cwd, env: spec.env, signal: spec.signal,
          stdio: spec.stdio, graceMs: spec.graceMs ?? 1500,
        })
      } catch (error) {
        fail(`无法启动命令：${String(error?.message || error)}`, spec.code || spawnCode)
      }
      const job = {
        id, handle, cwd: spec.cwd, line: spec.line || '', argv: spec.argv, meta: spec.meta || null,
        startedAt: Date.now(), offset: 0, endedAt: 0, outcome: null, cancelled: false,
        error: '', killTimer: null, cleanup: spec.cleanup,
      }
      jobs.set(id, job)
      job.killTimer = setTimeout(() => { job.cancelled = true; job.handle.terminate() }, maxMs)
      job.killTimer.unref?.()
      handle.done.then(outcome => {
        job.outcome = outcome
        job.endedAt = Date.now()
        clearTimeout(job.killTimer)
      }, error => {
        job.outcome = { exitCode: null, signal: null }
        job.error = String(error?.message || error)
        job.endedAt = Date.now()
        clearTimeout(job.killTimer)
      })
      return { jobId: id, startedAt: job.startedAt }
    },

    poll(id, offset) {
      const job = jobs.get(id)
      if (!job) return null
      const from = Number.isInteger(offset) && offset >= 0 ? offset : 0
      const read = job.handle.collected.stdout?.readFrom(from)
      return {
        chunk: read?.text ?? '',
        offset: read?.nextOffset ?? from,
        lossy: read?.lossy ?? false,
        running: !job.endedAt,
        exitCode: job.outcome?.exitCode ?? null,
        signal: job.outcome?.signal ?? null,
        cancelled: job.cancelled,
        error: job.error || '',
        durationMs: (job.endedAt || Date.now()) - job.startedAt,
      }
    },

    cancel(id) {
      const job = jobs.get(id)
      if (!job) return false
      job.cancelled = true
      job.handle.terminate()
      return true
    },

    /** poll 失败时调用方要给出自己的错误码，这里只回答「还有没有这个任务」。 */
    require(id) {
      const job = jobs.get(id)
      if (!job) fail('这条命令已经结束并回收了。', goneCode)
      return job
    },

    async dispose() {
      for (const job of jobs.values()) {
        clearTimeout(job.killTimer)
        try { job.handle.terminate() } catch { /* 已经退出 */ }
      }
      await Promise.allSettled([...jobs.values()].map(job => job.handle.waitForExit?.()))
      for (const id of [...jobs.keys()]) forget(id)
    },
  }
}
