/**
 * 桌面快捷方式使用的 DSH Node 启动器。
 *
 * 它由快捷键包装脚本通过 DSH 自带的 Node 环境执行：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness>" --expose-internals world-launch.mjs --config <json>
 *
 * 做两件事：把启动意图写到 world 数据目录；拉起（或聚焦）DSH 桌面窗口。
 * 注意拉起 GUI 时必须删掉 ELECTRON_RUN_AS_NODE，否则同一个可执行文件会再次以 Node 模式运行。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LAUNCH_FILE, normalizeLaunchIntent } from './launch-intent.js'

function fail(message) {
  console.error(`[world-launch] ${message}`)
  process.exitCode = 1
}

function readOption(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
}

function configOf(argv) {
  const path = readOption(argv, '--config')
  if (path) return { path }
  const app = readOption(argv, '--app') || argv.find(value => !value.startsWith('--')) || ''
  return {
    path: '',
    value: {
      app,
      arg: readOption(argv, '--arg'),
      argKind: readOption(argv, '--arg-kind') || 'folder',
      immersive: !argv.includes('--windowed'),
    },
  }
}

async function readConfig(argv) {
  const source = configOf(argv)
  if (!source.path) return source.value
  try {
    // Windows PowerShell 写出的 JSON 可能带 BOM；配置文件允许手改，读的时候容错。
    return JSON.parse((await readFile(source.path, 'utf8')).replace(/^\uFEFF/u, ''))
  } catch (error) {
    fail(`读取启动配置失败：${String(error?.message || error)}`)
    return undefined
  }
}

function intentFileOf(config) {
  if (typeof config?.intentFile === 'string' && config.intentFile) return config.intentFile
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'world', LAUNCH_FILE)
}

async function writeIntent(file, config) {
  const createdAt = Date.now()
  const value = normalizeLaunchIntent({
    version: 1,
    app: config.app,
    arg: typeof config.arg === 'string' ? config.arg : '',
    argKind: config.argKind || 'folder',
    immersive: config.immersive !== false,
    nonce: randomUUID(),
    createdAt,
  }, createdAt)
  if (value === undefined) throw new Error('启动配置里的应用或参数不合法。')
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
  return value
}

function cleanEnvironment() {
  const env = { ...process.env }
  // GUI 模式必须没有这两个变量；否则同一个 Electron 可执行文件会按 Node / 无控制台模式启动。
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

function protocolFallback() {
  if (process.platform === 'win32') {
    const command = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    return spawn(command, ['/d', '/s', '/c', 'start "" "dsh://open"'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnvironment(),
    })
  }
  if (process.platform === 'darwin') {
    return spawn('open', ['dsh://open'], { detached: true, stdio: 'ignore', env: cleanEnvironment() })
  }
  return spawn('xdg-open', ['dsh://open'], { detached: true, stdio: 'ignore', env: cleanEnvironment() })
}

function launchDsh() {
  const executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath
  const looksLikeDesktop = /(?:deepseek[ .-]?harness|(?:^|[\\/])dsh)(?:\.exe)?$/iu.test(basename(executable))
  let child
  if (looksLikeDesktop && process.platform === 'darwin') {
    const marker = '/Contents/MacOS/'
    const index = executable.indexOf(marker)
    if (index > 0) {
      child = spawn('open', ['-a', executable.slice(0, index)], {
        detached: true, stdio: 'ignore', env: cleanEnvironment(),
      })
    }
  } else if (looksLikeDesktop) {
    child = spawn(executable, [], {
      detached: true, stdio: 'ignore', windowsHide: false, env: cleanEnvironment(),
    })
  }
  child ??= protocolFallback()
  return child
}

async function main() {
  const argv = process.argv.slice(2)
  const config = await readConfig(argv)
  if (!config) return
  if (typeof config.app !== 'string' || !config.app) {
    fail('缺少要启动的应用。')
    return
  }
  const file = intentFileOf(config)
  try {
    await writeIntent(file, config)
  } catch (error) {
    fail(`写入启动意图失败：${String(error?.message || error)}`)
    return
  }
  if (argv.includes('--dry-run')) {
    console.log(file)
    return
  }
  const child = launchDsh()
  child.once('error', (error) => {
    fail(`无法启动 DSH：${String(error?.message || error)}`)
    process.exit(1)
  })
  child.once('spawn', () => {
    child.unref()
    // 必须显式退出：Electron 的 Node 模式可能在脚本结束后仍留着内部句柄。
    // 不退出的话，Windows 快捷方式对应的控制台会一直挂在后台。
    process.exit(0)
  })
  // spawn 事件迟迟不来时也要收尾，别把启动器进程留在那里。
  setTimeout(() => {
    child.unref()
    process.exit(process.exitCode || 0)
  }, 1500)
}

await main()
