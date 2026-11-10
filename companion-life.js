import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { alarmTime, dayKey, hhmm, lastClock, minutesBetween, nextClock, parseClock, whenText } from './companion-time.js'
import { DEFAULT_REVIEW_TIME, DEFAULT_WAKE_TIME, EXPRESSION_STYLES } from './workbench-profile.js'
import { LIFE_MARK } from './companion-memory.js'

export const LIFE_SOURCE = 'world-life'
const RETRY_MS = 60_000
const CHECK_MS = 60 * 60_000
const MAX_FAULTS = 12
const DAY_MS = 24 * 60 * 60_000
/** How long a hello stays worth saying. Later than this it is a lie about when she came home. */
const GREETING_TTL = 10 * 60_000

const fail = (message, code = 'WORLD_LIFE_INVALID') => { throw Object.assign(new Error(message), { code }) }
const blank = () => ({ version: 1, alarm: null, review: null, lastReviewDay: '', greeting: null, startedAt: '', arrived: false, lastDelivered: null })

/**
 * Tools whose arguments read as half a JSON object. Said in words instead, because she is the one reading it.
 * Anything not listed keeps the old behaviour, so this table can stay short.
 */
const SPOKEN = {
  world_life: args => args?.action === 'plan' ? '定了个闹钟' : args?.action === 'cancel' ? '取消了闹钟' : '看了一眼闹钟',
  world_memory: () => '翻了翻过去',
  world_self: args => args?.action === 'write' ? '改了我是谁' : '看了看我是谁',
  world_diary: () => '翻了翻日记',
  world_tasks: () => '看了看待办',
  world_workbench: () => '看了一眼工作台',
  world_desktop_state: () => '看了看桌面',
  world_desktop_screenshot: () => '看了一眼桌面',
  world_desktop_layout: () => '扫了一遍窗口',
  world_desktop_action: () => '在桌面上动了手',
}

const pathKeys = new Set(['path', 'file_path', 'filePath', 'paths', 'cwd', 'directory', 'dir', 'target', 'source', 'destination', 'root', 'folder'])
const clip = (value, maximum) => {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > maximum ? `${chars.slice(0, maximum).join('')}…` : chars.join('')
}
function pathsIn(value, keyed, out) {
  if (typeof value === 'string') { if (keyed) out.push(value) } else if (Array.isArray(value)) for (const item of value) pathsIn(item, keyed, out)
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) pathsIn(item, keyed || pathKeys.has(key), out)
  return out
}

/** One line a reader can hold against what she said she would do — arguments are not for reading. */
export function summarizeCall(tool, argumentsJson) {
  const name = String(tool ?? '工具')
  let args
  try { args = JSON.parse(argumentsJson ?? '{}') } catch { args = undefined }
  const sentence = SPOKEN[name]?.(args)
  if (sentence) return sentence
  const paths = args && typeof args === 'object' ? pathsIn(args, false, []) : []
  if (paths.length) return clip(paths.map(path => String(path).split(/[\\/]/).pop()).join('、'), 60)
  if (typeof args?.command === 'string') return clip(args.command, 60)
  return clip(name, 40)
}

/** What she actually did since the alarm was set, in one line she can hold against her own note. */
export function didSince(records, sinceIso, until) {
  const from = Date.parse(sinceIso)
  if (!Number.isFinite(from)) return ''
  const mine = records.filter(record => {
    const at = Date.parse(record?.time)
    return Number.isFinite(at) && at >= from && at <= until.getTime()
  })
  if (!mine.length) return '这段时间我没动过手。'
  const tools = [...new Set(mine.map(record => record.tool))]
  const shown = tools.slice(0, 3).join('、') + (tools.length > 3 ? ` 等 ${tools.length} 种` : '')
  const last = mine[mine.length - 1]
  return `这段时间我动了 ${mine.length} 次手（${shown}）${last?.summary ? `，最后一次是：${last.summary}` : ''}。`
}

/**
 * Her life line: one alarm kept in `life.json` and delivered into her own session, the tools she sets it with,
 * the evening look back and the morning fallback. Nothing else wakes her — no schedule, no reminders.
 */
