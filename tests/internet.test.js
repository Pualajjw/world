import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createElevatedInternetProcess } from '../internet-elevated.js'
import { createWorldInternet, INTERNET_DEFAULTS, normalizeInternetConfig, internetDefaults, internetExecutable, internetPermissionHint } from '../internet.js'

const waitFor = async predicate => {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for EasyTier fixture')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function fixture(t, { output = '', exit = false, limit, platform = process.platform, usePath = false,
  privileged = true, elevatedSpawn, stopMs, connectionProbe } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'world-internet-'))
  const instances = []
  t.after(async () => {
    await Promise.all(instances.map(host => host.dispose()))
    await rm(dir, { recursive: true, force: true })
  })
  const bin = join(dir, 'Easy Tier 程序'), data = join(dir, 'state')
  await mkdir(bin)
  const core = join(bin, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core')
  await writeFile(core, '')
  await chmod(core, 0o755)
  const script = join(dir, 'core.mjs')
  await writeFile(script, `
    const args = process.argv.slice(2)
    const secret = args[args.indexOf('--network-secret') + 1]
    console.log('argv=' + JSON.stringify(args))
    const line = Buffer.from('中文日志 ' + secret + '\\n')
    process.stdout.write(line.subarray(0, 1))
    setTimeout(() => { process.stdout.write(line.subarray(1, line.length - 2));
      setTimeout(() => process.stdout.write(line.subarray(line.length - 2)), 20) }, 20)
    console.error(${JSON.stringify(output || 'stderr ready')})
    ${exit ? "setTimeout(() => { process.stderr.write('last line'); process.exit(7) }, 100)" : 'setInterval(() => {}, 1000)'}
  `)
  const calls = []
  const spawnFixture = (exe, args, options) => {
      calls.push({ exe, args, options })
      return spawn(process.execPath, [script, ...args], options)
  }
  const options = { dir: data, maxLogChars: limit, stopMs, connectionProbe,
    platform, checkPrivileges: async () => privileged, spawnImpl: spawnFixture,
    elevatedSpawnImpl: elevatedSpawn || ((exe, args, options) => {
      const child = spawnFixture(exe, args, options)
      calls.at(-1).elevated = true
      return child
    }),
  }
  const reopen = () => { const host = createWorldInternet(options); instances.push(host); return host }
  const service = reopen()
  const config = { ...internetDefaults(platform), directory: usePath ? '' : bin, secret: '@test! $ & " quote' }
  return { service, config, calls, data, reopen }
}

test('normalizes the supplied escaped UDP URL, preserves literal secrets and rejects invalid parameters', () => {
  const config = { ...INTERNET_DEFAULTS, secret: ' @test! ', peer: 'udp\\://118.178.196.123:11010' }
  assert.equal(normalizeInternetConfig(config).peer, INTERNET_DEFAULTS.peer)
  assert.equal(normalizeInternetConfig(config).secret, config.secret)
  for (const change of [{ ipv4: '10.999.1.3' }, { ipv4: '10.1.1.1/33' }, { peer: 'udp://host:99999' },
    { autoStart: 'true' }, { autoStart: 1 }, { peer: '--daemon' }, { secret: '' }, { directory: 'relative' }, { secret: 'one\ntwo' }])
    assert.throws(() => normalizeInternetConfig({ ...config, ...change }))
})

test('saves configuration, passes literal argv without a shell, streams both outputs, stops and restarts', async t => {
  const { service, config, calls, data } = await fixture(t)
  assert.equal((await service.call('info')).phase, 'stopped')
  await service.call('save', { config })
  assert.deepEqual(JSON.parse(await readFile(join(data, 'internet.json'), 'utf8')), config)
  const [a, b] = await Promise.all([service.call('start'), service.call('start')])
  assert.equal(a.pid, b.pid); assert.equal(calls.length, 1)
  assert.equal(calls[0].exe, internetExecutable(config.directory))
  assert.deepEqual(calls[0].args, ['-i', config.ipv4, '--network-secret', config.secret, '-p', config.peer])
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.cwd, config.directory)
  await waitFor(async () => (await service.call('status')).logs.includes('中文日志 ******'))
  let state = await service.call('status')
  assert.match(state.logs, /stderr ready/u)
  assert.ok(!state.logs.includes(config.secret))
  assert.ok(!state.logs.includes(JSON.stringify(config.secret).slice(1, -1)))
  await assert.rejects(service.call('save', { config }), /请先停止/u)
  const restored = createWorldInternet({ dir: data })
  assert.deepEqual((await restored.call('info')).config, config)
  await restored.dispose()
  state = await service.call('stop')
  assert.equal(state.running, false); assert.equal(state.phase, 'stopped')
  await service.call('clear')
  assert.equal((await service.call('status')).logs, '')
  const restarted = await service.call('start'); assert.equal(calls.length, 2)
  await service.dispose()
  await waitFor(() => { try { process.kill(restarted.pid, 0); return false } catch { return true } })
})

