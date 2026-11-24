/** Only registered PB mounts are executable. Never take a target, command or PB version from the client. */
import { existsSync, statSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

export function pbPythonRuntime() {
  for (const name of ['dsh-pbnpm-pbd', 'pbnpm-pbd']) {
    const python = resolve(import.meta.dirname, '..', name, 'python34_full', 'python.exe')
    if (existsSync(python)) return python
  }
  throw new Error('缺少 PB 运行环境，请安装带 x86 Python 的 pbnpm-pbd 插件。')
}

function asset(input, extension, project) {
  if (!input) return ''
  const path = resolve(dirname(project), input)
  if (extname(path).toLowerCase() !== extension || !statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`未找到 ${extension} 文件：${path}`)
  return path
}

// The installed x86 python.exe can inherit a Low mandatory label. Normal NTFS write
// permissions on %TEMP% are then insufficient even when the host can write there.
async function withWindowsRunTemp(roots, fullAccess, launch) {
  const local = process.env.LOCALAPPDATA
  if (fullAccess && local && isAbsolute(local)) {
    const low = resolve(local, '..', 'LocalLow')
    return launch([join(low, 'Temp'), low, ...roots])
  }
  let scratch
  try {
    const parent = realpathSync.native(tmpdir())
    // Only provision in the platform temp root itself, if granted. Never relabel
    // an existing directory, the workspace, the interpreter or any project file.
    if (roots.some(root => {
      try { return isAbsolute(root) && relative(realpathSync.native(root), parent) === '' }
      catch { return false }
    })) scratch = await mkdtemp(join(parent, 'world-pb-run-'))
  } catch { /* Worker can still try its ordinary roots. */ }
  if (!scratch) return launch(roots)
  try {
    let labeled = false
    try {
      await promisify(execFile)(join(process.env.SystemRoot, 'System32', 'icacls.exe'),
        [scratch, '/setintegritylevel', '(OI)(CI)L', '/L'], { windowsHide: true, timeout: 5000 })
      labeled = true
    } catch { /* No elevation and no wider grant if labeling is unavailable. */ }
    return await launch(labeled ? [scratch, ...roots] : roots)
  } finally {
    // Only clean the physical job folder we created, never a redirected path.
    if (existsSync(scratch) && relative(scratch, realpathSync.native(scratch)) === '') {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}

export function createPbActions(ctx, { roots, sessionOf, writableRoots, python = pbPythonRuntime }) {
  const jobs = new Map(), lifetime = new AbortController()
  // Only the worker preamble is diagnostic metadata. Never expose arbitrary output to the timeline.
  const tempHeader = /^WORLD_PB_TEMP:(system|private|unavailable)\r?\n/
  function readTemp(job) {
    if (!job.reader || job.diagnostics.temp) return
    const chunk = job.reader.readFrom(0)
    if (!chunk.lossy) job.diagnostics.temp = tempHeader.exec(chunk.text)?.[1] || null
    if (chunk.lossy || job.diagnostics.temp || chunk.text.length >= 32) delete job.reader
  }
  function snapshot(job) {
    if (!job) return null
    readTemp(job)
    return { action: job.action, running: job.running, error: job.error, output: job.output, diagnostics: { ...job.diagnostics } }
  }
  return {
    async call(op, payload, signal) {
      const { root, sessionId } = payload
      if (!sessionId || typeof root !== 'string' || !isAbsolute(root)) throw new Error('没有选中 PB 工程。')
      const key = JSON.stringify([sessionId, resolve(root).toLowerCase()])
      if (op === 'status') {
        if (!jobs.has(key)) return null
        await sessionOf(payload, signal, 'WORLD_PB_SESSION', true)
        return snapshot(jobs.get(key))
      }
      if (!['run', 'build'].includes(op)) throw new Error('未知工程操作。')
      const session = await sessionOf(payload, signal, 'WORLD_PB_SESSION')
      const policy = ctx.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only') throw new Error('只读会话不能运行或打包工程。')
      const project = await roots.project(root, signal)
      if (!project) throw new Error('工程未登记或已移除，请重新打开工程。')
      const target = project.pbtPath, version = project.pbVersion
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('请先设置此工程的 PBVM 版本。')
      const args = [op, target, String(version)]
      if (op === 'run' && version === 80 && project.kind === 'pbt') {
        // Split PB8 projects need private run files next to the PBT, never outside writable roots.
        let writable = policy.mode === 'danger-full-access'
        if (policy.mode === 'workspace-write') {
          const dir = await ctx.fs.resolve(realpathSync(dirname(target)), { signal })
          const allowed = await Promise.all(writableRoots(policy).map(p => ctx.fs.resolve(p, { signal })))
          writable = allowed.some(p => ctx.fs.contains(p, dir))
        }
        if (writable) args.push('--allow-local-run-files')
      }
      let output = ''
      if (op === 'build') {
        if (project.kind !== 'pbt') throw new Error('二进制工程请先还原为 PBT/PBL 再打包。')
        if (!['embedded', 'external'].includes(payload.mode)) throw new Error('无效的 PBD 模式。')
        if (!payload.directory || !isAbsolute(payload.directory)) throw new Error('请选择新输出目录的绝对路径。')
        const dest = resolve(payload.directory)
        if (existsSync(dest)) throw new Error('输出目录已存在，请指定一个新目录，不会覆盖已有程序。')
        const parent = realpathSync(dirname(dest)), directory = join(parent, basename(dest))
        if (policy.mode === 'workspace-write') {
          const allowed = await Promise.all(writableRoots(policy).map(p => ctx.fs.resolve(p, { signal })))
          const dir = await ctx.fs.resolve(parent, { signal })
          if (!allowed.some(p => ctx.fs.contains(p, dir))) throw new Error('输出目录不在会话可写范围内。')
        }
        args.push(directory, payload.mode, asset(payload.icon, '.ico', target), asset(payload.pbr, '.pbr', target))
        output = join(directory, basename(target, extname(target)) + '.exe')
      }
      // Check after the last await; two windows cannot race the same PBL/project.
      const busy = [...jobs.values()].filter(job => job.running)
      if (busy.some(job => job.target.toLowerCase() === target.toLowerCase())) throw new Error('该工程已有任务在运行。')
      if (busy.length >= 4) throw new Error('PB 运行任务过多，请先关闭一个程序。')
      if (jobs.size >= 64 && !jobs.has(key)) {
        const oldest = [...jobs].find(([, job]) => !job.running)
        if (oldest) jobs.delete(oldest[0])
      }
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
      const subprocess = ctx.get('subprocess')
      if (!subprocess) throw new Error('宿主未提供进程服务。')
      // Python 3.4 probes TEMP during cli import. A confined child may not have the
      // same writable directories as the desktop. Never accept fallback roots from the UI.
      const tempRoots = policy.mode === 'workspace-write' ? writableRoots(policy)
        : policy.mode === 'danger-full-access' ? [process.env.LOCALAPPDATA, dirname(target)] : []
      const began = Date.now()
      const job = { action: op, target, running: true, error: '', output, diagnostics: { id: randomUUID(), spawned: false, temp: null } }
      const launch = async roots => {
        lifetime.signal.throwIfAborted()
        const tempArgs = roots.filter(dir => dir && isAbsolute(dir)).flatMap(dir => ['--temp-root', dir])
        const handle = subprocess.spawn({ argv: [python(), '-I', '-B', '-u', join(import.meta.dirname, 'pb-project.py'), ...tempArgs, ...args],
          cwd: dirname(target), signal: lifetime.signal, graceMs: 1500, stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } } })
        job.diagnostics.spawned = true
        job.reader = handle.collected.stderr
        const result = await handle.done
        readTemp(job)
        job.diagnostics.exitCode = result.exitCode
        if (result.exitCode !== 0 || result.signal) {
          const code = Number.isInteger(result.exitCode) ? result.exitCode >>> 0 : null
          const reason = result.signal || (code >= 0x80000000 ? `0x${code.toString(16).toUpperCase()}` : result.exitCode)
          const logs = [handle.collected.stderr, handle.collected.stdout].map(stream => stream?.readFrom(0).text.replace(tempHeader, '').trim()).filter(Boolean).join('\n')
          job.error = `进程退出：${reason}${code === 0xC0000374 ? '（Windows 检测到堆损坏）' : ''}${logs ? '\n' + logs.slice(-6000) : ''}`
        }
      }
      jobs.set(key, job)
      const lowTemp = process.platform === 'win32' && op === 'run' && version === 90 && project.kind === 'pbt'
      job.done = (lowTemp ? withWindowsRunTemp(tempRoots, policy.mode === 'danger-full-access', launch) : launch(tempRoots))
        .catch(error => { job.error = String(error.message || error) }).finally(() => { job.running = false; job.diagnostics.elapsedMs = Date.now() - began; delete job.reader })
      return snapshot(job)
    },
    async dispose() { lifetime.abort(); await Promise.allSettled([...jobs.values()].map(job => job.done)); jobs.clear() },
  }
}
