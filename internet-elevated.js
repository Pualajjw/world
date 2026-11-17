/** Windows UAC broker. EasyTier output and stop commands stay on a private named pipe. */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const psQuote = text => `'${text.replaceAll("'", "''")}'`
/** Start-Process joins ArgumentList; quote it with Windows argv rules first. */
export function windowsArgument(text) {
  return `"${String(text).replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}
export function elevationCommand({ powershell, script, pipe, token }) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', script, '-PipeName', pipe, '-Token', token].map(windowsArgument).join(' ')
  return `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try{Start-Process -FilePath ${psQuote(powershell)} -ArgumentList ${psQuote(args)} -Verb RunAs -WindowStyle Hidden -ErrorAction Stop|Out-Null;exit 0}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};@{code=$e.NativeErrorCode;message=$e.Message}|ConvertTo-Json -Compress;exit 1}`
}

export function createElevatedInternetProcess(executable, args, options, {
  spawnProcess = spawn, requestUac = true, timeoutMs = 120000, onPrivatePipe,
} = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = null
  let socket, launcher, finished = false, started = false, stopRequested = false, server, timeout
  const finish = (code, signal = null) => {
    if (finished) return
    finished = true; clearTimeout(timeout)
    socket?.destroy(); try { server?.close() } catch {} ; launcher?.kill()
    child.stdout.end(); child.stderr.end(); child.emit('close', code, signal)
  }
  const fail = message => {
    if (finished) return
    child.emit('error', Object.assign(new Error(message), { code: 'WORLD_INTERNET_ELEVATION' }))
    finish(1)
  }
  child.kill = () => {
    if (finished) return false
    stopRequested = true
    if (started && socket) socket.write(`${JSON.stringify({ type: 'stop' })}\n`)
    else fail('已取消 EasyTier 管理员启动。')
    return true
  }
  // Defer startup until the caller has attached its normal ChildProcess listeners.
  queueMicrotask(() => {
    if (finished) return
    const pipe = `world-easytier-${process.pid}-${randomBytes(20).toString('hex')}`
    const token = randomBytes(32).toString('hex')
    const pipePath = `\\\\.\\pipe\\${pipe}`
    server = createServer(candidate => {
      let buffer = '', authenticated = false
      candidate.setEncoding('utf8')
      const authTimer = setTimeout(() => candidate.destroy(), 5000)
      candidate.on('error', () => { candidate.destroy() })
      candidate.on('close', () => {
        clearTimeout(authTimer)
        if (candidate === socket && !finished) fail('管理员连接已断开，EasyTier 将停止。')
      })
      candidate.on('data', text => {
        if (finished) { candidate.destroy(); return }
        buffer += text
        if (buffer.length > 131072) { candidate.destroy(); return }
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) break
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
          let message
          try { message = JSON.parse(line) } catch { candidate.destroy(); return }
          if (!authenticated) {
            if (socket || message.type !== 'hello' || typeof message.token !== 'string'
              || !/^[a-f0-9]{64}$/u.test(message.token) || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))) {
              candidate.destroy(); return
            }
            authenticated = true; socket = candidate; clearTimeout(authTimer)
            socket.write(`${JSON.stringify({ executable, args, cwd: options.cwd || '', requireAdmin: requestUac })}\n`)
            continue
          }
          if (message.type === 'started' && Number.isSafeInteger(message.pid) && message.pid > 0 && !started) {
            started = true; child.pid = message.pid; clearTimeout(timeout); child.emit('spawn')
            if (stopRequested) child.kill()
          } else if (['stdout', 'stderr'].includes(message.type) && typeof message.data === 'string') {
            child[message.type].write(Buffer.from(message.data, 'base64'))
          }
          else if (message.type === 'error') fail(String(message.message || '管理员启动失败。'))
          else if (message.type === 'exit' && Number.isSafeInteger(message.code)) finish(message.code)
        }
      })
    })
    server.on('error', () => fail('无法建立 EasyTier 管理员连接。'))
    timeout = setTimeout(() => fail('等待管理员授权超时，请重试。'), timeoutMs)
    server.listen(pipePath, () => {
      if (finished) return
      onPrivatePipe?.({ pipePath, token })
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const script = fileURLToPath(new URL('./internet-elevated.ps1', import.meta.url))
      const argv = requestUac
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', elevationCommand({ powershell, script, pipe, token })]
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PipeName', pipe, '-Token', token]
      try { launcher = spawnProcess(powershell, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (error) { fail(`无法请求管理员权限：${error.message}`); return }
      let output = ''
      launcher.stdout?.on('data', bytes => { output = (output + bytes.toString('utf8')).slice(-8192) })
      launcher.on('error', () => fail('无法启动 Windows 管理员授权，请检查 PowerShell 是否可用。'))
      launcher.on('close', code => {
        if (finished || code === 0) return
        let detail
        try { detail = JSON.parse(output) } catch { /* No secret is ever written to launcher stdout. */ }
        fail(Number(detail?.code) === 1223 ? '已取消管理员授权，EasyTier 未启动。'
          : `无法请求管理员权限${detail?.message ? `：${detail.message}` : '，请重试。'}`)
      })
    })
  })
  return child
}
