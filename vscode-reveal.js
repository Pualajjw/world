/** Reveal one file or folder in the Windows Explorer. */
import { dirname } from 'node:path'

/**
 * Open Explorer with the target selected. `explorer.exe` hands the request to
 * the running shell process and exits immediately, so its exit code says
 * nothing about success; the spawn itself is the only observable failure.
 */
export function createPathRevealer(subprocess) {
  const running = new Set()

  async function reveal(target, signal) {
    signal?.throwIfAborted()
    let handle
    try {
      handle = subprocess.spawn({
        // 整个 `/select,<path>` 必须是一个参数：拆开会变成「选中空路径 + 打开文件」
        argv: ['explorer.exe', `/select,${target}`],
        // cwd 是必填项；目标父目录一定存在（目标本身刚被校验过）
        cwd: dirname(target),
        signal, graceMs: 800,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      })
    } catch (error) {
      throw Object.assign(new Error(`无法启动资源管理器：${String(error?.message || error)}`), { code: 'WORLD_REVEAL_UNAVAILABLE' })
    }
    running.add(handle)
    const timer = setTimeout(() => handle.terminate(), 6000)
    try {
      // 非零退出码对 explorer.exe 是常态（请求已转交给正在运行的 shell），不算失败
      await handle.done
    } catch (error) {
      throw Object.assign(new Error(`无法打开资源管理器：${String(error?.message || error)}`), { code: 'WORLD_REVEAL_UNAVAILABLE' })
    } finally {
      clearTimeout(timer)
      handle.terminate()
      await handle.waitForExit()
      running.delete(handle)
    }
  }

  return {
    reveal,
    async dispose() {
      const handles = [...running]
      for (const handle of handles) handle.terminate()
      await Promise.allSettled(handles.map(handle => handle.waitForExit()))
      running.clear()
    },
  }
}
