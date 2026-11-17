/**
 * 浏览器测试用的终端后端：用 node:fs 与 node:child_process 顶替宿主的 fs / subprocess，
 * 让「在真浏览器里敲一条命令、看它真的跑起来」这件事不需要整套 DSH 宿主。
 */
import { spawn, spawnSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { createWorldTerminal } from '../terminal.js'

class FixtureFsError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function createFs() {
  const target = (path, cwd) => resolvePath(cwd || process.cwd(), String(path))
  return {
    async resolve(path, options = {}) {
      return target(path, options.cwd)
    },
    processPath(value) { return value },
    async stat(value) {
      try {
        const info = await stat(value)
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' }
      } catch { return undefined }
    },
    async listDir(value) {
      const entries = await readdir(value, { withFileTypes: true })
      return entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: join(value, entry.name),
      }))
    },
  }
}

function createSubprocess() {
  return {
    /**
     * 宿主的 subprocess 服务在 Windows 上是用 `taskkill /T /F` 杀整棵进程树的
     * （见 subprocess-local/src/spawn.ts）。这里必须跟着做：终端命令走的是
     * `cmd.exe /d /s /c <script>`，只 kill 掉 cmd 的话，它拉起来的 node 还活着、
     * 还攥着 stdout 管道，`close` 事件不来，job 就一直显示「运行中」——
     * 测试看起来是「Ctrl+C 没生效」，其实是夹具没杀孙子进程。
     */
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(spec.env ?? {}) },
      })
      let terminated = false
      const chunks = []
      child.stdout?.on('data', chunk => chunks.push(chunk))
      child.stderr?.on('data', chunk => chunks.push(chunk))
      const done = new Promise(resolve => {
        child.on('error', () => resolve({ exitCode: null, signal: null }))
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const handle = {
        done,
        collected: {
          stdout: {
            readFrom(from) {
              const all = Buffer.concat(chunks)
              const start = Math.min(from, all.length)
              return { text: all.subarray(start).toString('utf8'), nextOffset: all.length, lossy: false }
            },
          },
        },
        terminate() {
          if (terminated) return
          terminated = true
          if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            return
          }
          child.kill()
        },
        waitForExit: () => done.then(() => {}, () => {}),
      }
      if (spec.signal) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      return handle
    },
  }
}

export function createTerminalFixture() {
  return createWorldTerminal({ fs: createFs() }, { FsError: FixtureFsError, subprocess: createSubprocess() })
}