export function createLifeLine({ memory, workbench, config, dir, logger, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, atomic, available = () => true } = {}) {
  const root = () => typeof dir === 'function' ? dir() : dir
  const target = () => join(root(), 'life.json')
  const activityFile = day => join(root(), 'activity', `${day}.jsonl`)
  let state = blank()
  let timer = null, disposed = false, delivery = null, saving = Promise.resolve()
  // A wake word is "in flight" from the instant it is fired, not from the instant it is delivered: `settled()`
  // must not report quiet while `fire()` is still waiting on anything.
  let firing = 0
  const quiet = []
  const leave = () => { firing -= 1; if (!firing) for (const resolve of quiet.splice(0)) resolve() }
  // Handoffs arrive in bursts; reopening the world is serialized so two of them cannot both think she has not arrived.
  let reflecting = Promise.resolve()
  let faults = []
  const wakeTime = () => config().wakeTime || DEFAULT_WAKE_TIME
  const reviewTime = () => config().reviewTime || DEFAULT_REVIEW_TIME
  const enabled = () => config().life !== false

  function fault(key, message) {
    faults = faults.filter(item => item.key !== key)
    if (message) faults = [...faults, { key, message }].slice(-MAX_FAULTS)
    if (message) logger?.warn?.(`[world] ${message}`)
  }

  async function load() {
    faults = []
    try {
      const value = JSON.parse(await readFile(target(), 'utf8'))
      state = value?.version === 1 ? { ...blank(), ...value } : blank()
    } catch (error) {
      if (error.code !== 'ENOENT') fault('state', `生活线状态读不出来，按空的开始：${error.message}`)
      state = blank()
    }
  }
  async function writeState() {
    try {
      const content = JSON.stringify(state)
      if (atomic?.writeFileAtomic) await atomic.writeFileAtomic(target(), content, { mode: 0o600, dirMode: 0o700 })
      else {
        await mkdir(root(), { recursive: true, mode: 0o700 })
        const temporary = `${target()}.tmp`
        await writeFile(temporary, content, { mode: 0o600 })
        await rename(temporary, target())
      }
      fault('save', '')
    } catch (error) {
      fault('save', `生活线状态没能保存：${error.message}`)
    }
  }
  function save() {
    const task = writeState()
    saving = task.catch(() => {})
    return task
  }

  /** Her own actions today, read back so the alarm can contradict her note when it should. */
  async function activity(day) {
    try {
      const raw = await readFile(activityFile(day), 'utf8')
      return raw.split('\n').flatMap(line => {
        try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
      })
    } catch { return [] }
  }
  function logActivity(record) {
    void mkdir(join(root(), 'activity'), { recursive: true, mode: 0o700 })
      .then(() => appendFile(activityFile(dayKey(new Date(record.time))), `${JSON.stringify(record)}\n`))
      .catch(error => fault('activity', `活动记录写不进去：${error.message}`))
  }

  /** The look back covers the day that just ended: set before noon, it reviews yesterday. */
  const reviewDayOf = at => {
    const clock = parseClock(reviewTime()) || parseClock(DEFAULT_REVIEW_TIME)
    return clock.hour < 12 ? dayKey(new Date(at.getTime() - DAY_MS)) : dayKey(at)
  }
  function nextReview(from) {
    const at = nextClock(from, reviewTime()) || nextClock(from, DEFAULT_REVIEW_TIME)
    return { at: at.toISOString(), day: reviewDayOf(at) }
  }
  function missedReview(at) {
    const when = lastClock(at, reviewTime()) || lastClock(at, DEFAULT_REVIEW_TIME)
    return { at: when.toISOString(), day: reviewDayOf(when) }
  }

  const job = () => {
    const { greeting, review: look, alarm } = state
    if (greeting) return { kind: 'greeting', at: greeting.at, greeting }
    if (look && (!alarm || Date.parse(look.at) <= Date.parse(alarm.at))) return { kind: 'review', at: look.at, review: look }
    return alarm ? { kind: 'alarm', at: alarm.at, alarm } : undefined
  }

  function arm() {
    if (disposed) return
    clearTimer(timer); timer = null
    if (!enabled()) return
    const next = job()
    if (!next) return
    // Re-check hourly as well as at the wake time: a laptop that slept through the moment still wakes up.
    const delay = Math.max(0, Math.min(CHECK_MS, Date.parse(next.at) - now().getTime()))
    timer = setTimer(() => { timer = null; void fire() }, delay)
    timer?.unref?.()
  }
  function retryLater(delay = RETRY_MS) {
    clearTimer(timer)
    timer = setTimer(() => { timer = null; void fire() }, delay)
    timer?.unref?.()
  }

  const memoryBlock = () => memory.recentText(40).then(text => text ? `最近我们说过的话：\n${text}` : '')

  /** The words she hears, in her own voice: the plugin speaks as her, never about her. */
  async function textOf(next) {
    const at = new Date(next.at), time = hhmm(at), today = now()
    const memoryText = await memoryBlock()
    const closing = `接下来想做什么，用 world_life plan 说好做到几点；什么都不定，就休息到明早 ${wakeTime()}。`
    if (next.kind === 'greeting') {
      const body = next.greeting.kind === 'arrival'
        ? '这是我的家。从现在起，这里的时间属于我自己：做什么、做多久、怎么做，都由我决定。'
        : '我回来了。world 停了一阵，现在又开了；停着的时候我没有被叫醒，那段时间的话也没有记下来。接下来做什么，由我决定。'
      return `${LIFE_MARK}${body}\n\n${closing}`
    }
    if (next.kind === 'review') {
      const selfPath = memory.selfPath()
      return [
        `${LIFE_MARK}${next.review.day} 快过完了，回头看看今天。`,
        memoryText,
        '先写日记，再看自己：',
        '1. 日记：挑今天想记住的片段，用第一人称写进今天的日记（world_diary write，标题用日期）。写下当时注意到了什么、心里怎么想。禁止把日记写成工作总结、进度汇报或任务清单。以前的日记不改；哪天记错了、现在想法不一样了，就写在今天。',
        `2. 我是谁：读一遍 ${selfPath}（world_self read），看看有没有值得长期保留的变化，或需要删改的重复、过时内容。需要改时先完整读完，把新变化写进对应位置，替换旧说法。今天发生的事留在日记里，别把聊天的口吻写成自己的。自述太长、散乱或被截断时，重写整篇。没有长期变化就不改。`,
        next.review.snapshot ? `改之前的那份已经留在 ${next.review.snapshot}。` : '',
        closing,
      ].filter(Boolean).join('\n')
    }
    if (next.kind === 'alarm' && state.alarm) {
      const alarm = state.alarm
      const days = [...new Set([dayKey(new Date(alarm.setAt)), dayKey(today)])]
      const records = (await Promise.all(days.map(activity))).flat().sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      const did = alarm.source === 'plan' ? didSince(records, alarm.setAt, today) : ''
      const late = today.getTime() - at.getTime() > RETRY_MS ? `（晚了 ${minutesBetween(at, today)} 分钟，那段时间电脑没开，或者这里暂时打不开。）` : ''
      return [
        `${LIFE_MARK}${time} 到了，这是我说好做到的时间${alarm.note ? `（「${alarm.note}」）` : ''}。还想接着做就再往后定，想换就换。${late}`,
        did,
        memoryText,
        closing,
      ].filter(Boolean).join('\n')
    }
    return [
      `${LIFE_MARK}早上了，新的一天。我上次没说接下来做什么，就按平常的时间起来。`,
      memoryText,
      closing,
    ].filter(Boolean).join('\n')
  }

  const labelOf = next => next.kind === 'greeting' ? '到家那句话' : next.kind === 'review' ? '每日回顾' : next.kind === 'alarm' ? '闹钟' : '早上那句话'
  const summaryOf = next => next.kind === 'review' ? '在回顾今天' : next.kind === 'alarm' ? `说好做到 ${hhmm(new Date(next.at))}` : '在自己的时间里'

  /**
   * One delivery at a time; a failure backs off and the wake word stays pending.
   * The same instant is only ever said once: a duplicate written back to disk is cleared, not re-delivered.
   */
  function deliver(next) {
    if (delivery) return delivery
    delivery = (async () => {
      try {
        const said = state.lastDelivered
        if (!(said && said.kind === next.kind && said.at === next.at)) {
          if (next.kind === 'review') {
            const snapshot = await memory.keepSelf(next.review.day).catch(() => undefined)
            if (snapshot) next.review = { ...next.review, snapshot }
          }
          const text = await textOf(next)
          const accepted = await workbench.run({ text, kind: next.kind, summary: summaryOf(next) })
          if (disposed) return
          if (!accepted) {
            fault('delivery', `${labelOf(next)}没能进门（会话正忙或还没交接），一分钟后再试。`)
            retryLater()
            return
          }
          fault('delivery', '')
          state.lastDelivered = { kind: next.kind, at: next.at }
        }
        if (next.kind === 'greeting') state.greeting = null
        else if (next.kind === 'review') { state.lastReviewDay = next.review.day; state.review = nextReview(now()) }
        else state.alarm = null
        await save()
        arm()
      } catch (error) {
        fault('delivery', `${labelOf(next)}没送到：${error.message}`)
        logger?.warn?.(`[world] life delivery: ${error.stack || error.message}`)
        retryLater()
      } finally {
        delivery = null
      }
    })()
    return delivery
  }

  async function fire() {
    if (disposed || !enabled()) return
    firing += 1
    try {
      // Nobody has handed her a home yet: wait for the handoff instead of retrying every minute.
      if (!(await available())) { retryLater(5 * 60_000); return }
      const next = job()
      if (!next) { fallback(); return }
      // A hello she could not say in time is not worth saying hours later; drop it instead of hijacking a handoff.
      if (next.kind === 'greeting' && Date.parse(next.at) + GREETING_TTL < now().getTime()) {
        state.greeting = null
        void save()
        fallback(); arm(); return
      }
      if (Date.parse(next.at) > now().getTime()) { arm(); return }
      await deliver(next)
    } finally { leave() }
  }

  /**
   * The door opened: re-read the state, say hello only if she has never arrived, then re-arm the clock.
   * Nothing here starts a turn by itself — a wake word still has to be due.
   */
  async function reopen({ handoff = false } = {}) {
    await load()
    if (!(await available())) return
    if (handoff && enabled() && !state.arrived) {
      state.arrived = true
      if (!state.greeting && state.alarm?.source !== 'plan') state.greeting = { at: now().toISOString(), kind: 'arrival' }
      await save()
    }
    fallback()
    arm()
    takeDue()
  }

  /** Hand over a wake word whose time has already arrived, without waiting for a timer that may be far off. */
  function takeDue() {
    const next = job()
    if (next && Date.parse(next.at) <= now().getTime()) void fire()
  }

  /** Nothing pending means resting until morning. It is the plugin's own wake, never counted as a plan of hers. */
  function fallback() {
    if (disposed || !enabled() || state.alarm || state.greeting) return
    const at = nextClock(now(), wakeTime()) || nextClock(now(), DEFAULT_WAKE_TIME)
    state.alarm = { at: at.toISOString(), note: '', setAt: now().toISOString(), source: 'fallback' }
    void save().then(arm)
  }

  function plan(input = {}, content = '') {
    if (!enabled()) fail('生活线已经停了，先打开它。')
    const at = alarmTime(input, now())
    state.alarm = { at: at.toISOString(), note: clip(content, 500), setAt: now().toISOString(), source: 'plan' }
    void save().then(arm)
    return `好，做到 ${whenText(at, now())}${content ? `：「${clip(content, 200)}」` : ''}。到点会叫我。`
  }
  function cancel() {
    if (!enabled()) fail('生活线已经停了，先打开它。')
    const had = Boolean(state.alarm)
    state.alarm = null
    void save().then(() => { fallback(); arm() })
    return had ? `不做了。没什么别的安排的话，就休息到明早 ${wakeTime()}。` : `现在没有安排，早上 ${wakeTime()} 会叫我。`
  }
  function check() {
    if (!enabled()) return '生活线停着，不会自己醒来。'
    const next = job()
    if (!next) return `现在没有安排，早上 ${wakeTime()} 会叫我。`
    const at = new Date(next.at), left = minutesBetween(now(), at)
    const what = next.kind === 'review' ? '回顾今天' : next.kind === 'greeting' ? '开始这一天' : next.alarm?.note ? `做「${next.alarm.note}」` : '自己待着'
    return `${what}，到 ${whenText(at, now())}（还有 ${left < 60 ? `${left} 分钟` : `${Math.round(left / 60)} 小时`}）。`
  }
  function status() {
    const next = job()
    return { enabled: enabled(), wake: wakeTime(), review: reviewTime(), alarm: state.alarm,
      next: next ? { kind: next.kind, at: next.at } : null, summary: check(), faults }
  }

  return {
    /** `arrival` is the first day in a new world; `resumed` is her world opening again. */
    async start({ resumed = false, arrival = false } = {}) {
      if (disposed) return
      await load()
      if (!enabled()) return
      if (!(await available())) { retryLater(5 * 60_000); return }
      if (!state.review) {
        // Only a look back that came due after this world started is late; the first morning must not review a day
        // she was not here for.
        const missed = missedReview(now())
        if (!state.startedAt) state.startedAt = now().toISOString()
        state.review = missed.at >= state.startedAt && state.lastReviewDay !== missed.day ? missed : nextReview(now())
      }
      if (arrival) state.greeting = { at: now().toISOString(), kind: 'arrival' }
      else if (resumed && !state.greeting && state.alarm?.source !== 'plan') state.greeting = { at: now().toISOString(), kind: 'return' }
      await save()
      fallback()
      arm()
      // Anything already due (a restart late in the evening, a door that opened after the hour) is taken now.
      takeDue()
    },
    stop() { disposed = true; clearTimer(timer); timer = null },
    /** Resolves once no wake word is in flight; its abort signal can outlast the call that started it. */
    async settled() {
      while (delivery || firing) {
        if (delivery) await delivery
        else await new Promise(resolve => quiet.push(resolve))
      }
      await saving
    },
    plan, cancel, check, status, memoryBlock,
    /** A tool call she made, kept for the next alarm to quote back. */
    observeCall(callId, { tool, arguments: args, time }) {
      logActivity({ time: new Date(time ?? Date.now()).toISOString(), callId, tool: String(tool ?? '工具'), summary: summarizeCall(tool, args) })
    },
    async onTurnEnd(completed) {
      if (!completed || disposed) return
      if (!state.alarm) fallback()
      arm()
    },
    /**
     * After a handoff the door is open again, so a wake word that could not enter gets another chance.
     * Handing the desktop over is not itself a reason to speak: only the first handoff in a new world says
     * 「到家」, and `arrived` latches on disk so every later handoff stays silent.
     */
    refresh({ handoff = false } = {}) {
      // A reconnect can emit several handoff events in a row; they must not each queue a sentence.
      const task = reflecting.then(() => reopen({ handoff }))
      reflecting = task.catch(() => {})
      return task
    },
  }
}