test('only an opted-in host starts once; changing the next launch never changes the live connection', async t => {
  let probes = 0
  const { service, config, data, calls, reopen } = await fixture(t, { connectionProbe: {
    read: async () => { probes++; return { connected: false } }, invalidate() {}, dispose() {},
  } })
  const saved = { ...config, autoStart: true }
  await service.call('save', { config: saved })
  assert.equal(calls.length, 0); assert.equal(probes, 0)
  await service.dispose()
  const host = reopen()
  // Authorized startup runs on the host before any page/info request. Manual start
  // arriving during initialization reuses the same process, not a second core.
  await waitFor(() => calls.length === 1)
  const state = await host.call('start'); assert.equal(state.phase, 'running')
  assert.equal(calls.length, 1); assert.equal(probes, 1)
  assert.equal((await host.call('info')).config.autoStart, true)
  await assert.rejects(host.call('save', { config: { ...config, ipv4: '10.0.0.7' } }), {code:'WORLD_INTERNET_BUSY'})
  await host.call('save', { config })
  assert.equal((await host.call('status')).pid, state.pid)
  assert.equal(JSON.parse(await readFile(join(data,'internet.json'),'utf8')).autoStart, false)
  await host.call('stop'); await host.dispose()
  const off = reopen()
  await off.call('clear'); assert.equal(calls.length, 1); assert.equal(probes, 1)
  const { autoStart, ...legacy } = config
  await writeFile(join(data,'internet.json'),JSON.stringify(legacy))
  const old = reopen()
  await old.call('clear'); assert.equal((await old.call('info')).config.autoStart,false)
  assert.equal(calls.length, 1); assert.equal(probes, 1)
})

test('a manual launch racing startup shares one child; unloading during startup never spawns one', async t => {
  let release, checking
  const { service, config, calls, reopen } = await fixture(t, { connectionProbe: {
    read: () => new Promise(resolve => { release = () => resolve({connected:false}); checking() }),
    invalidate() {}, dispose() { release?.() },
  } })
  await service.call('save', {config:{...config,autoStart:true}}); await service.dispose()
  const boot = async () => {
    const entered = new Promise(resolve => { checking = resolve }); const host = reopen()
    await entered; return host
  }
  const first = await boot(), manual = first.call('start')
  release(); assert.equal((await manual).running,true); assert.equal(calls.length,1)
  await first.dispose()
  const second = await boot(); await second.dispose(); assert.equal(calls.length,1)
})

test('startup skips a matching existing tunnel and reports a failed attempt without retrying', async t => {
  let connected = true
  const { service, config, calls, reopen, data } = await fixture(t, { connectionProbe: {
    read: async c => ({ connected, ipv4: c.ipv4.split('/')[0] }), invalidate() {}, dispose() {},
  } })
  await service.call('save', {config:{...config, directory:join(data,'missing'), autoStart:true}})
  await service.dispose()
  const existing = reopen()
  await existing.call('stop'); assert.match((await existing.call('status')).logs,/跳过自动启动/)
  assert.equal(calls.length,0); await existing.dispose()
  connected = false
  const failed = reopen()
  await waitFor(async () => (await failed.call('status')).phase === 'failed')
  const state = await failed.call('status'); assert.match(state.error,/找不到/); assert.ok(!state.logs.includes(config.secret))
  assert.equal(calls.length,0)
  await failed.call('start',{config}); assert.equal(calls.length,1)
})

test('captures immediate failure, final partial stderr and bounded output', async t => {
  const { service, config } = await fixture(t, { exit: true, output: 'x'.repeat(5000), limit: 1000 })
  await service.call('start', { config })
  await waitFor(async () => !(await service.call('status')).running)
  const state = await service.call('status')
  assert.equal(state.phase, 'failed'); assert.equal(state.exitCode, 7)
  assert.match(state.logs, /last line/u)
  assert.ok(state.logs.length <= 1000); assert.equal(state.truncated, true)
})

