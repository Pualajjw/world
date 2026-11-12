/**
 * 浏览器测试用的「一台远程服务器」：真的走 ssh.js + 一个会按剧本回话的假 ssh。
 * 这样窗口里看到的主机清单、提示行、错误文案、trust 流程，都是真实代码算出来的，
 * 只有网络那一层被换掉——不依赖任何一台能连的服务器。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldSsh } from '../ssh.js'

class FixtureFsError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

const CONFIG = [
  'Host web',
  '  HostName 10.0.0.5',
  '  User deploy',
  '',
  'Host authfail',
  '  HostName 10.0.0.9',
  '  User root',
  '',
  'Host newkey',
  '  HostName 10.0.0.7',
  '  User root',
  '',
  'Host slow',
  '  HostName 10.0.0.8',
  '  User root',
  '',
].join('\n')

const KEY = Buffer.from('world-fixture-key').toString('base64')

const HOSTS = {
  web: { hostName: '10.0.0.5', user: 'deploy' },
  authfail: { hostName: '10.0.0.9', user: 'root' },
  newkey: { hostName: '10.0.0.7', user: 'root' },
  slow: { hostName: '10.0.0.8', user: 'root' },
}

/** 剧本：按 argv 判断这一次 ssh 想干什么。 */
function respond(spec) {
  const argv = spec.argv
  const command = argv.at(-1) ?? ''

  if (argv.includes('-V')) return { stderr: 'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\n' }
  // keyscan 的参数最后就是主机名，别再按 ssh 的位置去猜
  if (/ssh-keyscan/u.test(argv[0] ?? '')) {
    const scanned = argv.at(-1) ?? ''
    const known = HOSTS[scanned] || { hostName: scanned }
    return { stdout: `${known.hostName} ssh-ed25519 ${KEY}\n` }
  }

  // `ssh -G <主机>` 的主机在最后；其余都是 `ssh <选项…> <主机> <命令>`
  const target = argv.includes('-G') ? command : (argv.at(-2) ?? '')
  const host = HOSTS[target] || { hostName: target, user: 'root' }
  if (argv.includes('-G')) return { stdout: `user ${host.user}\nhostname ${host.hostName}\nport 22\nidentityfile ~/.ssh/id_ed25519\n` }
  if (/printf 'world-ssh-ok/u.test(command)) {
    // 一台「连不上但也死活不报错」的服务器：用来测取消连接
    if (target === 'slow') return { pending: true }
    if (target === 'authfail') return { exitCode: 255, stderr: `${host.user}@${host.hostName}: Permission denied (publickey,password).\n` }
    if (target === 'newkey') return { exitCode: 255, stderr: 'Host key verification failed.\n' }
    return { stdout: `world-ssh-ok\n/home/${host.user}\n` }
  }
  // 远程命令里的 sleep 也挂住：用来测「断开时把正在跑的命令一起停掉」
  if (command.includes('sleep')) return { pending: true }
  if (command.startsWith('cd ') && command.endsWith(' && pwd')) {
    // 绝对路径按原样回（`cd -` 回上一个目录时窗口传的就是绝对路径）；相对路径统一当 /srv
    const dir = /^cd '([^']*)' && pwd$/u.exec(command)?.[1] ?? ''
    return { stdout: `${dir.startsWith('/') ? dir : '/srv'}\n` }
  }
  if (command.includes('ls -1dpa')) {
    // 像真的 ls 一样只回匹配的那几个：补全行为才和线上一致
    const stem = /ls -1dpa '([^']*)'\*/u.exec(command)?.[1] ?? ''
    return { stdout: ['app/', 'app.js', 'notes.txt'].filter(name => name.startsWith(stem)).map(name => `${name}\n`).join('') }
  }
  return { stdout: `remote: ${command}\n` }
}

function createSubprocess() {
  return {
    spawn(spec) {
      const result = respond(spec) || {}
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      const reader = text => ({ readFrom(from = 0) {
        const all = Buffer.from(text)
        const start = Math.min(from, all.length)
        return { text: all.subarray(start).toString('utf8'), nextOffset: all.length, lossy: false }
      } })
      // 挂住的那条只有在被 terminate / abort 时才结束，和真进程的 SIGTERM 一致
      let settle = null
      const done = result.pending
        ? new Promise(resolve => { settle = () => resolve({ exitCode: null, signal: 'SIGTERM' }) })
        : Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null })
      const handle = {
        done,
        collected: { stdout: reader(stdout), stderr: reader(stderr) },
        terminate() { settle?.() },
        waitForExit: async () => {},
      }
      if (spec.signal) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      return handle
    },
  }
}

export async function createSshFixture() {
  const home = await mkdtemp(join(tmpdir(), 'world-ssh-ui-'))
  await mkdir(join(home, '.ssh'), { recursive: true })
  await writeFile(join(home, '.ssh', 'config'), CONFIG, 'utf8')
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'key', 'utf8')
  const service = createWorldSsh({}, { FsError: FixtureFsError, subprocess: createSubprocess(), home, sshPath: 'ssh' })
  return {
    home,
    call: (operation, payload, signal) => service.call(operation, payload || {}, signal),
    dispose: async () => {
      await service.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}
