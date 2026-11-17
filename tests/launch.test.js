import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { LAUNCH_FILE, createLaunchIntentStore, normalizeLaunchIntent } from '../launch-intent.js'
import { buildWrapper, createLaunchShortcutService, sanitizeLabel } from '../launch-shortcut.js'

const valid = (overrides = {}) => ({
  version: 1, app: 'vscode', arg: 'E:\\项目', argKind: 'folder',
  immersive: true, nonce: 'nonce-1', createdAt: 1_000, ...overrides,
})

test('启动意图只接受合法应用、参数和时间', () => {
  assert.deepEqual(normalizeLaunchIntent(valid(), 1_000), valid())
  assert.equal(normalizeLaunchIntent(valid({ app: '../x' }), 1_000), undefined)
  assert.equal(normalizeLaunchIntent(valid({ app: '' }), 1_000), undefined)
  assert.equal(normalizeLaunchIntent(valid({ nonce: '' }), 1_000), undefined)
  assert.equal(normalizeLaunchIntent(valid({ createdAt: 0 }), 1_000), undefined)
  assert.equal(normalizeLaunchIntent(valid({ argKind: 'url', arg: 'javascript:alert(1)' }), 1_000), undefined)
  assert.equal(normalizeLaunchIntent(valid({ argKind: 'url', arg: 'https://example.com/' }), 1_000)?.argKind, 'url')
})

