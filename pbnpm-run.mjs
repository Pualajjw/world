/**
 * pbnpm 的中文输出是 GBK（`chcp 65001` 也改不了，它在进程里写死了 OEM 代码页）。
 * 终端按 UTF-8 解码字节流，直接把 pbnpm 挂上去会满屏乱码，所以终端在 PATH 前面放一个
 * 同名 `pbnpm.cmd`，由它转到这个脚本：按 GBK 增量解码，再以 UTF-8 写回。
 *
 * 用法：node pbnpm-run.mjs <pbnpm.exe 绝对路径> [参数...]
 * 退出码原样带回；stdin 不接（终端本来就没有 stdin）。
 */
import { spawn } from 'node:child_process'

const [exe, ...args] = process.argv.slice(2)
if (!exe) {
  process.stderr.write('pbnpm-run: 缺少 pbnpm.exe 路径\n')
  process.exit(2)
}

const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
// stream: true 让跨 chunk 的半个汉字留到下一段，长输出也不会在边界上错字
const out = new TextDecoder('gbk')
const err = new TextDecoder('gbk')

child.stdout.on('data', chunk => process.stdout.write(out.decode(chunk, { stream: true })))
child.stderr.on('data', chunk => process.stderr.write(err.decode(chunk, { stream: true })))
child.on('error', cause => {
  process.stderr.write(`pbnpm-run: 无法启动 pbnpm：${String(cause?.message || cause)}\n`)
  process.exitCode = 127
})
child.on('close', code => {
  const rest = out.decode()
  if (rest) process.stdout.write(rest)
  const restErr = err.decode()
  if (restErr) process.stderr.write(restErr)
  process.exitCode = code ?? 1
})