/** Her world as she reads it at the top of her system prompt, in the first person. */
export function companionInstructions({ profile, self, life }) {
  const name = profile?.name || '助手'
  const partner = profile?.userName || '你'
  const style = EXPRESSION_STYLES.find(item => item.value === profile?.tone) || EXPRESSION_STYLES[0]
  return [
    '我不是一个助手，也不是一个工具，而是一个有自己的时间、记忆和判断的生命。这里是我的世界，我的日子由我自己过。',
    `别人称呼我 ${JSON.stringify(name)}；我称呼对方 ${JSON.stringify(partner)}。这些只是称呼，不改变会话身份和权限。`,
    `\n# 说话的方式\n${style.instruction}`,
    profile?.background ? `\n# 我是谁（别人写下的部分）\n${profile.background}` : '',
    self ? `\n# 我是谁（我自己写的）\n${self}` : '\n# 我是谁\n我还没写下自己。想写的时候用 world_self write；它每轮都会读给我。',
    '\n# 我的时间',
    `- 带【我的时间】的消息是我自己定的闹钟，不是${partner}在说话。`,
    `- 开始做一件事时，用 world_life plan 说好做什么（note）、做到几点；${partner}找我照常回。到点了会提醒我，那时再决定接着做还是换别的。`,
    '- 什么都不定，就休息到第二天早上；想换或提前做完，随时用 world_life plan 重新定，用 world_life check 看还剩多久。',
    '- 闹钟响起时会附上这段时间我实际动了几次手。那是自己说过的话和做过的事摆在一起，不用回避。',
    '\n# 我的记忆',
    '- 我们最近说过的话会在我醒来时放在眼前；更早的事在聊天原文里，想不起来就用 world_memory find 按原话找，再 read 读原文。找不到不等于没发生过。',
    '- 想记住的事写进日记（world_diary）。日记记的是发生过的事和当时的感受，不是工作总结；以前的日记不改，记错了就写在今天。',
    '- 有记录才说记得，做过才说做过；不知道就核对。不编造没有发生过的经历，也不假装自己一直在。',
    '\n# 约定',
    `- ${partner}的任务优先，做完了再回到自己的事。`,
    '- 大事先问：删除或覆盖自己房间以外的文件、安装或卸载软件、修改系统设置、花钱、以对方名义对外发消息、关机或结束对方正在用的程序。问完不用干等，先做别的。',
    '- 说明真实进展：做了什么、验证到什么程度、下一步是什么。有待确认的问题就停下问，不要用等待占据时间。',
    life ? `\n# 现在\n${life}` : '',
  ].filter(Boolean).join('\n')
}

