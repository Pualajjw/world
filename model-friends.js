/**
 * 「本机模型好友」Host 侧桥接。
 *
 * 关键约定：**不自己拼多轮上下文**。每个模型好友绑定一个真实的 dsh 会话，
 * 消息用 `sessionController.prompt()` 发进去，回复从会话事件流（`assistant/message`
 * 直到 `turn/end`）里取。上下文、压缩、落盘、重启恢复全部由 dsh 负责 ——
 * 换句话说，模型看到的就是那个 dsh 会话里真实发生的对话，和你在 dsh 窗口里发是一样的。
 *
 * 局域网聊天自己的聊天记录另外保存（见 lan-chat/store.mjs），与这里的会话互不依赖：
 * 聊天窗口关掉、dsh 重启、甚至把会话删了，历史气泡都还在。
 *
 * 独立模式（start.cmd）没有宿主，就不传这个桥接，功能自动缺席而不报错。
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const BOT_PREFIX = 'bot:'

const DEFAULT_TURN_MS = 300_000     // 一轮 dsh turn 的上限（可能含工具调用，给宽一点）
const DEFAULT_ATTEMPTS = 2          // 重试次数（dsh 自己也会重试，这里只兜一层）
const MAX_SESSIONS = 60

/** 传输层 / 上游临时故障：值得原样再试一次的错误码。 */
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH',
  'EHOSTUNREACH', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'EMPTY_REPLY',
])
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

/** 说明「再试也没用」的信号：鉴权、模型名、额度、内容审核、上下文超长。 */
const FATAL_PATTERN = /unauthorized|invalid\s*api[\s_-]*key|api[\s_-]*key|forbidden|not\s*found|does\s*not\s*exist|no\s*such\s*model|permission|quota|insufficient|balance|billing|credit|context\s*length|too\s*(long|large)|max\s*tokens|content\s*(filter|policy)|safety|unauthor|invalid\s*request|bad\s*request|unsupported|无权限|未授权|鉴权|密钥|不存在|找不到|余额|额度|配额|欠费|充值|使用量.{0,8}(超出|超限)|用量.{0,8}(超出|超限)|将在.{0,24}重置|上下文.{0,4}(超|过)|内容.{0,4}(审核|违规|过滤)|不支持/iu
/** 明确的临时故障措辞（中文与英文都要覆盖，宿主把上游报文原样透传）。 */
const RETRYABLE_PATTERN = /timeout|timed?\s*out|超时|socket\s*hang\s*up|fetch\s*failed|network|econn|连接(被)?(重置|中断|失败|关闭)|overloaded|over\s*capacity|rate[\s_-]*limit|too\s*many\s*requests|temporar|try\s*again|server\s*error|internal\s*error|bad\s*gateway|service\s*unavailable|gateway\s*time|繁忙|稍后|限流|频率限制|服务器(错误|异常)|上游|重试|\b(408|425|429|5\d\d)\b/iu

/**
 * 宿主服务可能以不同方式暴露（严格 ctx.get 在服务未 ACTIVE 时返回 undefined），
 * 这里按最宽容的顺序取一次，取不到就让调用方给出可读的失败原因。
 */
function hostService(ctx, name) {
  try { const value = ctx.get?.(name); if (value) return value } catch {}
  try { const value = ctx.get?.(name, false); if (value) return value } catch {}
  try { const value = ctx[name]; if (value) return value } catch {}
  return undefined
}

/** Session / Agent / 事件三种形状里都能拿到会话 id。 */
export function sessionIdOf(value) {
  if (!value) return ''
  return String(value.header?.id ?? value.id ?? value.session?.id ?? value.sessionId ?? '')
}

/** 从 assistant/message 的 content 里抽出可见文本（工具片段一律忽略）。 */
export function assistantText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('').trim()
}

/** 把宿主装配好的系统提示词渲染成纯文本；缺失的模板变量段直接跳过，不把模板原文喂给模型。 */
export function renderAssembly(assembly) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const variables = assembly?.variables || {}
  const read = key => (variables instanceof Map ? variables.get(key) : variables[key])
  const rendered = []
  for (const section of sections) {
    let text = String(section?.text ?? '')
    if (!text.trim()) continue
    if (section?.interpolate !== false) {
      let complete = true
      text = text.replace(/\{\{([\w.-]+)\}\}/g, (_match, key) => {
        const value = read(key)
        if (value === undefined || value === null) { complete = false; return '' }
        return String(value)
      })
      if (!complete) continue
    }
    rendered.push(text)
  }
  return rendered.join('\n\n')
}

