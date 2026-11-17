import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createWorldPower } from '../power.js'

const EXE = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness 0.2.1-rc.3\\DeepSeek Harness.exe'

/** 假的孩子进程：按给定的退出码收尾，父进程可以等它。 */
function fakeSpawn(calls, { code = 0, error } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    setImmediate(() => { if (error) child.emit('error', error); else child.emit('close', code) })
    return child
  }
}

function fixture(overrides = {}) {
  const scripts = [], removed = [], calls = []
  const power = createWorldPower({
    platform: 'win32', electron: '39.0.0', parentPid: 4242, execPath: EXE, tmp: 'C:\\Temp',
    writeText: async (path, content, options) => { scripts.push({ path, content, options }) },
    removeFile: async path => { removed.push(path) },
    spawnProcess: fakeSpawn(calls),
    ...overrides,
  })
  return { power, scripts, removed, calls }
}

test('probe reports the app process the plugin is running under', () => {
  const { power } = fixture()
  const info = power.probe()
  assert.equal(info.supported, true)
  assert.equal(info.appPid, 4242)
  assert.equal(info.exe, EXE)
  assert.equal(info.name, 'DeepSeek Harness.exe')
})

test('a non-desktop host says so instead of pretending it can power off', () => {
  assert.match(createWorldPower({ platform: 'linux' }).probe().reason, /Windows/u)
  assert.match(createWorldPower({ platform: 'win32', electron: undefined }).probe().reason, /命令行/u)
  assert.match(createWorldPower({ platform: 'win32', electron: '39', execPath: 'C:\\harness', parentPid: 1 })
    .probe().reason, /可执行文件/u)
})

test('shutdown hands a kill script to WMI so the killer is not inside the tree it kills', async () => {
  const { power, scripts, calls } = fixture()
  assert.deepEqual(await power.call('shutdown', {}), { action: 'shutdown', appPid: 4242 })
  assert.equal(scripts.length, 1)
  const script = scripts[0].content
  assert.ok(script.startsWith('\uFEFF'), 'PowerShell 5.1 需要 BOM 才按 UTF-8 读')
  assert.match(script, /taskkill\.exe \/F \/T \/PID 4242/u)
  assert.match(script, /Get-Process -Id 4242/u, '要等主进程真的退出')
  assert.doesNotMatch(script, /Start-Process/u, '关机不再重新拉起')
  assert.equal(scripts[0].options.mode, 0o600)
  assert.deepEqual(calls.map(call => call.command), ['powershell.exe'])
  assert.match(calls[0].args.join(' '), /Win32_Process/u)
  assert.match(calls[0].args.join(' '), /world-power-/u, '传给 WMI 的是脚本路径')
})

test('restart waits for exit and relaunches the very executable that hosts us', async () => {
  const { power, scripts } = fixture()
  await power.call('restart', {})
  const script = scripts[0].content
  assert.match(script, /taskkill\.exe \/F \/T \/PID 4242/u)
  assert.ok(script.includes(`Start-Process -FilePath '${EXE}'`), '路径按 PowerShell 单引号写进去')
  assert.ok(script.indexOf('taskkill.exe') < script.indexOf('Start-Process'), '先杀再起')
})

test('a script that never reached the system is removed and nothing else happens', async () => {
  const { power, removed } = fixture({ spawnProcess: fakeSpawn([], { code: 1 }) })
  await assert.rejects(power.call('shutdown', {}), { code: 'WORLD_POWER_UNAVAILABLE' })
  assert.equal(removed.length, 1, '临时脚本不留在 Temp 里')
})

test('an unsupported host refuses before writing any script', async () => {
  const { power, scripts } = fixture({ electron: undefined })
  await assert.rejects(power.call('restart', {}), { code: 'WORLD_POWER_UNSUPPORTED' })
  assert.equal(scripts.length, 0)
  await assert.rejects(power.call('sleep', {}), { code: 'WORLD_POWER' })
})