test('poll 取走意图，ack 只确认同一个 nonce', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    await writeFile(join(dir, LAUNCH_FILE), JSON.stringify(valid({ createdAt: Date.now() })), 'utf8')
    const store = createLaunchIntentStore({ dir })
    const first = await store.poll()
    assert.equal(first.intent?.app, 'vscode')
    assert.equal((await store.poll()).intent, null)
    assert.equal((await store.ack({ nonce: 'nonce-1' })).cleared, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('并发 poll 只让一个客户端取走启动意图', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    await writeFile(join(dir, LAUNCH_FILE), JSON.stringify(valid()), 'utf8')
    const store = createLaunchIntentStore({ dir, now: () => 1_000 })
    const results = await Promise.all(Array.from({ length: 20 }, () => store.poll()))
    assert.equal(results.filter(result => result.intent).length, 1)
    assert.deepEqual(results.find(result => result.intent).intent, valid())
    assert.equal((await store.poll()).intent, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('poll 和 ack 并发时只有一个操作消费成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    const store = createLaunchIntentStore({ dir, now: () => 1_000 })
    for (const ackFirst of [false, true]) {
      await writeFile(join(dir, LAUNCH_FILE), JSON.stringify(valid()), 'utf8')
      const operations = ackFirst
        ? [store.ack({ nonce: 'nonce-1' }), store.poll()]
        : [store.poll(), store.ack({ nonce: 'nonce-1' })]
      const results = await Promise.all(operations)
      assert.equal(results.filter(result => result.intent || result.cleared).length, 1)
      assert.equal((await store.poll()).intent, null)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('并发 ack 只确认一次，错误 nonce 不消费意图', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    await writeFile(join(dir, LAUNCH_FILE), JSON.stringify(valid()), 'utf8')
    const store = createLaunchIntentStore({ dir, now: () => 1_000 })
    assert.equal((await store.ack({ nonce: 'wrong' })).cleared, false)
    const results = await Promise.all(Array.from({ length: 20 }, () => store.ack({ nonce: 'nonce-1' })))
    assert.equal(results.filter(result => result.cleared).length, 1)
    assert.equal((await store.poll()).intent, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('一次消费失败不会阻塞排队中的后续请求', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    await writeFile(join(dir, LAUNCH_FILE), JSON.stringify(valid()), 'utf8')
    let fail = true
    const store = createLaunchIntentStore({ dir, now: () => {
      if (fail) { fail = false; throw new Error('clock unavailable') }
      return 1_000
    } })
    const results = await Promise.allSettled([store.poll(), store.poll()])
    assert.equal(results[0].status, 'rejected')
    assert.match(results[0].reason.message, /clock unavailable/u)
    assert.equal(results[1].status, 'fulfilled')
    assert.deepEqual(results[1].value.intent, valid())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('过期意图不会打开应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    await writeFile(join(dir, LAUNCH_FILE), JSON.stringify(valid({ createdAt: 1 })), 'utf8')
    const store = createLaunchIntentStore({ dir, now: () => 10_000, ttl: 100 })
    assert.equal((await store.poll()).intent, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('包装脚本在 Windows 和 POSIX 都使用 DSH Node 模式', () => {
  const windows = buildWrapper({
    platform: 'win32', executable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    script: 'C:\\Users\\a\\.dsh\\world\\world-launch.mjs', config: 'C:\\Users\\a\\.dsh\\world\\launchers\\x\\config.json',
  })
  assert.equal(windows.name, 'launch.cmd')
  assert.match(windows.content, /ELECTRON_RUN_AS_NODE=1/u)
  assert.match(windows.content, /--expose-internals/u)
  assert.match(windows.content, /DeepSeek Harness\.exe/u)

  const posix = buildWrapper({
    platform: 'linux', executable: '/opt/DeepSeek Harness',
    script: '/home/a/.dsh/world/world-launch.mjs', config: '/home/a/.dsh/world/launchers/x/config.json',
  })
  assert.equal(posix.name, 'launch.sh')
  assert.match(posix.content, /^#!\/bin\/sh/u)
  assert.match(posix.content, /ELECTRON_RUN_AS_NODE=1/u)
  assert.match(posix.content, /'\/opt\/DeepSeek Harness'/u)
})

test('启动器只写意图时也不启动 DSH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-launch-'))
  try {
    const config = join(dir, 'config.json')
    const intent = join(dir, 'intent', 'launch.json')
    await writeFile(config, JSON.stringify({
      app: 'vscode', arg: '/tmp/project', argKind: 'folder', immersive: true, intentFile: intent,
    }), 'utf8')
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(import.meta.dirname, '..', 'world-launch.mjs'), '--config', config, '--dry-run',
    ], { cwd: dir, env: process.env })
    assert.equal(stdout.trim(), intent)
    const value = JSON.parse(await readFile(intent, 'utf8'))
    assert.equal(value.app, 'vscode')
    assert.equal(value.arg, '/tmp/project')
    assert.equal(value.immersive, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('快捷方式名不包含路径分隔符和保留字符', () => {
  assert.equal(sanitizeLabel('VSCode: 项目/测试'), 'VSCode 项目 测试')
  assert.equal(sanitizeLabel('   '), 'world')
})

function localSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(spec.env || {}) },
      })
      const chunks = []
      child.stdout?.on('data', chunk => chunks.push(chunk))
      child.stderr?.on('data', chunk => chunks.push(chunk))
      const done = new Promise(resolve => {
        child.on('error', () => resolve({ exitCode: null, signal: null }))
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const text = () => Buffer.concat(chunks).toString('utf8')
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: text(), nextOffset: text().length, lossy: false }) },
          stderr: { readFrom: () => ({ text: text(), nextOffset: text().length, lossy: false }) },
        },
        terminate() { if (!child.killed) child.kill() },
        waitForExit: () => done.then(() => {}, () => {}),
      }
    },
  }
}

test('Windows 下真正生成 .lnk（仅 Windows）', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-shortcut-'))
  const desktop = join(dir, 'Desktop')
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(desktop))
    const service = createLaunchShortcutService({
      dir, desktop, platform: 'win32', executable: process.execPath,
      home: dir, subprocess: localSubprocess(), now: () => Date.now(),
    })
    const value = await service.call('shortcut', { app: 'vscode', label: 'World Launch Test', arg: 'E:\\项目', argKind: 'folder' })
    assert.equal(value.shortcutError, '')
    assert.match(value.wrapper, /launch\.cmd$/u)
    assert.match(value.shortcut, /World Launch Test\.lnk$/u)
    await stat(value.shortcut)
    const hiddenScript = await readFile(join(value.launcherDir, 'run-hidden.ps1'), 'utf8')
    assert.match(hiddenScript, /WScript\.Shell/u)
    assert.match(hiddenScript, /, 0, \$true/u)
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
    const { stdout } = await promisify(execFile)(powershell, [
      '-NoProfile', '-Command',
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:WORLD_LNK); [Console]::Out.Write($s.TargetPath + "|" + $s.Arguments)',
    ], { env: { ...process.env, WORLD_LNK: value.shortcut } })
    assert.match(stdout, /powershell\.exe/iu, '快捷方式不应直接指向 .cmd，否则会留下控制台')
    assert.match(stdout, /run-hidden\.ps1/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Linux 下生成可执行包装和 .desktop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-shortcut-'))
  const desktop = join(dir, 'Desktop')
  try {
    await stat(desktop).catch(async () => { await import('node:fs/promises').then(({ mkdir }) => mkdir(desktop)) })
    const service = createLaunchShortcutService({
      dir, desktop, platform: 'linux', executable: '/opt/DeepSeek Harness',
      home: dir, now: () => Date.now(),
    })
    const value = await service.call('shortcut', { app: 'vscode', label: 'VSCode', arg: '/tmp/project', argKind: 'folder' })
    assert.equal(value.shortcutError, '')
    assert.match(value.wrapper, /launch\.sh$/u)
    assert.match(value.shortcut, /VSCode\.desktop$/u)
    assert.match(await readFile(value.wrapper, 'utf8'), /ELECTRON_RUN_AS_NODE=1/u)
    const entry = await readFile(value.shortcut, 'utf8')
    assert.match(entry, /Terminal=false/u)
    assert.match(entry, /Exec=/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