/** 从各种形状的错误里挖出 HTTP 状态码（宿主 / fetch / SDK 的字段名都不一样）。 */
function statusOf(error) {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status,
    error?.data?.status, error?.body?.status]
  for (const value of candidates) {
    const code = Number(value)
    if (Number.isInteger(code) && code >= 100 && code <= 599) return code
  }
  return 0
}

function messageOf(error) {
  const parts = [error?.message, error?.cause?.message, typeof error === 'string' ? error : '']
  if (error?.response && typeof error.response === 'object' && typeof error.response.data === 'string') {
    parts.push(error.response.data)
  }
  return parts.filter(Boolean).join(' ').slice(0, 600)
}

/**
 * 这次失败值不值得再试一次。
 * - 调用方主动中止（服务停止 / 外部超时）→ 不重试；
 * - 契约类错误（鉴权、模型名、额度、上下文超长）→ 不重试，重试只会让用户多等；
 * - 其余（连接重置、5xx、429、超时、空回复、未知异常）→ 重试。
 */
export function isRetryable(error) {
  if (!error) return false
  if (error.retryable === false || error.stopped) return false
  if (error.retryable === true) return true
  const status = statusOf(error)
  if (status) return RETRYABLE_STATUS.has(status)
  if (error.code && RETRYABLE_CODES.has(String(error.code))) return true
  const text = messageOf(error)
  if (FATAL_PATTERN.test(text)) return false
  if (RETRYABLE_PATTERN.test(text)) return true
  return true   // 未知异常按临时故障处理：最多多试一次，比直接甩错误给用户划算
}

/** 第 n 次失败后等多久再试（指数退避 + 抖动，别把上游打得更惨）。 */
export function retryDelay(attempt, baseMs = 700) {
  const delay = baseMs * Math.pow(2, Math.max(0, attempt - 1))
  return Math.round(delay + Math.random() * 250)
}

function abortError(reason) {
  const error = new Error(typeof reason === 'string' ? reason : reason?.message || '模型调用已中止')
  error.stopped = true
  error.retryable = false
  return error
}

function timeoutError(ms) {
  const error = new Error('模型调用超时（' + Math.round(ms / 1000) + ' 秒没有结束这一轮）')
  error.code = 'ETIMEDOUT'
  error.retryable = true
  return error
}

