import { spawn } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const fail = (message, code = 'WORLD_POWER') => { throw Object.assign(new Error(message), { code }) }

/**
 * 开始菜单里的关机 / 重启：真正操作 DSH 主程序，而不是 world 这一层。
 *
 * 插件跑在主程序的子进程（dsh-desktop-host）里，宿主没有向插件开放「退出应用」的接口：
 * 关窗口只会隐藏到托盘，`shutdown` 那条 IPC 是父进程发给子进程的，反向发过去会被当成
 * 非法事件并弹出崩溃恢复对话框。所以只能从外面动手：写一个 PowerShell 脚本，用 WMI 的
 * `Win32_Process.Create` 把它挂到 WmiPrvSE 下面（**不在** DSH 的进程树里），再由它
 * taskkill 整棵树、必要时重新拉起 exe。
 *
 * 三条硬约束：
 * - 脚本必须在动手之前就创建成功，创建失败就什么都不做，别让用户看到「按了没反应」；
 * - 杀掉的是整个进程树，所以执行者绝不能是我们的子进程，否则会把自己一起带走；
 * - 重新拉起要走系统环境（WMI 起的进程没有 ELECTRON_RUN_AS_NODE），exe 才会按应用模式启动。
 */
export function createWorldPower({
  platform = process.platform, electron = process.versions.electron, parentPid = process.ppid,
  execPath = process.execPath, tmp = tmpdir(), spawnProcess = spawn, writeText = writeFile, removeFile = unlink,
  delayMs = 700,
} = {}) {
  /** 主程序身份：父进程是 Electron 主进程，execPath 就是那颗 exe（宿主用它在 node 模式下跑）。 */
  function resolveApp() {
    if (platform !== 'win32') fail('只有 Windows 桌面版支持关机与重启。', 'WORLD_POWER_UNSUPPORTED')
    if (electron === undefined) fail('当前不是桌面版（命令行启动的 DSH），请直接关闭那个终端。', 'WORLD_POWER_UNSUPPORTED')
    if (!Number.isInteger(parentPid) || parentPid <= 0 || !execPath) fail('找不到 DSH 主程序进程。', 'WORLD_POWER_UNSUPPORTED')
    if (!/\.exe$/iu.test(execPath)) fail('找不到 DSH 主程序的可执行文件。', 'WORLD_POWER_UNSUPPORTED')
    return { appPid: parentPid, exe: execPath, dir: dirname(execPath), name: basename(execPath) }
  }

  function probe() {
    try {
      const app = resolveApp()
      return { supported: true, appPid: app.appPid, exe: app.exe, name: app.name }
    } catch (error) { return { supported: false, reason: error.message } }
  }

  /** PowerShell 单引号字符串：内部的单引号写两遍。 */
  const quote = value => `'${String(value).replace(/'/gu, "''")}'`

  function scriptText(app, restart) {
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      // 先等一下，让这边把「正在关机」的提示送回页面再断开。
      `Start-Sleep -Milliseconds ${Math.max(0, Math.round(delayMs))}`,
      `& taskkill.exe /F /T /PID ${app.appPid} | Out-Null`,
      `$deadline = (Get-Date).AddSeconds(45)`,
      `while ((Get-Process -Id ${app.appPid} -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 200 }`,
      ...(restart
        // 等主进程真的没了再起：单实例锁还在的话，新进程只会退出并唤起旧窗口。
        ? ['Start-Sleep -Milliseconds 800', `Start-Process -FilePath ${quote(app.exe)} -WorkingDirectory ${quote(app.dir)}`, 'Start-Sleep -Milliseconds 2000']
        : []),
      'Remove-Item -LiteralPath $PSCommandPath -Force',
      '',
    ].join('\r\n')
  }

  /** 用 WMI 起进程：父进程是 WmiPrvSE，taskkill /T 那个树里没有它。 */
  function launchOutOfTree(scriptPath) {
    const command = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create '
      + `-Arguments @{CommandLine='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"'} | Out-Null`
    return new Promise((resolve, reject) => {
      const child = spawnProcess('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { windowsHide: true, stdio: 'ignore' })
      // WMI 偶尔会卡在服务里：超时就当没排上，别让按钮一直转。
      const timer = setTimeout(() => { try { child.kill() } catch {} reject(new Error('安排系统任务超时')) }, 20_000)
      const settle = (error) => { clearTimeout(timer); if (error) reject(error); else resolve() }
      child.once('error', error => settle(error))
      child.once('close', code => settle(code === 0 ? undefined
        : new Error(`无法安排系统任务（powershell 退出码 ${String(code)}）`)))
    })
  }

  async function schedule(action) {
    const app = resolveApp()
    const scriptPath = join(tmp, `world-power-${randomUUID()}.ps1`)
    // 带 BOM 写：PowerShell 5.1 只有看见 BOM 才按 UTF-8 读，否则按 ANSI 解，中文路径会乱。
    await writeText(scriptPath, `\uFEFF${scriptText(app, action === 'restart')}`, { mode: 0o600 })
    try { await launchOutOfTree(scriptPath) }
    catch (error) {
      await removeFile(scriptPath).catch(() => {})
      fail(`${action === 'restart' ? '重启' : '关机'}没有执行：${error.message}`, 'WORLD_POWER_UNAVAILABLE')
    }
    return { action, appPid: app.appPid }
  }

  return {
    probe,
    async call(operation) {
      if (operation === 'probe') return probe()
      if (operation === 'shutdown' || operation === 'restart') return schedule(operation)
      fail('不支持的电源操作。')
    },
  }
}
