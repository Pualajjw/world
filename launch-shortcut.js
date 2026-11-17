/**
 * 生成「双击 → world 沉浸启动」所需的跨平台文件。
 *
 * 核心逻辑只有一个 world-launch.mjs；各平台只生成一层很薄的包装：
 *   Windows  .cmd + .lnk
 *   macOS    .sh + .app
 *   Linux    .sh + .desktop
 *
 * 包装脚本用 DSH 自己的 Electron 可执行文件跑 Node 模式，不依赖系统 Node。
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeLaunchIntent, LAUNCH_FILE } from './launch-intent.js'

const RESERVED = /[<>:"/\\|?*\u0000-\u001f]/gu

export function sanitizeLabel(value, fallback = 'world') {
  const text = typeof value === 'string' ? value.replace(RESERVED, ' ').replace(/\s+/gu, ' ').trim() : ''
  const safe = text.replace(/^[. ]+|[. ]+$/gu, '').slice(0, 60)
  return safe || fallback
}

function quotePosix(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

function quoteBatch(value) {
  // 批处理里 % 会展开变量；路径来自 DSH 安装目录，正常不会有 %，仍然转义一次更稳。
  return `"${String(value).replace(/%/gu, '%%')}"`
}

/**
 * 纯函数：给定平台和路径，生成包装脚本内容。测试不碰文件系统。
 * @param {{platform:string, executable:string, script:string, config:string}} options
 * @returns {{name:string, content:string, mode:number}}
 */
