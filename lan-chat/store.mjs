/**
 * 会话落盘：把会话 / 消息 / 模型绑定写成一份 JSON，重启后原样读回来。
 *
 * - 原子写（先写 .tmp 再 rename），避免进程被杀时留下半截文件；
 * - 合并写（debounce），连着发十条消息只落一次盘；
 * - 读失败一律当「没有历史」处理，不让一个坏文件拖垮聊天服务。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

export function createStateStore(options = {}) {
  // file 可以是字符串，也可以是个函数（DSH_HOME 可能在构造之后才确定）
  const fileOf = typeof options.file === 'function' ? options.file : () => String(options.file || '')
  const file = () => String(fileOf() || '')
  const getState = typeof options.getState === 'function' ? options.getState : () => ({})
  const debounceMs = Number(options.debounceMs) >= 0 ? Number(options.debounceMs) : 600
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : () => {}
  let timer = null
  let chain = Promise.resolve()
  let closed = false

  async function read() {
    const target = file()
    if (!target) return null
    try {
      const raw = await fsp.readFile(target, 'utf8')
      const data = JSON.parse(raw)
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null
    } catch {
      return null
    }
  }

  async function write() {
    const target = file()
    if (!target) return
    const text = JSON.stringify(getState())
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const temporary = target + '.' + process.pid + '.tmp'
    await fsp.writeFile(temporary, text, 'utf8')
    await fsp.rename(temporary, target)
  }

  /** 立刻落盘；多次调用按顺序排队，不会互相覆盖。 */
  function save() {
    if (closed) return chain
    chain = chain.then(write).catch(error => { try { onWarning(error) } catch {} })
    return chain
  }

  /** 合并写：高频修改只安排一次落盘。 */
  function schedule() {
    if (closed || !file() || timer) return
    timer = setTimeout(() => {
      timer = null
      void save()
    }, debounceMs)
    timer.unref?.()
  }

  /** 停止前把挂起的改动写完。 */
  async function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
      return save()
    }
    return chain
  }

  function dispose() {
    closed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return chain
  }

  return { file: () => file(), read, save, schedule, flush, dispose }
}
