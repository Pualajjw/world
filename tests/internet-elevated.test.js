import assert from 'node:assert/strict'
import test from 'node:test'
import { once, EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { createElevatedInternetProcess, elevationCommand, windowsArgument } from '../internet-elevated.js'

const collect = stream => {
  const chunks = []
  stream.on('data', chunk => chunks.push(chunk))
  return () => Buffer.concat(chunks).toString('utf8')
}
const waitFor = async read => {
  const deadline = Date.now() + 10000
  while (!read()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the administrator broker')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('UAC launcher quotes only broker arguments and requests a hidden administrator window', () => {
  assert.equal(windowsArgument('a"b\\'), '"a\\"b\\\\"')
  const command = elevationCommand({ powershell: 'C:\\Windows\\powershell.exe', script: "C:\\user's files\\helper.ps1", pipe: 'pipe', token: 'token' })
  assert.match(command, /-Verb RunAs -WindowStyle Hidden/u)
  assert.match(command, /user''s files/u)
  assert.doesNotMatch(command, /network-secret|cmd\.exe/u)
})

test('canceling UAC reports a canceled authorization and never starts a core', { skip: process.platform !== 'win32' }, async () => {
  const child = createElevatedInternetProcess('C:\\missing.exe', [], {}, { spawnProcess() {
    const launcher = new EventEmitter(); launcher.stdout = new PassThrough(); launcher.kill = () => {}
    setTimeout(() => { launcher.stdout.write(JSON.stringify({ code: 1223 })); launcher.emit('close', 1) }, 10)
    return launcher
  } })
  let spawned = false
  child.on('spawn', () => { spawned = true })
  const error = await new Promise(resolve => child.once('error', resolve))
  assert.match(error.message, /已取消管理员授权/u)
  assert.equal(spawned, false); assert.equal(child.pid, null)
})

test('a timed-out authorization closes the broker without starting a core', { skip: process.platform !== 'win32' }, async () => {
  const child = createElevatedInternetProcess('C:\\missing.exe', [], {}, { timeoutMs: 50, spawnProcess() {
    const launcher = new EventEmitter(); launcher.stdout = new PassThrough(); launcher.kill = () => {}
    return launcher
  } })
  const error = await new Promise(resolve => child.once('error', resolve))
  assert.match(error.message, /管理员授权超时/u)
  assert.equal(child.pid, null)
})

test('real PowerShell broker preserves argv, streams both UTF-8 outputs and stops its child over the private pipe',
  { skip: process.platform !== 'win32' }, async t => {
    const secret = '@test! $ & " slash\\ trail\\'
    const child = createElevatedInternetProcess(process.execPath, ['-e',
      `console.log(JSON.stringify(process.argv.slice(1)));console.error('中文错误日志');setInterval(()=>{},1000)`, '--', secret], {}, {
      requestUac: false,
      onPrivatePipe({ pipePath }) {
        // A guessed/invalid token must not obtain the EasyTier command or kill the broker.
        const attacker = connect(pipePath)
        attacker.on('error', () => {})
        attacker.on('connect', () => attacker.write(JSON.stringify({ type: 'hello', token: '中'.repeat(64) }) + '\n'))
      },
    })
    const output = collect(child.stdout), error = collect(child.stderr)
    const closed = new Promise(resolve => child.once('close', resolve))
    t.after(async () => { child.kill(); await closed })
    await once(child, 'spawn')
    assert.ok(child.pid > 0)
    await waitFor(() => output().includes('trail') && error().includes('中文错误日志'))
    assert.deepEqual(JSON.parse(output().trim()), [secret])
    assert.match(error(), /中文错误日志/u)
    const pid = child.pid
    child.kill()
    await closed
    assert.throws(() => process.kill(pid, 0), 'stopping the broker must terminate its core')
  })

test('closing the host process closes the private pipe and removes its core', { skip: process.platform !== 'win32' }, async t => {
  const module = new URL('../internet-elevated.js', import.meta.url).href
  const host = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createElevatedInternetProcess } from ${JSON.stringify(module)}
    const child = createElevatedInternetProcess(process.execPath, ['-e','setInterval(()=>{},1000)'], {}, {requestUac:false})
    child.on('spawn',()=>console.log(JSON.stringify({pid:child.pid})))
    child.on('error',error=>{console.error(error.message);process.exit(1)})
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = collect(host.stdout)
  let corePid
  const closed = new Promise(resolve => host.once('close', resolve))
  t.after(async () => { host.kill(); await closed; if (corePid) { try { process.kill(corePid) } catch {} } })
  await waitFor(() => output().includes('pid'))
  const { pid } = JSON.parse(output().trim())
  corePid = pid
  host.kill(); await closed
  await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } })
})
