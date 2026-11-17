/**
 * 桌面快捷方式 → DSH → world 的启动意图。
 *
 * 快捷方式先跑一个很小的 DSH Node 启动器，把意图写进 <DSH_HOME>/world/launch.json；
 * world 客户端轮询这里的 poll 操作，取走意图后打开应用。文件让「DSH 没启动」也能工作：
 * 启动器先写文件，再拉起 DSH，world 挂载后自然能读到。
 */
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const LAUNCH_FILE = 'launch.json'
export const LAUNCH_TTL_MS = 2 * 60 * 1000
const APP = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const NONCE = /^[A-Za-z0-9._-]{1,128}$/u
const ARG_KINDS = new Set(['folder', 'file', 'url', 'text'])

/**
 * 校验启动器写下的意图。坏数据一律当作没看见，不能让一个手改的 JSON 打开任意应用。
 * @param {unknown} value - 启动器写入的对象。
 * @param {number} now - 当前时间，测试可注入。
 * @returns {{version:1, app:string, arg:string, argKind:string, immersive:boolean, nonce:string, createdAt:number}|undefined}
 */
export function normalizeLaunchIntent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const app = typeof value.app === 'string' ? value.app.trim() : ''
  if (!APP.test(app)) return undefined
  const arg = typeof value.arg === 'string' ? value.arg : ''
  if (arg.length > 8192) return undefined
  const argKind = typeof value.argKind === 'string' && ARG_KINDS.has(value.argKind) ? value.argKind : 'folder'
  if (argKind === 'url' && arg && !/^https?:\/\//iu.test(arg)) return undefined
  const nonce = typeof value.nonce === 'string' && NONCE.test(value.nonce) ? value.nonce : ''
  if (!nonce) return undefined
  const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : 0
  if (createdAt <= 0 || createdAt > now + 60_000) return undefined
  return { version: 1, app, arg, argKind, immersive: value.immersive !== false, nonce, createdAt }
}

/**
 * 启动意图文件仓库。poll 是「取走」而不是「看一眼」：两台 window / 两个标签同时轮询时，
 * 只有第一个请求会真正打开应用，后到的看到空文件。
 * @param {{dir:string, now?:() => number, ttl?:number}} options - world 数据目录与时序注入。
 */
export function createLaunchIntentStore({ dir, now = Date.now, ttl = LAUNCH_TTL_MS }) {
  const file = join(dir, LAUNCH_FILE)
  // 同一个宿主的所有客户端共用此 store；读和删除必须作为整体排队，
  // 仅仅「先删再返回」挡不住已经同时完成 read 的另一条请求。
  let pending = Promise.resolve()
  function serialize(operation) {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }

  async function read() {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      // 删不掉的坏文件由下一次写入覆盖；这一次当作没有意图。
      await unlink(file).catch(() => {})
      return undefined
    }
  }

  async function poll() {
    const value = await read()
    if (value === undefined) return { intent: null }
    const intent = normalizeLaunchIntent(value, now())
    if (intent === undefined || now() - intent.createdAt > ttl) {
      await unlink(file).catch(() => {})
      return { intent: null }
    }
    // 删除失败不能交付，否则下一次轮询还会再次打开同一个应用。
    await unlink(file)
    return { intent }
  }

  async function ack(payload) {
    const value = await read()
    if (value === undefined) return { cleared: false }
    const intent = normalizeLaunchIntent(value, now())
    if (intent === undefined || intent.nonce !== payload?.nonce) return { cleared: false }
    await unlink(file)
    return { cleared: true }
  }

  return {
    file,
    poll: () => serialize(poll),
    ack: payload => serialize(() => ack(payload)),
    async call(operation, payload = {}) {
      if (operation === 'poll') return serialize(poll)
      if (operation === 'ack') return serialize(() => ack(payload))
      throw Object.assign(new Error('不支持的启动意图操作。'), { code: 'WORLD_LAUNCH' })
    },
  }
}