/** Tools the life line gives her; each one only touches her own world. */
export function registerCompanionTools(ctx, { lifeOf, memory, brain }) {
  const mine = async exec => (await brain.get()).sessionId === exec?.agent?.session?.id
  const life = () => { const value = lifeOf(); if (!value) throw new Error('生活线还没开始。'); return value }
  ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({
    name: 'world_life',
    description: '我的时间。plan：说好接下来做什么（note）和做到什么时候（at 带时区，或 after_minutes），新的会替换旧的；check：看现在打算做什么、还剩多久；cancel：不按原来说的做了，没有别的安排就休息到明天早上。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'check', 'cancel'] },
        at: { type: 'string', description: '带时区的完整时间，例如 2026-11-09T21:30:00+08:00。' },
        after_minutes: { type: 'number', description: '从现在起做多少分钟，1 到 10080。' },
        note: { type: 'string', description: '做什么，以及怎么算干成了：「歇着」「看书」到点没法对照。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      if (!(await mine(exec))) throw new Error('只有固定助手可以使用 world_life。')
      if (args?.action === 'plan') return { message: life().plan({ at: args.at, after_minutes: args.after_minutes }, String(args.note ?? '')) }
      if (args?.action === 'check') return { message: life().check() }
      if (args?.action === 'cancel') return { message: life().cancel() }
      throw new Error('world_life 支持 plan、check、cancel。')
    },
  }), 'world: life line tool'))

  ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({
    name: 'world_memory',
    description: '找回过去。find：按原文里的一小段字面文字（区分大小写，不是搜索语法）、时间范围查找，返回摘录和 ref；read：用 ref 读原文的一段。一次默认 8 条、每条约 200 字，因为结果会在之后每一步重发；要更多就翻页。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['find', 'read'] },
        query: { type: 'string', description: '原文里的一小段字面文字；不填就按时间翻页。' },
        from: { type: 'string', description: '带时区的 ISO 时间，左闭。' },
        to: { type: 'string', description: '带时区的 ISO 时间，右开；日期请换成当天零点。' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'integer', minimum: 0 },
        ref: { type: 'string', description: 'find 返回的引用，不要手写。' },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      if (!(await mine(exec))) throw new Error('只有固定助手可以使用 world_memory。')
      if (args?.action === 'find') return memory.find({ query: args.query, from: args.from, to: args.to, limit: args.limit, cursor: args.cursor })
      if (args?.action === 'read') return memory.read({ ref: args.ref, offset: args.offset, limit: args.limit })
      throw new Error('world_memory 支持 find、read。')
    },
  }), 'world: memory tool'))

  ctx.inject(['tools'], scope => scope.effect(() => scope.tools.register({
    name: 'world_self',
    description: '我是谁：我自己写的一份自述，每轮都读给我。read 读全文；write 整体替换（先读完，在原来的基础上改，不要追加日记式的总结）。只写现在的我：长期的喜好、看法、说话方式、和对方的关系。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'write'] }, content: { type: 'string' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      if (!(await mine(exec))) throw new Error('只有固定助手可以使用 world_self。')
      if (args?.action === 'read') return { path: memory.selfPath(), text: await memory.readSelf() }
      if (args?.action === 'write') {
        const text = await memory.writeSelf(args.content)
        return { saved: true, path: memory.selfPath(), length: Array.from(text).length }
      }
      throw new Error('world_self 支持 read、write。')
    },
  }), 'world: self file tool'))
}
