/** Inspect the current process token, rather than membership in an administrator account. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export async function hasInternetPrivileges({
  platform = process.platform, run = execute, effectiveUid = () => process.geteuid?.(),
  readText = readFile, systemRoot = process.env.SystemRoot || 'C:\\Windows',
} = {}) {
  if (platform === 'win32') {
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Write([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))'],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' })
    const value = stdout.trim().toLowerCase()
    if (!['true', 'false'].includes(value)) throw new Error('无法确认当前 Windows 进程是否具有管理员权限。')
    return value === 'true'
  }
  if (effectiveUid() === 0) return true
  if (platform === 'linux') {
    // CAP_NET_ADMIN lets a non-root host create/configure its TUN device.
    const status = await readText('/proc/self/status', 'utf8')
    const capability = /^CapEff:\s*([0-9a-f]+)$/imu.exec(status)?.[1]
    if (!capability) throw new Error('无法读取当前进程的网络管理权限。')
    return (BigInt(`0x${capability}`) & (1n << 12n)) !== 0n
  }
  return false
}