export function buildWrapper({ platform, executable, script, config }) {
  if (platform === 'win32') {
    return {
      name: 'launch.cmd',
      mode: 0o644,
      content: [
        '@echo off',
        'setlocal',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `${quoteBatch(executable)} --expose-internals ${quoteBatch(script)} --config ${quoteBatch(config)}`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'),
    }
  }
  return {
    name: 'launch.sh',
    mode: 0o755,
    content: [
      '#!/bin/sh',
      'export ELECTRON_RUN_AS_NODE=1',
      `exec ${quotePosix(executable)} --expose-internals ${quotePosix(script)} --config ${quotePosix(config)}`,
      '',
    ].join('\n'),
  }
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

async function resolveDesktopDir({ platform, home, desktop, subprocess }) {
  if (desktop) return desktop
  if (platform === 'win32') return undefined
  const candidate = join(home, 'Desktop')
  if (await exists(candidate)) return candidate
  const xdg = process.env.XDG_DESKTOP_DIR
  if (platform === 'linux' && xdg && await exists(xdg)) return xdg
  if (platform === 'linux' && subprocess) {
    try {
      const result = await run(subprocess, ['xdg-user-dir', 'DESKTOP'])
      const path = result.code === 0 ? result.stdout.trim() : ''
      if (path && await exists(path)) return path
    } catch { /* 没有 xdg-user-dir 时退回 home */ }
  }
  return home
}

async function run(subprocess, argv, { cwd, signal } = {}) {
  if (!subprocess?.spawn) throw new Error('当前宿主没有子进程服务，无法创建桌面快捷方式。')
  const handle = subprocess.spawn({
    argv, cwd, signal, graceMs: 1500,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
  })
  try {
    const result = await handle.done
    return {
      code: result.exitCode,
      stdout: handle.collected.stdout.readFrom(0).text,
      stderr: handle.collected.stderr.readFrom(0).text,
    }
  } finally {
    handle.terminate?.()
    await handle.waitForExit?.()
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

function powershellPath() {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

async function createWindowsShortcut({ subprocess, launcherDir, target, arguments: args, executable, label, desktop, signal }) {
  const scriptPath = join(launcherDir, 'shortcut.ps1')
  const linkName = `${sanitizeLabel(label)}.lnk`
  const desktopLine = desktop
    ? `$desktop = ${psQuote(desktop)}`
    : "$desktop = [Environment]::GetFolderPath('Desktop')"
  const script = [
    "$ErrorActionPreference = 'Stop'",
    desktopLine,
    `$path = Join-Path $desktop ${psQuote(linkName)}`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$link = $shell.CreateShortcut($path)',
    `$link.TargetPath = ${psQuote(target)}`,
    `$link.Arguments = ${psQuote(args || '')}`,
    `$link.WorkingDirectory = ${psQuote(launcherDir)}`,
    '$link.WindowStyle = 1',
    `$link.IconLocation = ${psQuote(`${executable},0`)}`,
    `$link.Description = ${psQuote(`world: ${label}`)}`,
    '$link.Save()',
    '[Console]::Out.Write($path)',
    '',
  ].join('\r\n')
  await writeFile(scriptPath, `\uFEFF${script}`, 'utf8')
  const result = await run(subprocess, [
    powershellPath(), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
  ], { cwd: launcherDir, signal })
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'PowerShell 创建快捷方式失败。')
  const path = result.stdout.trim().split(/\r?\n/u).at(-1)?.trim()
  if (!path) throw new Error('PowerShell 没有返回快捷方式路径。')
  return path
}

async function createMacShortcut({ desktop, wrapper, label, id, signal }) {
  const appDir = join(desktop, `${sanitizeLabel(label)}.app`)
  const contents = join(appDir, 'Contents')
  const macos = join(contents, 'MacOS')
  await mkdir(macos, { recursive: true })
  await writeFile(join(macos, 'launch'), `#!/bin/sh\nexec ${quotePosix(wrapper)}\n`, { encoding: 'utf8', mode: 0o755 })
  await chmod(join(macos, 'launch'), 0o755)
  const name = sanitizeLabel(label).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  await writeFile(join(contents, 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleExecutable</key><string>launch</string>',
    `<key>CFBundleIdentifier</key><string>ai.deepseek.world.${id}</string>`,
    `<key>CFBundleName</key><string>${name}</string>`,
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>CFBundleVersion</key><string>1</string>',
    '<key>CFBundleShortVersionString</key><string>1.0</string>',
    '</dict></plist>',
    '',
  ].join('\n'), { encoding: 'utf8', signal })
  return appDir
}

function quoteDesktopExec(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

async function createLinuxShortcut({ desktop, wrapper, launcherDir, label, signal }) {
  const path = join(desktop, `${sanitizeLabel(label)}.desktop`)
  const name = sanitizeLabel(label).replace(/\s+/gu, ' ')
  await writeFile(path, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Comment=world 沉浸启动：${name}`,
    `Exec=${quoteDesktopExec(wrapper)}`,
    `Path=${launcherDir}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n'), { encoding: 'utf8', signal })
  await chmod(path, 0o755)
  return path
}

/**
 * 创建启动器包装 + 桌面快捷方式。快捷方式失败时仍然返回包装脚本，让用户至少能拖动或手动建链接。
 * @param {{dir:string, subprocess?:object, platform?:string, executable?:string, home?:string, desktop?:string, now?:()=>number}} options
 */
export function createLaunchShortcutService({
  dir, subprocess, platform = process.platform,
  executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath,
  home = homedir(), desktop, now = Date.now,
}) {
  const script = join(import.meta.dirname, 'world-launch.mjs')

  async function shortcut(payload, signal) {
    const app = typeof payload?.app === 'string' ? payload.app : ''
    const arg = typeof payload?.arg === 'string' ? payload.arg : ''
    const argKind = typeof payload?.argKind === 'string' ? payload.argKind : 'folder'
    const checked = normalizeLaunchIntent({
      app, arg, argKind, immersive: payload?.immersive !== false,
      nonce: 'shortcut', createdAt: now(),
    }, now())
    if (checked === undefined) throw Object.assign(new Error('启动应用或参数不合法。'), { code: 'WORLD_LAUNCH_INVALID' })
    const label = sanitizeLabel(payload?.label, checked.app)
    const id = `${checked.app.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 48)}-${randomUUID().slice(0, 8)}`
    const launcherDir = join(dir, 'launchers', id)
    await mkdir(launcherDir, { recursive: true })
    const config = join(launcherDir, 'config.json')
    await writeFile(config, `${JSON.stringify({
      app: checked.app, arg: checked.arg, argKind: checked.argKind,
      immersive: checked.immersive, label, intentFile: join(dir, LAUNCH_FILE),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    const wrapperSpec = buildWrapper({ platform, executable, script, config })
    const wrapper = join(launcherDir, wrapperSpec.name)
    await writeFile(wrapper, wrapperSpec.content, { encoding: 'utf8', mode: wrapperSpec.mode })
    if (platform !== 'win32') await chmod(wrapper, wrapperSpec.mode)

    const desktopDir = await resolveDesktopDir({ platform, home, desktop, subprocess })
    let shortcutPath = ''
    let shortcutError = ''
    try {
      if (platform === 'win32') {
        // 快捷方式直接指向 .cmd 会留下一个控制台窗口。多套一层隐藏的 PowerShell：
        // 桌面只看到图标，Node 启动器和 DSH 都在后台跑。
        const hidden = join(launcherDir, 'run-hidden.ps1')
        // WScript.Shell.Run 的第二个参数 0 是隐藏窗口；比 Start-Process 对 .cmd 更稳。
        const runLine = `$shell.Run('"${String(wrapper).replace(/'/gu, "''")}"', 0, $true)`
        await writeFile(hidden, [
          '\uFEFF$ErrorActionPreference = \'Stop\'',
          '$shell = New-Object -ComObject WScript.Shell',
          runLine,
          '',
        ].join('\r\n'), 'utf8')
        shortcutPath = await createWindowsShortcut({
          subprocess, launcherDir, target: powershellPath(),
          arguments: `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${hidden}"`,
          executable, label, desktop, signal,
        })
      } else if (desktopDir === undefined) {
        throw new Error('没有找到桌面目录。')
      } else if (platform === 'darwin') {
        shortcutPath = await createMacShortcut({ desktop: desktopDir, wrapper, label, id, signal })
      } else {
        shortcutPath = await createLinuxShortcut({ desktop: desktopDir, wrapper, launcherDir, label, signal })
      }
    } catch (error) {
      shortcutError = String(error?.message || error)
    }
    return { app: checked.app, label, launcherDir, wrapper, shortcut: shortcutPath, shortcutError, platform }
  }

  return {
    async call(operation, payload, signal) {
      if (operation !== 'shortcut') throw Object.assign(new Error('不支持的快捷方式操作。'), { code: 'WORLD_LAUNCH' })
      signal?.throwIfAborted?.()
      return shortcut(payload, signal)
    },
  }
}