test('missing executable, malformed saved configuration and unavailable platform report actionable errors', async t => {
  const { service, config, data } = await fixture(t)
  await assert.rejects(service.call('start', { config: { ...config, directory: join(data, 'missing') } }), /找不到/u)
  await writeFile(join(data, 'internet.json'), '{')
  const corrupt = createWorldInternet({ dir: data })
  await assert.rejects(corrupt.call('info'), /无法读取上网配置/u)
  const unsupported = createWorldInternet({ dir: data, platform: 'freebsd' })
  await assert.rejects(unsupported.call('start', { config }), /支持 Windows、macOS 和 Linux/u)
  await corrupt.dispose(); await unsupported.dispose()
})

test('platform-specific executable names, defaults and paths follow the host OS', () => {
  for (const [platform, directory, expected] of [
    ['win32', 'D:\\Easy Tier', 'D:\\Easy Tier\\easytier-core.exe'],
    ['darwin', '/opt/homebrew/bin', '/opt/homebrew/bin/easytier-core'],
    ['linux', '/opt/easy tier', '/opt/easy tier/easytier-core'],
  ]) {
    const config = { ...internetDefaults(platform), directory, secret: 'test' }
    assert.equal(normalizeInternetConfig(config, platform).directory, directory)
    assert.equal(internetExecutable(directory, platform), expected)
    assert.equal(normalizeInternetConfig({ ...config, directory: '' }, platform).directory, '')
    assert.equal(internetExecutable('', platform), platform === 'win32' ? 'easytier-core.exe' : 'easytier-core')
    if (platform !== 'win32') {
      assert.equal(internetDefaults(platform).directory, '')
      assert.throws(() => normalizeInternetConfig({ ...config, directory: 'D:\\easytier' }, platform), /当前系统/u)
      assert.match(internetPermissionHint(platform), /root|网络权限/u)
    }
  }
})

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} PATH launches, streams output, stops and reports native permission failures`, async t => {
    const { service, config, calls } = await fixture(t, { platform, usePath: true, exit: true, output: 'operation not permitted' })
    await service.call('save', { config })
    await service.call('start')
    assert.equal(calls[0].exe, platform === 'win32' ? 'easytier-core.exe' : 'easytier-core')
    assert.equal(calls[0].options.cwd, undefined)
    assert.equal(calls[0].options.shell, false)
    await waitFor(async () => !(await service.call('status')).running)
    const state = await service.call('status')
    assert.equal(state.platform, platform); assert.equal(state.supported, true)
    assert.equal(state.error, internetPermissionHint(platform))
    assert.match(state.logs, /last line/u)
  })
}

test('a missing executable on PATH surfaces a usable error and allows retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-internet-path-'))
  const service = createWorldInternet({ dir, platform: 'linux', checkPrivileges: async () => true, spawnImpl: (_exe, args, options) =>
    spawn(join(dir, 'missing-executable'), args, options) })
  t.after(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
  const config = { ...internetDefaults('linux'), secret: 'test' }
  await assert.rejects(service.call('start', { config }), /找不到.*PATH/u)
  assert.equal((await service.call('status')).running, false)
  await assert.rejects(service.call('start', { config }), /找不到.*PATH/u)
})

test('Windows requests elevation when its host lacks the admin token and keeps logging and stop controls',
  { skip: process.platform !== 'win32' }, async t => {
    const { service, config, calls } = await fixture(t, { privileged: false })
    assert.equal((await service.call('info')).requiresElevation, true)
    const state = await service.call('start', { config })
    assert.equal(calls.length, 1); assert.equal(calls[0].elevated, true)
    assert.equal(state.elevated, true)
    await waitFor(async () => (await service.call('status')).logs.includes('中文日志 ******'))
    assert.match((await service.call('status')).logs, /Windows 授权窗口/u)
    await service.call('stop')
    assert.equal((await service.call('status')).running, false)
  })

test('POSIX refuses a TUN launch without root or effective network administration permission', async t => {
  const { service, config, calls } = await fixture(t, { platform: 'linux', usePath: true, privileged: false })
  await assert.rejects(service.call('start', { config }), { code: 'WORLD_INTERNET_PRIVILEGE' })
  assert.equal(calls.length, 0)
})

test('disabling the service cancels a pending administrator request and starts no core',
  { skip: process.platform !== 'win32' }, async t => {
    const { service, config, calls } = await fixture(t, { privileged: false,
      elevatedSpawn: (exe, args, options) => createElevatedInternetProcess(exe, args, options, { spawnProcess() {
        const launcher = new EventEmitter(); launcher.stdout = new PassThrough(); launcher.kill = () => {}
        return launcher
      } }),
    })
    const rejected = assert.rejects(service.call('start', { config }), /已取消 EasyTier 管理员启动/u)
    await waitFor(async () => (await service.call('status')).phase === 'authorizing')
    await service.dispose()
    await rejected
    assert.equal(calls.length, 0)
  })
