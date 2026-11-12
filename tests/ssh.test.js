/**
 * SSH 服务：全部通过一个「会说话的假 ssh」驱动。
 * 真连一台服务器在测试里既慢又不可靠，但 argv 该怎么拼、输出该怎么读、
 * 连不上时该说哪句话，这些都可以在没有网络的情况下钉死。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { cdExpression, createWorldSsh, splitRemotePrefix } from '../ssh.js'

const harness = process.env.DSH_SOURCE ?? 'E:/deepseek-harness'
const hooks = registerHooks({ resolve(name, context, next) {
  return name === '@deepseek-ai/dsh-fs'
    ? { url: pathToFileURL(join(harness, 'packages/fs/fs/lib/index.js')).href, shortCircuit: true }
    : next(name, context)
} })
const { FsError } = await import(pathToFileURL(join(harness, 'packages/fs/fs/lib/index.js')).href)

const CONFIG = [
  'Host web',
  '  HostName 10.0.0.5',
  '  User deploy',
  '  Port 2222',
  '  IdentityFile ~/.ssh/id_ed25519',
  '',
  'Host db',
  '  HostName 10.0.0.6',
  '',
].join('\n')

const RESOLVED_G = ['user deploy', 'hostname 10.0.0.5', 'port 2222', 'identityfile ~/.ssh/id_ed25519', ''].join('\n')
const KEY_BLOB = Buffer.from('world-ssh-test-key')
const KEY_B64 = KEY_BLOB.toString('base64')
const KEYSCAN = [`10.0.0.5 ssh-ed25519 ${KEY_B64}`, '# 10.0.0.5:22 SSH-2.0-OpenSSH_9.5', ''].join('\n')

/** 按 argv 决定回什么；每条命令都留档，方便断言「到底发了什么给 ssh」。 */
function createSubprocess(respond = () => null) {
  const spawns = []
  return {
    spawns,
    spawn(spec) {
      spawns.push(spec)
      const command = spec.argv.at(-1) ?? ''
      const custom = respond(spec)
      let result = custom
      if (!result) {
        if (spec.argv.includes('-V')) result = { stderr: 'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2' }
        else if (spec.argv.includes('-G')) result = { stdout: RESOLVED_G }
        else if (/printf 'world-ssh-ok/u.test(command)) result = { stdout: 'world-ssh-ok\n/home/deploy\n' }
        else if (command.startsWith('cd ') && command.endsWith(' && pwd')) result = { stdout: '/srv/app\n' }
        else if (command.includes('ls -1dpa')) result = { stdout: 'app/\napp.js\n.hidden\n' }
        else if (/ssh-keyscan/u.test(spec.argv[0] ?? '')) result = { stdout: KEYSCAN }
        else result = { stdout: `ran: ${command}\n` }
      }
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      let settle = null
      const done = result.pending
        ? new Promise(resolve => { settle = () => resolve({ exitCode: null, signal: 'SIGTERM' }) })
        : Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null })
      const reader = text => ({ readFrom(from = 0) {
        const all = Buffer.from(text)
        const start = Math.min(from, all.length)
        return { text: all.subarray(start).toString('utf8'), nextOffset: all.length, lossy: false }
      } })
      // 宿主收到 abort 会杀子进程；假 ssh 也得照做，取消才有东西可测
      if (spec.signal) spec.signal.addEventListener('abort', () => settle?.(), { once: true })
      return {
        done,
        collected: { stdout: reader(stdout), stderr: reader(stderr) },
        terminate() { settle?.() },
        waitForExit: () => done.then(() => {}, () => {}),
      }
    },
  }
}
async function setup(t, { config = CONFIG, respond } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'world-ssh-'))
  await mkdir(join(home, '.ssh'), { recursive: true })
  if (config !== null) await writeFile(join(home, '.ssh', 'config'), config)
  const subprocess = createSubprocess(respond)
  const service = createWorldSsh({}, { FsError, subprocess, home, sshPath: 'ssh' })
  t.after(async () => {
    await service.dispose()
    await rm(home, { recursive: true, force: true })
  })
  return { home, service, subprocess }
}

async function drain(service, started) {
  let offset = 0
  let output = ''
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await service.call('poll', { jobId: started.jobId, offset })
    output += state.chunk
    offset = state.offset
    if (!state.running) return { ...state, output }
  }
  throw new Error('远端命令没有结束')
}