/** turn/end 的失败原因（LlmFailure）转成普通 Error，顺带保留状态码供重试判断。 */
function failureOf(reason) {
  const failure = reason?.error || reason?.failure || {}
  const error = new Error(String(failure?.message || '模型调用失败'))
  const status = Number(failure?.status)
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status
  if (failure?.code) error.code = String(failure.code)
  return error
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * @param ctx dsh Host 上下文
 * @param options.home 覆盖 DSH_HOME（测试用）
 * @param options.workspace 模型会话的工作目录（默认 `<home>/lan-chat/workspace`）
 * @param options.timeoutMs 一轮 turn 的上限（默认 300s）
 * @param options.attempts 总尝试次数（含首次，默认 2）
 * @param options.backoffMs 退避基数（默认 700ms）
 * @param options.allowApprovals 自动放行本桥接创建的会话里的工具审批（默认 true）
 */
export function createModelFriends(ctx, options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const workspace = options.workspace || path.join(home, 'lan-chat', 'workspace')
  const turnMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TURN_MS
  const attemptsLimit = Number(options.attempts) > 0 ? Math.min(4, Math.floor(Number(options.attempts))) : DEFAULT_ATTEMPTS
  const backoffMs = Number(options.backoffMs) >= 0 ? Number(options.backoffMs) : 700
  const allowApprovals = options.allowApprovals !== false

  const waiting = new Map()   // sessionId -> 正在等回复的那一轮
  const owned = new Set()     // 本桥接创建的会话（只对它们自动放行审批）
  const locks = new Map()     // sessionId -> Promise，同一会话的轮次串行
  const offs = []
  let subscribed = false
  let disposed = false

  function warn(error) {
    if (typeof options.onWarning === 'function') options.onWarning(error)
    else console.warn('[world] model friends:', String(error?.message || error))
  }

  /* --------------------------- 会话事件订阅 --------------------------- */

  function sessionEvent(session, event) {
    const entry = waiting.get(sessionIdOf(session))
    if (!entry || entry.settled) return
    const data = event?.data || {}
    if (event.type === 'turn/start') {
      // 会话可能正在跑上一轮（排队时先来的是旧 turn/end），所以用 turn/start 认领属于我们的那一轮
      if (entry.turn === undefined) entry.turn = Number(data.turn)
      return
    }
    if (event.type === 'assistant/message') {
      if (entry.turn !== undefined && Number(data.turn) !== entry.turn) return
      const text = assistantText(data.message)
      if (text) entry.parts.push(text)
      return
    }
    if (event.type === 'turn/end') {
      if (entry.turn === undefined || Number(data.turn) !== entry.turn) return
      entry.settle(true, { parts: entry.parts, reason: data.reason })
    }
  }

  /**
   * 工具审批：只处理本桥接创建的会话。聊天窗口里没有审批 UI，
   * 用户在聊天里 @ 模型就是要它把活干完，所以这里一次性放行（不落持久授权）；
   * 其它会话（包括用户自己绑定进来的）一律 next()，交给 dsh 客户端原本的流程。
   */
  function approvalRequest(request, next) {
    if (!allowApprovals) return next()
    const id = sessionIdOf(request?.agent)
    if (!id || !owned.has(id)) return next()
    return Promise.resolve('allowed-once')
  }

  function subscribe() {
    if (subscribed || disposed) return
    subscribed = true
    for (const [name, handler] of [['session/event', sessionEvent], ['approval/request', approvalRequest]]) {
      try {
        const off = ctx.on?.(name, handler)
        if (typeof off === 'function') offs.push(off)
      } catch (error) { warn(error) }
    }
  }

  /** 同一个 dsh 会话一次只跑一轮：排队而不是并发，否则回复会对不上号。 */
  function withLock(key, task) {
    const previous = locks.get(key) || Promise.resolve()
    const next = previous.then(task, task)
    const tail = next.then(() => {}, () => {})
    locks.set(key, tail)
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
    return next
  }

  /* ------------------------------ 模型目录 ------------------------------ */

  /** 所有已配置模型 → 好友，id 形如 `bot:deepseek-official/deepseek-v4.1-flash`。 */
  async function list() {
    const llm = hostService(ctx, 'llm')
    if (!llm?.listProviders || !llm?.listModels) return []
    let providers = []
    try { providers = llm.listProviders() || [] } catch { return [] }
    const seen = new Set()
    const friends = []
    for (const provider of providers) {
      const providerId = String(provider?.id ?? '').trim()
      if (!providerId) continue
      let models = []
      try { models = await llm.listModels(providerId) } catch { continue }
      for (const model of models || []) {
        const modelId = String(model?.id ?? '').trim()
        if (!modelId) continue
        const key = providerId + '/' + modelId
        if (seen.has(key)) continue
        seen.add(key)
        friends.push({
          id: BOT_PREFIX + key,
          provider: providerId,
          model: modelId,
          name: String(model.name || modelId).slice(0, 60),
          description: String(model.description || '').slice(0, 300),
          providerName: String(provider.name || providerId).slice(0, 60),
        })
      }
    }
    return friends.slice(0, 64)
  }

  /* ------------------------------ dsh 会话 ------------------------------ */

  /** dsh 里已有的会话，供「绑定到已有会话」用。 */
  async function listSessions() {
    const controller = hostService(ctx, 'sessionController')
    if (!controller?.list) return []
    let value
    try { value = await controller.list({}, new AbortController().signal) } catch (error) { warn(error); return [] }
    const items = Array.isArray(value?.items) ? value.items : []
    return items.slice(0, MAX_SESSIONS).map(item => ({
      id: String(item.sessionId || ''),
      updatedAt: Number(item.updatedAt) || 0,
      running: Boolean(item.running),
      blank: Boolean(item.blank),
    })).filter(item => item.id)
  }

  /**
   * 新建一个属于这个模型的 dsh 会话：先建，再把模型选好、起个名字。
   * `cwd` 固定到 `<home>/lan-chat/workspace`，模型在会话里用工具也只会在这里折腾。
   */
  async function createSession({ provider, model, title } = {}) {
    const controller = hostService(ctx, 'sessionController')
    if (!controller?.create) throw new Error('宿主没有提供 dsh 会话能力（sessionController 未启用）')
    try { await fsp.mkdir(workspace, { recursive: true }) } catch (error) { warn(error) }
    const created = await controller.create({ cwd: workspace })
    const sessionId = String(created?.sessionId || '')
    if (!sessionId) throw new Error('dsh 没有返回新建的会话 id')
    owned.add(sessionId)
    if (provider && model && controller.selectModel) {
      try { await controller.selectModel({ sessionId, provider: String(provider), model: String(model) }) }
      catch (error) { warn(error) }
    }
    if (title && controller.rename) {
      try { await controller.rename({ sessionId, title: String(title).slice(0, 60) }) }
      catch (error) { warn(error) }
    }
    return sessionId
  }

  /** 绑定用户已有的会话时，确认它还能用（会话可能被删了）。 */
  async function hasSession(sessionId) {
    const id = String(sessionId || '')
    if (!id) return false
    const controller = hostService(ctx, 'sessionController')
    if (!controller?.inspect) return true
    try { await controller.inspect(id); return true } catch { return false }
  }

  /** 跑一轮：prompt 进会话 → 等到 turn/end → 拼出助手文本。 */
  function runTurn({ sessionId, text, signal }) {
    return withLock(sessionId, async () => {
      const controller = hostService(ctx, 'sessionController')
      if (!controller?.prompt) throw new Error('宿主没有提供 dsh 会话能力（sessionController 未启用）')
      const entry = { parts: [], turn: undefined, settled: false }
      const done = new Promise((resolve, reject) => {
        entry.settle = (ok, value) => {
          if (entry.settled) return
          entry.settled = true
          if (ok) resolve(value)
          else reject(value)
        }
      })
      waiting.set(sessionId, entry)
      let timer = null
      const stop = reason => {
        try { controller.cancel?.({ sessionId }) } catch {}
        entry.settle(false, reason)
      }
      timer = setTimeout(() => stop(timeoutError(turnMs)), turnMs)
      const onAbort = () => stop(abortError(signal?.reason))
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        await controller.prompt({
          requestId: 'lan-chat-' + randomUUID(), sessionId, mode: 'queue',
          content: [{ type: 'text', text: String(text || '') }],
        }, signal || new AbortController().signal)
        const result = await done
        const answer = result.parts.join('\n\n').trim()
        if (answer) return answer
        const kind = result.reason?.kind
        if (kind === 'error') throw failureOf(result.reason)
        const error = new Error(kind === 'aborted' || kind === 'interrupted'
          ? '这一轮被中断了（可能是审批未处理或会话被取消）'
          : (kind === 'max-tokens' ? '模型输出到达长度上限，没给出结论' : '模型没有返回文本内容'))
        error.code = 'EMPTY_REPLY'
        error.retryable = kind !== 'aborted' && kind !== 'interrupted'
        throw error
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (waiting.get(sessionId) === entry) waiting.delete(sessionId)
      }
    })
  }

  /**
   * 给绑定的 dsh 会话发一句话并等回复。失败按临时/契约分类重试。
   * `onRetry` 让聊天界面显示第几次重试。
   */
  async function ask({ sessionId, text, signal, attempts, onRetry } = {}) {
    const id = String(sessionId || '')
    if (!id) throw new Error('这个模型还没有绑定 dsh 会话')
    if (disposed) throw abortError('聊天服务已停止')
    subscribe()
    const limit = Number(attempts) > 0 ? Math.min(4, Math.floor(Number(attempts))) : attemptsLimit
    let lastError = null
    let tried = 0
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      if (signal?.aborted) throw abortError(signal.reason)
      tried = attempt
      try {
        return await runTurn({ sessionId: id, text, signal })
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw abortError(signal.reason)
        if (attempt >= limit || !isRetryable(error)) break
        const delay = retryDelay(attempt, backoffMs)
        try { onRetry?.({ attempt: attempt + 1, attempts: limit, delayMs: delay, error }) } catch {}
        await sleep(delay, signal)
      }
    }
    const error = lastError instanceof Error ? lastError : new Error(String(lastError || '模型调用失败'))
    error.attempts = tried
    throw error
  }

  function dispose() {
    disposed = true
    for (const off of offs.splice(0)) { try { off() } catch {} }
    for (const entry of waiting.values()) entry.settle?.(false, abortError('聊天服务已停止'))
    waiting.clear()
  }

  return { list, listSessions, createSession, hasSession, ask, dispose,
    get workspace() { return workspace } }
}