test('hosts lists the config, keys, known_hosts and the client version', async t => {
  const { home, service } = await setup(t)
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'key')
  await writeFile(join(home, '.ssh', 'id_ed25519.pub'), 'pub')
  await writeFile(join(home, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAA\n\n# 注释\n')
  const value = await service.call('hosts', {})
  assert.deepEqual(value.hosts.map(host => host.alias), ['db', 'web'])
  assert.equal(value.hosts[1].hostName, '10.0.0.5')
  assert.equal(value.hosts[1].port, '2222')
  assert.deepEqual(value.keys, ['id_ed25519'])
  assert.equal(value.knownCount, 1)
  assert.equal(value.ssh.available, true)
  assert.match(value.ssh.version, /OpenSSH/u)
  assert.equal(value.configExists, true)
})

test('hosts follows Include and survives a missing config', async t => {
  const { home, service } = await setup(t, { config: 'Include conf.d/*.conf\nHost base\n' })
  await mkdir(join(home, '.ssh', 'conf.d'), { recursive: true })
  await writeFile(join(home, '.ssh', 'conf.d', 'work.conf'), 'Host work\n  HostName work.example.com\n')
  const value = await service.call('hosts', {})
  assert.deepEqual(value.hosts.map(host => host.alias), ['base', 'work'])

  const bare = await setup(t, { config: null })
  const empty = await bare.service.call('hosts', {})
  assert.deepEqual(empty.hosts, [])
  assert.equal(empty.configExists, false)
})

test('open resolves the effective config and probes with cd-safe arguments', async t => {
  const { service, subprocess } = await setup(t)
  const session = await service.call('open', { target: 'web' })
  assert.equal(session.user, 'deploy')
  assert.equal(session.hostName, '10.0.0.5')
  assert.equal(session.port, 2222)
  assert.equal(session.alias, 'web')
  assert.equal(session.cwd, '/home/deploy')
  assert.ok(session.latencyMs >= 0)

  const probe = subprocess.spawns.at(-1)
  assert.ok(probe.argv.includes('-T'), 'no pty in a piped window')
  assert.ok(probe.argv.includes('BatchMode=yes'), 'never wait for a password prompt')
  assert.equal(probe.argv.at(-2), 'web')
  assert.match(probe.argv.at(-1), /printf 'world-ssh-ok/u)
  assert.equal(probe.stdio.stdin, 'ignore')
})

test('a rejected login says how to set up a key instead of hanging', async t => {
  const { service } = await setup(t, {
    respond: spec => spec.argv.at(-1)?.includes('world-ssh-ok')
      ? { exitCode: 255, stderr: 'deploy@10.0.0.5: Permission denied (publickey,password).\n' }
      : null,
  })
  await assert.rejects(service.call('open', { target: 'web' }), error => {
    assert.equal(error.code, 'WORLD_SSH_AUTH')
    assert.match(error.message, /ssh-keygen/u)
    assert.match(error.message, /authorized_keys/u)
    return true
  })
})

test('an unknown host key points at trust, and network errors say what to check', async t => {
  const { service } = await setup(t, {
    respond: spec => spec.argv.at(-1)?.includes('world-ssh-ok')
      ? { exitCode: 255, stderr: 'Host key verification failed.\n' }
      : null,
  })
  await assert.rejects(service.call('open', { target: 'web' }), { code: 'WORLD_SSH_HOSTKEY' })
  await assert.rejects(service.call('open', { target: 'web' }), /trust/u)

  const down = await setup(t, {
    respond: spec => spec.argv.at(-1)?.includes('world-ssh-ok')
      ? { exitCode: 255, stderr: 'ssh: connect to host 10.0.0.5 port 2222: Connection timed out\n' }
      : null,
  })
  await assert.rejects(down.service.call('open', { target: 'web' }), error => {
    assert.equal(error.code, 'WORLD_SSH_NET')
    assert.match(error.message, /防火墙/u)
    return true
  })

  const dns = await setup(t, {
    respond: spec => spec.argv.at(-1)?.includes('world-ssh-ok')
      ? { exitCode: 255, stderr: 'ssh: Could not resolve hostname nowwhere: Name or service not known\n' }
      : null,
  })
  await assert.rejects(dns.service.call('open', { target: 'nowwhere' }), { code: 'WORLD_SSH_DNS' })
})

test('run wraps the command with the remembered remote folder', async t => {
  const { service, subprocess } = await setup(t)
  const started = await service.call('run', { target: 'web', cwd: '/srv/app', line: 'ls -l' })
  const done = await drain(service, started)
  assert.equal(done.exitCode, 0)
  assert.match(done.output, /ran: cd '\/srv\/app' && ls -l/u)
  const spec = subprocess.spawns.at(-1)
  assert.equal(spec.argv.at(-2), 'web')
  assert.equal(spec.argv.at(-1), "cd '/srv/app' && ls -l")
  assert.ok(spec.argv.includes('ServerAliveInterval=15'))
  assert.equal(spec.stdio.stdin, 'ignore')
})

test('the remote folder is quoted, but ~ and - still expand', () => {
  assert.equal(cdExpression('/srv/app'), "'/srv/app'")
  assert.equal(cdExpression('~'), '~')
  assert.equal(cdExpression('~/repo'), "~/'repo'")
  assert.equal(cdExpression('-'), '-')
  assert.equal(cdExpression("a b'c"), "'a b'\\''c'")
  assert.deepEqual(splitRemotePrefix('src/ma'), { dir: 'src/', stem: 'ma' })
})

test('cd asks the remote shell for the real path', async t => {
  const { service, subprocess } = await setup(t)
  const moved = await service.call('cd', { target: 'web', cwd: '/home/deploy', dir: 'app' })
  assert.equal(moved.cwd, '/srv/app')
  assert.equal(subprocess.spawns.at(-1).argv.at(-1), "cd 'app' && pwd")

  const failing = await setup(t, {
    respond: spec => spec.argv.at(-1)?.startsWith('cd ') && spec.argv.at(-1).endsWith('pwd')
      ? { exitCode: 2, stderr: "cd: can't cd to nope\n" }
      : null,
  })
  await assert.rejects(failing.service.call('cd', { target: 'web', cwd: '/', dir: 'nope' }), error => {
    assert.equal(error.code, 'WORLD_SSH_CD')
    assert.match(error.message, /can't cd to nope/u)
    return true
  })
})

test('completion asks ls for names and keeps folders first-class', async t => {
  const { service, subprocess } = await setup(t)
  const value = await service.call('complete', { target: 'web', cwd: '/srv/app', prefix: 'a' })
  assert.equal(value.dir, '')
  assert.deepEqual(value.items, [{ name: 'app', type: 'directory' }, { name: 'app.js', type: 'file' }])
  // 通配符必须在引号外，否则远端 shell 不会展开
  assert.match(subprocess.spawns.at(-1).argv.at(-1), /ls -1dpa 'a'\*/u)

  const inside = await setup(t, {
    respond: spec => spec.argv.at(-1)?.includes('ls -1dpa') ? { stdout: 'src/main.js\nsrc/lib/\n' } : null,
  })
  const nested = await inside.service.call('complete', { target: 'web', cwd: '/srv/app', prefix: 'src/' })
  assert.equal(nested.dir, 'src/')
  assert.deepEqual(nested.items.map(item => item.name), ['lib', 'main.js'])
})

test('key prints fingerprints and trust writes them into known_hosts', async t => {
  const { home, service } = await setup(t)
  const scanned = await service.call('key', { target: 'web' })
  const expected = `SHA256:${createHash('sha256').update(KEY_BLOB).digest('base64').replace(/=+$/u, '')}`
  assert.deepEqual(scanned.keys, [{ type: 'ssh-ed25519', fingerprint: expected }])

  const trusted = await service.call('trust', { target: 'web' })
  assert.equal(trusted.added, 1)
  const content = await readFile(join(home, '.ssh', 'known_hosts'), 'utf8')
  assert.match(content, /10\.0\.0\.5 ssh-ed25519/u)
})

test('arguments are checked before ssh is spawned', async t => {
  const { service, subprocess } = await setup(t)
  await assert.rejects(service.call('open', { target: '' }), { code: 'WORLD_SSH_TARGET' })
  await assert.rejects(service.call('open', { target: '-oProxyCommand=bad' }), { code: 'WORLD_SSH_TARGET' })
  await assert.rejects(service.call('open', { target: 'web', options: ['-t'] }), { code: 'WORLD_SSH_ARGS' })
  await assert.rejects(service.call('open', { target: 'web', options: ['--evil'] }), { code: 'WORLD_SSH_ARGS' })
  await assert.rejects(service.call('run', { target: 'web', cwd: '/', line: '   ' }), { code: 'WORLD_SSH_EMPTY' })
  await assert.rejects(service.call('run', { target: 'web', cwd: '/', line: 'x'.repeat(5000) }), { code: 'WORLD_SSH_TOO_LONG' })
  await assert.rejects(service.call('poll', { jobId: 'nope' }), { code: 'WORLD_SSH_GONE' })
  assert.deepEqual(subprocess.spawns, [], 'rejected input must not reach ssh')
})

test('-p and -i are passed through, with ~ expanded for the key', async t => {
  const { home, service, subprocess } = await setup(t)
  await service.call('open', { target: 'deploy@1.2.3.4', options: ['-p', '2200', '-i', '~/.ssh/work_key'] })
  const argv = subprocess.spawns.at(-1).argv
  assert.ok(argv.includes('2200'))
  assert.ok(argv.includes(normalize(join(home, '.ssh', 'work_key'))), argv.join(' '))
  assert.equal(argv.at(-2), 'deploy@1.2.3.4')
})

test('cancelling a connect says so instead of blaming the network', async t => {
  const { service } = await setup(t, {
    respond: spec => spec.argv.at(-1)?.includes('world-ssh-ok') ? { pending: true } : null,
  })
  const controller = new AbortController()
  const pending = service.call('open', { target: 'web' }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort()
  await assert.rejects(pending, { code: 'WORLD_SSH_CANCELLED' })
})

test('only a few remote commands may run at once', async t => {
  const { service } = await setup(t, {
    respond: spec => spec.argv.includes('-G') ? null : { pending: true },
  })
  const started = []
  for (let index = 0; index < 4; index += 1) {
    started.push(await service.call('run', { target: 'web', cwd: '/', line: `sleep ${index}` }))
  }
  await assert.rejects(service.call('run', { target: 'web', cwd: '/', line: 'echo again' }), { code: 'WORLD_SSH_BUSY' })
  for (const job of started) await service.call('cancel', { jobId: job.jobId })
})

after(() => hooks.deregister())
