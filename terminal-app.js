/**
 * world 桌面里的「终端」窗口。
 *
 * 命令在宿主里跑（见 terminal.js），这里只做三件事：把 ANSI 输出画成带样式的行、
 * 提供一个像终端的输入行、以及让 `cd` / `clear` / `open` 这些「窗口自己的事」不打扰 shell。
 * 光标用原生 input 的插入符，不做假光标——选字、复制、输入法都跟着浏览器走。
 */
import React from 'react'
import { NO_STYLE, colorCss, createScreen } from './ansi.js'

const h = React.createElement
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const HISTORY_KEY = 'dsh.world.terminal.history'
const CWD_KEY = 'dsh.world.terminal.cwd'
const POLL_MS = 90
const HISTORY_LIMIT = 200
/** 短于这个时长的成功命令不报时间：`dir` 后面挂个 0.02s 只会显得吵。 */
const SLOW_MS = 600
const BUILTINS = ['cd', 'clear', 'cls', 'help', 'pwd', 'open', 'exit', 'ssh', 'trust', 'logout']
const REMOTE_BUILTINS = ['cd', 'clear', 'cls', 'help', 'pwd', 'open', 'exit', 'logout', 'trust', 'ssh']
/** 这些命令的第一个参数是主机名：Tab 应该补别名，而不是补本地文件。 */
const HOST_COMMANDS = ['ssh', 'scp', 'sftp']
const FONT_KEY = 'dsh.world.terminal.font'
/** 字号档位：按档走，比连续加减好停——12.5 是 125% 缩放下等宽最稳的一档。 */
const FONT_SIZES = [10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 18]
const FONT_DEFAULT = 4
const clampFontIndex = index => Math.max(0, Math.min(FONT_SIZES.length - 1, index))

function readFontIndex() {
  try {
    const stored = FONT_SIZES.indexOf(Number(window.localStorage.getItem(FONT_KEY)))
    return stored >= 0 ? stored : FONT_DEFAULT
  } catch { return FONT_DEFAULT }
}

function saveFontIndex(index) {
  try { window.localStorage.setItem(FONT_KEY, String(FONT_SIZES[index])) } catch {}
}

export function TerminalGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, focusable: 'false' },
    h('defs', null,
      h('linearGradient', { id: 'worldTerminalGradient', x1: '0', y1: '0', x2: '1', y2: '1' },
        h('stop', { offset: '0', stopColor: '#2b3441' }),
        h('stop', { offset: '1', stopColor: '#12161c' }))),
    h('rect', { x: 2, y: 2, width: 44, height: 44, rx: 13, fill: 'url(#worldTerminalGradient)' }),
    h('path', { d: 'M13.5 17.5 20 24l-6.5 6.5', stroke: '#7ee787', strokeWidth: 3.1, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }),
    h('path', { d: 'M24.5 30.5H34', stroke: '#e6edf3', strokeWidth: 3.1, strokeLinecap: 'round' }))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isMac = () => typeof navigator !== 'undefined' && /mac/iu.test(navigator.platform || '')

function readHistory() {
  try {
    const value = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-HISTORY_LIMIT) : []
  } catch { return [] }
}

function saveHistory(list) {
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-HISTORY_LIMIT))) } catch {}
}

function readCwd() {
  try { return window.localStorage.getItem(CWD_KEY) || '' } catch { return '' }
}

function saveCwd(path) {
  try { window.localStorage.setItem(CWD_KEY, path) } catch {}
}

function baseName(path) {
  const text = String(path || '').replace(/[\\/]+$/u, '')
  return text.split(/[\\/]/u).at(-1) || text
}

/** `C:\Users\me\proj` → `~\proj`；太长时只留最后两段，提示行不该被路径占满。 */
function shortPath(path, home) {
  const text = String(path || '')
  const normalized = text.replace(/\\/gu, '/')
  const root = String(home || '').replace(/\\/gu, '/')
  const tail = root && normalized.startsWith(root) ? `~${normalized.slice(root.length)}` : normalized
  const parts = tail.split('/').filter(Boolean)
  if (tail.length <= 42 || parts.length <= 2) return tail || '.'
  const keep = parts.slice(-2).join('/')
  return `${/^[a-zA-Z]:/u.test(parts[0]) ? `${parts[0]}/` : ''}…/${keep}`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 拆一行命令：引号里的空格不算分隔符，`ssh -i "C:\keys\my key" host` 才走得通。 */
function tokenizeCommand(text) {
  const tokens = []
  let current = ''
  let quote = ''
  let started = false
  for (const char of String(text ?? '')) {
    if (quote) {
      if (char === quote) { quote = ''; continue }
      current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (/\s/u.test(char)) {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * `ssh <主机>` 的解析放在窗口这边：选项原样交给 ssh，窗口只挑出「连哪儿」。
 * 只有一个主机参数是硬性的——远端命令得连上之后再敲，否则会和在本地排队打架。
 */
function parseSshCommand(text) {
  const tokens = tokenizeCommand(text)
  const options = []
  let target = ''
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (['-p', '-i', '-l', '-J', '-o', '-F'].includes(token)) {
      const value = tokens[index + 1]
      if (!value) return { error: `${token} 后面要跟一个值。` }
      options.push(token, value)
      index += 1
      continue
    }
    if (['-4', '-6', '-A', '-C'].includes(token)) { options.push(token); continue }
    if (token.startsWith('-')) {
      return { error: `不支持的参数：${token}（可用 -p 端口 / -i 密钥 / -l 用户 / -J 跳板 / -o 选项）` }
    }
    if (target) return { error: 'ssh 只接一个主机；远端命令连上之后再敲。' }
    target = token
  }
  return { target, options }
}

/** 提示行左边的 `用户@主机`；太长就把主机名截短，路径才是更重要的那半。 */
function remoteLabel(remote) {
  const host = String(remote.alias || remote.hostName || '')
  const short = host.length > 22 ? `${host.slice(0, 21)}…` : host
  return `${remote.user || 'user'}@${short}`
}

/**
 * 输入行里的远程目录只留最后一段：560px 的窗口里，一条完整路径会把输入框挤没。
 * 完整路径在状态栏和 title 里，需要的时候看得到。
 */
function compactRemotePath(path, home) {
  const text = String(path || '/')
  const root = String(home || '').replace(/\/+$/u, '')
  const inside = root && (text === root || text.startsWith(`${root}/`))
  const rest = inside ? text.slice(root.length) : text
  const parts = rest.replace(/\/+$/u, '').split('/').filter(Boolean)
  if (!parts.length) return inside ? '~' : '/'
  const tail = parts.length <= 1 ? parts[0] : `…/${parts.at(-1)}`
  return inside ? (parts.length <= 1 ? `~/${parts[0]}` : `~/${tail}`) : (parts.length <= 1 ? `/${parts[0]}` : tail)
}

const cssCache = new WeakMap()
/** ANSI 样式 → 内联样式。inverse 用一个主题色垫底，否则反显会变成「黑底黑字」。 */
function cssOf(style) {
  if (!style || style === NO_STYLE) return undefined
  const cached = cssCache.get(style)
  if (cached) return cached
  const css = {}
  const fg = colorCss(style.fg)
  const bg = colorCss(style.bg)
  if (style.inverse) {
    css.color = bg || 'var(--world-term-bg)'
    css.background = fg || 'var(--world-term-fg)'
  } else {
    if (fg) css.color = fg
    if (bg) css.background = bg
  }
  if (style.bold) css.fontWeight = 600
  if (style.dim) css.opacity = 0.62
  if (style.italic) css.fontStyle = 'italic'
  if (style.underline) css.textDecoration = 'underline'
  cssCache.set(style, css)
  return css
}

function unwrap(result) {
  if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '终端操作失败。'), { code: result?.error?.code })
  return result.value
}

function Cap({ label, onClick, close, children }) {
  return h('button', {
    type: 'button', className: `world-lanchat-cap${close ? ' world-lanchat-close' : ''}`,
    title: label, 'aria-label': label, onClick,
  }, children)
}

export function TerminalWindow({
  rect, state, rpc, session, apps, onOpenApp, active,
  onActivate, onClose, onMinimize, onToggleMaximize, onDragStart, onDragMove, onDragEnd, onResizeStart,
}) {
  const screenRef = React.useRef(null)
  if (!screenRef.current) screenRef.current = createScreen({ maxRows: 1200, maxColumns: 400 })
  const [frame, setFrame] = React.useState(() => screenRef.current.snapshot())
  const [info, setInfo] = React.useState(null)
  const [cwd, setCwd] = React.useState(readCwd)
  const [input, setInput] = React.useState('')
  const [history, setHistory] = React.useState(readHistory)
  const [cursor, setCursor] = React.useState(-1)
  const [job, setJob] = React.useState(null)
  const [fatal, setFatal] = React.useState('')
  const [attempt, setAttempt] = React.useState(0)
  const [stick, setStick] = React.useState(true)
  const [remote, setRemote] = React.useState(null)
  const [hosts, setHosts] = React.useState([])
  const [pendingTrust, setPendingTrust] = React.useState('')
  const [sshNote, setSshNote] = React.useState('')
  /** 连接 / 阅读主机密钥这类「一次性等待」的提示：状态栏要能说明它在忙什么。 */
  const [busy, setBusy] = React.useState('')
  /** Ctrl+R 的反向搜索：`{ query, hit, step }`；null 表示不在搜索里。 */
  const [search, setSearch] = React.useState(null)
  const [fontIndex, setFontIndex] = React.useState(readFontIndex)
  /** 排队中的命令条数：状态栏要能看出「已经排了几条」。 */
  const [queued, setQueued] = React.useState(0)
  const scrollRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const draftRef = React.useRef('')
  const prefixRef = React.useRef('')
  const searchRef = React.useRef(null)
  const historyRef = React.useRef(history)
  const previousRef = React.useRef('')
  const queueRef = React.useRef([])
  const jobRef = React.useRef(null)
  const generationRef = React.useRef(0)
  const cancelRef = React.useRef(false)
  const stickRef = React.useRef(true)
  const callRef = React.useRef(null)
  const sshCallRef = React.useRef(null)
  const executeRef = React.useRef(null)
  const submitRef = React.useRef(null)
  /** 正在进行的连接 / 读指纹：Esc 与状态栏的「取消」都靠它中断。 */
  const connectRef = React.useRef(null)
  /** 键盘回调放在 ref 里：监听只挂一次，处理逻辑每次都取最新的闭包。 */
  const keyHandlerRef = React.useRef(null)
  /** 命令已经发出、但还没拿到 jobId 的那几十毫秒：这段时间回车也算「忙」。 */
  const startingRef = React.useRef(false)
  const cwdRef = React.useRef(readCwd())
  const infoRef = React.useRef(null)
  const remoteRef = React.useRef(null)
  const hostsRef = React.useRef([])
  const pendingTrustRef = React.useRef('')

  const minimized = state === 'min'
  const maximized = state === 'max'
  const prompt = search
    ? '(reverse-i-search)'
    : remote
      ? `${remoteLabel(remote)}:${compactRemotePath(remote.cwd, remote.home)}$`
      : `${shortPath(cwd || info?.cwd || '', info?.home)}${info?.platform === 'windows' ? '>' : ' $'}`

  /** 远程会话的权威副本放在 ref 里：轮询和队列回调拿到的必须是「现在」的连接。 */
  const applyRemote = next => { remoteRef.current = next; setRemote(next) }
  const applyHosts = list => { hostsRef.current = list; setHosts(list) }
  const applyTrust = target => { pendingTrustRef.current = target; setPendingTrust(target) }
  const applySearch = next => { searchRef.current = next; setSearch(next) }

  /**
   * 反向搜索：从最新一条往回找。多按一次 Ctrl+R 就再往前翻一条——终端里的肌肉记忆，
   * 所以 `step` 记的是「已经翻过几条」，而不是光标落在哪个绝对下标上。
   */
  const runSearch = (query, step = 0) => {
    const list = historyRef.current || []
    const needle = String(query || '').toLowerCase()
    const matches = needle ? list.filter(item => item.toLowerCase().includes(needle)) : list
    const hit = matches.length ? matches[Math.max(0, matches.length - 1 - Math.min(step, matches.length - 1))] : ''
    applySearch({ query, step, hit, matched: matches.length })
  }

  const call = React.useCallback(async (operation, payload = {}, signal) => {
    if (!rpc || typeof rpc.call !== 'function') throw new Error('当前宿主没有提供 RPC 通道。')
    const result = await rpc.call('/api', `world-terminal/${operation}`, { sessionId: session?.id, ...payload }, signal)
    return unwrap(result)
  }, [rpc, session])
  const sshCall = React.useCallback(async (operation, payload = {}, signal) => {
    if (!rpc || typeof rpc.call !== 'function') throw new Error('当前宿主没有提供 RPC 通道。')
    const result = await rpc.call('/api', `world-ssh/${operation}`, { sessionId: session?.id, ...payload }, signal)
    return unwrap(result)
  }, [rpc, session])
  callRef.current = call
  sshCallRef.current = sshCall
  cwdRef.current = cwd
  infoRef.current = info
  historyRef.current = history

  const refresh = React.useCallback(() => setFrame(screenRef.current.snapshot()), [])

  /** 往屏幕里写一段「窗口自己说的话」（提示、帮助、错误），颜色跟着主题走。 */
  const say = React.useCallback((text, tone) => {
    const screen = screenRef.current
    // 上一条命令没换行就结束时，先自己补一行：提示不该黏在 `100%` 后面
    if (!screen.atLineStart()) screen.write('\n')
    const color = tone === 'error' ? '\x1b[91m' : tone === 'ok' ? '\x1b[92m'
      : tone === 'accent' ? '\x1b[96m' : tone === 'plain' ? '\x1b[0m' : '\x1b[2m'
    screen.write(`${color}${text}\x1b[0m\n`)
    refresh()
  }, [refresh])

  /** 原样写一段：需要自己拼颜色（比如提示行、主机清单）时用，不额外刷一层灰。 */
  const emit = React.useCallback(text => {
    const screen = screenRef.current
    if (!screen.atLineStart()) screen.write('\n')
    screen.write(text)
    refresh()
  }, [refresh])

  const echoPrompt = React.useCallback((line, options) => {
    const screen = screenRef.current
    if (!screen.atLineStart()) screen.write('\n')
    const current = remoteRef.current
    if (current && !options?.local) {
      // 远程提示行换个颜色：一眼就能看出「这条命令发到别人机器上了」
      screen.write(`\x1b[95m${remoteLabel(current)}\x1b[0m`)
      screen.write(`\x1b[2m:${shortPath(current.cwd, current.home)}\x1b[0m`)
      screen.write('$ ')
      screen.write(`${line}\n`)
      refresh()
      return
    }
    // 本机：提示行是我们画的，暗色路径 + 强调色箭头，命令本身用正文色
    if (current) screen.write('\x1b[2m[本机]\x1b[0m ')
    screen.write(`\x1b[2m${shortPath(cwd || info?.cwd || '', info?.home)}\x1b[0m`)
    screen.write(`${info?.platform === 'windows' ? '>' : ' $'} `)
    screen.write(`${line}\n`)
    refresh()
  }, [cwd, info, refresh])

  React.useEffect(() => {
    let alive = true
    setFatal('')
    const stored = readCwd()
    callRef.current('info', { cwd: stored || session?.cwd || '' }).then(value => {
      if (!alive) return
      setInfo(value)
      const next = value.cwd || session?.cwd || ''
      setCwd(next)
      saveCwd(next)
      const screen = screenRef.current
      screen.write(`\x1b[2mworld 终端 · ${value.shell} · ${value.platform === 'windows' ? 'Windows' : 'POSIX'}\x1b[0m\n`)
      screen.write('\x1b[2mhelp 内置命令 · Tab 补全 · Ctrl+R 搜历史 · Ctrl+L 清屏 · ssh <主机> 连远程\x1b[0m\n\n')
      refresh()
    }).catch(error => {
      if (alive) setFatal(String(error?.message || error))
    })
    // 主机清单一进窗口就拉一次：Tab 补全和 `ssh` 空参列表都要用，不该等用户先敲命令
    sshCallRef.current('hosts', {}).then(value => {
      if (!alive) return
      applyHosts(value.hosts || [])
      setSshNote(value.ssh?.available === false ? '这台机器上没找到 ssh 客户端' : '')
    }).catch(() => { if (alive) setSshNote('SSH 服务不可用') })
    return () => { alive = false }
  }, [refresh, session?.id, attempt])

  // 每次窗口重建都贴着底部；人往上翻了就先别抢，等他点「跳到最新」
  React.useEffect(() => {
    if (!stickRef.current) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [frame])

  // 运行中的计时只在状态栏里跳，不写进输出区——那是「现在」而不是「日志」
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!job) return undefined
    const timer = setInterval(() => setTick(value => (value + 1) % 1000), 500)
    return () => clearInterval(timer)
  }, [job])

  const scrollToEnd = () => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    stickRef.current = true
    setStick(true)
  }

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 24
    stickRef.current = atEnd
    if (atEnd !== stick) setStick(atEnd)
  }

  const remember = line => {
    setHistory(list => {
      const next = list.at(-1) === line ? list : [...list, line].slice(-HISTORY_LIMIT)
      saveHistory(next)
      return next
    })
    setCursor(-1)
    // 新命令进来，上一次「按前缀翻历史」的过滤条件就作废了
    prefixRef.current = ''
  }

  /**
   * 队列里的下一条：交回 `submit` 重新解析一遍，而不是直接丢给 shell。
   * 这样排队的 `cd` / `!命令` / 粘贴进来的 `ssh` 都还是原来的语义，
   * 不会因为「上一条跑完时窗口的状态已经变了」而跑到别的地方去。
   */
  const advance = React.useCallback(() => {
    const next = queueRef.current.shift()
    setQueued(queueRef.current.length)
    if (!next) return
    // 注意不要清输入行：排队时就已经清过了，这里再清会吃掉人正在敲的下一条
    void Promise.resolve(submitRef.current?.(next, { queued: true })).finally(() => {
      // `cd` / `pwd` 这类命令不会起任务，队列得自己接着往下走
      if (!jobRef.current && queueRef.current.length) advance()
    })
  }, [])

  /** 任务是本机的还是远端的：poll / cancel 必须回到同一个服务，否则会拿到「任务已回收」。 */
  const pollJob = React.useCallback((record, offset) => (record.route === 'ssh'
    ? sshCallRef.current('poll', { jobId: record.id, offset })
    : callRef.current('poll', { jobId: record.id, offset })), [])

  const cancelJob = React.useCallback(record => (record.route === 'ssh'
    ? sshCallRef.current('cancel', { jobId: record.id })
    : callRef.current('cancel', { jobId: record.id })), [])

  const finish = React.useCallback((polled, record) => {
    const cancelled = polled.cancelled || cancelRef.current
    // 断开时收掉的命令不是「用户按了 Ctrl+C」：别让 logout 看起来像一次中断
    if (cancelled) say(record?.dropped ? '已断开：正在跑的命令一起停了。' : '^C 已中断')
    else if (typeof polled.exitCode === 'number' && polled.exitCode !== 0) {
      say(`↳ 退出码 ${polled.exitCode} · ${formatDuration(polled.durationMs)}`, 'error')
      // ssh 自己出错固定返回 255：这不是远端命令失败，是连接没了
      if (record?.route === 'ssh' && polled.exitCode === 255) {
        say(`ssh 自己退出了 255：连不上或者连接断了。输入 ssh ${remoteRef.current?.alias || '<主机>'} 重连。`)
      }
    } else if (polled.durationMs >= SLOW_MS) say(`↳ 完成 · ${formatDuration(polled.durationMs)}`)
    if (polled.error) say(polled.error, 'error')
    cancelRef.current = false
    setJob(null)
    jobRef.current = null
    advance()
  }, [advance, say])

  /** 轮询到底：命令跑多久就拉多久，直到 `running` 为假。 */
  const drain = React.useCallback(async (record, generation) => {
    let offset = 0
    let lossyNoted = false
    while (generation === generationRef.current) {
      let polled
      try {
        polled = await pollJob(record, offset)
      } catch (error) {
        if (generation !== generationRef.current) return
        say(`连接中断：${String(error?.message || error)}`, 'error')
        setJob(null)
        jobRef.current = null
        return
      }
      if (generation !== generationRef.current) return
      offset = polled.offset
      if (polled.chunk) { screenRef.current.write(polled.chunk); refresh() }
      if (polled.lossy && !lossyNoted) { lossyNoted = true; say('输出太长，前面的部分已被截断。') }
      if (!polled.running) {
        finish(polled, record)
        return
      }
      await sleep(POLL_MS)
    }
  }, [finish, pollJob, refresh, say])

  const execute = React.useCallback(async (line, options) => {
    const generation = generationRef.current
    echoPrompt(line, options)
    const current = remoteRef.current
    // 远程会话里以 `!` 开头的命令走本机（见 submit）：这时即使有连接也不能发到对面
    const route = current && !options?.local ? 'ssh' : 'local'
    let started
    startingRef.current = true
    try {
      started = route === 'ssh'
        ? await sshCallRef.current('run', { target: current.target, options: current.options, cwd: current.cwd, line })
        : await callRef.current('run', { cwd: cwdRef.current || infoRef.current?.cwd || '', line })
    } catch (error) {
      startingRef.current = false
      if (generation !== generationRef.current) return
      say(String(error?.message || error), 'error')
      // 队列由 submit 的 finally 接管：这里再推一次会让两条命令同时起步
      return
    }
    startingRef.current = false
    if (generation !== generationRef.current) return
    const record = { id: started.jobId, startedAt: started.startedAt, route }
    jobRef.current = record
    setJob(record)
    // 远端目录只由 `cd` 改：命令里的 cd 是在子 shell 里跑的，回不到会话上来
    if (route === 'local' && started.cwd && started.cwd !== cwdRef.current) { setCwd(started.cwd); saveCwd(started.cwd) }
    void drain(record, generation)
  }, [drain, echoPrompt, say])

  // 队列与轮询都通过最新的这几个引用调用：useCallback 捕获的是创建那一轮的闭包，
  // 直接互相引用会让「排队的第二条命令」拿到过期的 cwd。
  executeRef.current = execute

  const changeDir = async target => {
    const base = cwd || info?.cwd || ''
    // `cd -` 由窗口记着的上一个目录来解释：交给宿主只会当成一个叫「-」的文件夹
    const want = target === '-' ? previousRef.current : target
    if (target === '-' && !want) { say('还没有上一个目录。'); refresh(); return }
    try {
      const value = await call('chdir', { cwd: base, target: want })
      if (value.cwd !== base) previousRef.current = base
      setCwd(value.cwd)
      saveCwd(value.cwd)
      if (target === '-') say(value.cwd)
    } catch (error) {
      say(String(error?.message || error), 'error')
    }
    refresh()
  }

  const changeRemoteDir = async target => {
    const current = remoteRef.current
    if (!current) return
    const want = target === '-' ? (current.previousCwd || '') : target
    if (target === '-' && !want) { say('还没有上一个远端目录。'); refresh(); return }
    try {
      const value = await sshCall('cd', { target: current.target, options: current.options, cwd: current.cwd, dir: want || '~' })
      applyRemote({ ...current, cwd: value.cwd, previousCwd: value.cwd === current.cwd ? current.previousCwd : current.cwd })
      if (target === '-') say(value.cwd)
    } catch (error) {
      say(String(error?.message || error), 'error')
    }
    refresh()
  }

  /** `ssh` 空参：把配置里的主机列出来，比让人去翻 ~/.ssh/config 现实。 */
  const printHosts = () => {
    const list = hostsRef.current || []
    const screen = screenRef.current
    if (!screen.atLineStart()) screen.write('\n')
    if (!list.length) {
      screen.write('\x1b[2m~/.ssh/config 里还没有主机。\x1b[0m\n')
      screen.write('\x1b[2m直接连一台：ssh 用户名@主机（可加 -p 端口 / -i 密钥）\x1b[0m\n\n')
      return refresh()
    }
    let out = `\x1b[2m~/.ssh/config 里的主机 · ${list.length} 台（Tab 补全别名）\x1b[0m\n`
    for (const host of list.slice(0, 40)) {
      const where = `${host.user ? `${host.user}@` : ''}${host.hostName}${host.port ? `:${host.port}` : ''}`
      out += `  \x1b[96m${host.alias.padEnd(16, ' ')}\x1b[0m\x1b[2m${where}\x1b[0m\n`
    }
    screen.write(`${out}\n`)
    refresh()
  }

  const disconnect = () => {
    const current = remoteRef.current
    if (!current) { say('现在不在远程会话里。'); return }
    const job = jobRef.current
    // 断开就等于把远端会话丢了：还在跑的命令没有地方再输出，顺手收掉并说明白
    if (job) { job.dropped = true; void cancelJob(job).catch(() => {}) }
    const pending = queueRef.current.length
    queueRef.current.length = 0
    setQueued(0)
    applyRemote(null)
    applyTrust('')
    say(`已断开 ${remoteLabel(current)}，回到本机。`, 'ok')
    if (pending) say(`队列里剩下的 ${pending} 条命令也一并丢掉了。`)
  }

  const connect = async parsed => {
    const target = parsed.target
    const live = remoteRef.current
    // 已经连着同一台时再连一次，只会白等一次探测（还可能被服务器当成爆破），先问一句
    if (live && target === live.target) {
      say(`已经连着 ${remoteLabel(live)}；换机器直接 ssh <另一台>，要断开用 logout。`)
      return
    }
    emit(`\x1b[2m正在连接 ${target} …\x1b[0m\n`)
    setBusy(`正在连接 ${target}…`)
    const controller = new AbortController()
    connectRef.current = controller
    let session
    try {
      session = await sshCall('open', { target, options: parsed.options }, controller.signal)
    } catch (error) {
      // 按 Esc / 点了取消：这不是连接失败，别拿一句网络错误去吓人
      if (controller.signal.aborted || error?.code === 'WORLD_SSH_CANCELLED') {
        say(`已取消连接 ${target}。`)
        return
      }
      say(String(error?.message || error), 'error')
      // 只有「主机密钥没见过」是用户能自己解决的：记住这台主机，等他敲 trust
      if (error?.code === 'WORLD_SSH_HOSTKEY') applyTrust(target)
      return
    } finally {
      if (connectRef.current === controller) connectRef.current = null
      setBusy('')
    }
    // 换了一台机器，上一条队列里的命令不该跟着跑过去
    queueRef.current.length = 0
    setQueued(0)
    applyTrust('')
    applyRemote({ ...session, home: session.cwd || '/' })
    const who = `${session.user || 'user'}@${session.hostName}:${session.port}`
    emit(`\x1b[92m✔ 已连接 ${who}\x1b[0m\x1b[2m · ${formatDuration(session.latencyMs)}`
      + `${session.proxyJump ? ` · 经 ${session.proxyJump} 跳转` : ''}\x1b[0m\n`)
    emit('\x1b[2m每条命令单独发到远端；cd 由窗口记着，logout / exit 回本机，!命令 跑本机。'
      + '没有 PTY：密码登录、vim / top 这类交互程序用不了。\x1b[0m\n\n')
  }

  const handleSsh = async rest => {
    const parsed = parseSshCommand(rest)
    if (parsed.error) { say(parsed.error, 'error'); return }
    if (!parsed.target) { printHosts(); return }
    await connect(parsed)
  }

  /** 主机密钥第一次出现时的确认：先把指纹摆出来，写进去之后提醒怎么撤销。 */
  const handleTrust = async () => {
    const host = pendingTrustRef.current
    if (!host) { say('现在没有待确认的主机；连一台新服务器失败之后再输入 trust。'); return }
    say(`读取 ${host} 的主机密钥…`)
    setBusy(`正在读取 ${host} 的主机密钥…`)
    const controller = new AbortController()
    connectRef.current = controller
    try {
      const scanned = await sshCall('key', { target: host }, controller.signal)
      for (const key of scanned.keys) emit(`  \x1b[96m${key.type.padEnd(14, ' ')}\x1b[0m${key.fingerprint}\n`)
      const trusted = await sshCall('trust', { target: host }, controller.signal)
      say(`已写入 ${trusted.added} 条主机密钥到 ${trusted.path}。`, 'ok')
      say(`指纹不对的话立刻撤销：ssh-keygen -R ${host}`)
      applyTrust('')
    } catch (error) {
      if (controller.signal.aborted || error?.code === 'WORLD_SSH_CANCELLED') say('已取消，没有写入任何东西。')
      else say(String(error?.message || error), 'error')
    } finally {
      if (connectRef.current === controller) connectRef.current = null
      setBusy('')
    }
  }

  const printHelp = () => {
    const current = remoteRef.current
    const toolNames = (infoRef.current?.tools || []).map(tool => tool.name)
    const rows = current
      ? [
        ['cd <目录>', '切换远端目录（~ / .. / - 都行）'],
        ['pwd', '显示远端目录'],
        ['!命令', '在当前会话里跑一条本机命令'],
        ['ssh <主机>', '换一台服务器'],
        ['logout / exit', '断开，回到本机'],
        ['clear / cls', '清屏（Ctrl+L）'],
        ['help', '这张表'],
      ]
      : [
        ['cd <目录>', '切换本机工作目录，支持 .. ~ 与 -'],
        ['pwd', '显示当前目录'],
        ['ssh', '列出 ~/.ssh/config 里的主机'],
        ['ssh <主机>', '连远端：ssh web / ssh -p 2222 me@1.2.3.4'],
        ['trust', '首次连接时核对指纹并写进 known_hosts'],
        ...(toolNames.includes('pbnpm') ? [['pbnpm <命令>', 'PowerBuilder 包管理，已经在 PATH 里']] : []),
        ['clear / cls', '清屏（Ctrl+L）'],
        ['open <应用>', '打开桌面上的应用：' + (apps || []).map(app => app.id).slice(0, 6).join(' / ')],
        ['exit', '关闭终端窗口'],
        ['help', '这张表'],
      ]
    screenRef.current.write('\n')
    for (const [name, note] of rows) {
      screenRef.current.write(`\x1b[96m${name.padEnd(16, ' ')}\x1b[0m\x1b[2m${note}\x1b[0m\n`)
    }
    screenRef.current.write(current
      ? '\x1b[2m远端没有 PTY：交互式程序不支持；命令里的 cd 只影响那一条命令。\x1b[0m\n'
        + '\x1b[2mCtrl+R 搜历史 · ↑ 按前缀翻历史 · Ctrl+Shift+C 复制选中 · Ctrl+= 调字号\x1b[0m\n\n'
      : '\x1b[2m其余内容都交给 shell：管道、重定向、&& 都是真的；交互式程序（vim、top）不支持。\x1b[0m\n'
        + '\x1b[2mCtrl+R 搜历史 · ↑ 按前缀翻历史 · Ctrl+Shift+C 复制选中 · Ctrl+= 调字号\x1b[0m\n\n')
    refresh()
  }

  const openAppByName = async name => {
    const list = apps || []
    const wanted = String(name || '').toLowerCase()
    if (!wanted) { say(`用法：open <${list.map(app => app.id).join('|')}>`, 'error'); return }
    const hit = list.find(app => app.id.toLowerCase() === wanted || app.label.toLowerCase() === wanted)
    if (!hit) { say(`没有这个应用：${name}`, 'error'); return }
    say(`正在打开 ${hit.label}…`)
    onOpenApp?.(hit.id)
  }

  /**
   * 关窗口前先说清会丢什么：正在跑的命令会被中断，远程会话会断开。
   * `exit` 与标题栏的关闭键都走这里，免得「手滑关掉」把跑了半天的构建扔掉。
   */
  const requestClose = () => {
    const running = Boolean(jobRef.current) || Boolean(startingRef.current)
    const host = remoteRef.current?.hostName
    if (running || host) {
      const what = [running ? '还有命令在跑，关闭会中断它' : '', host ? `还连着 ${host}，关闭会断开远程会话` : '']
        .filter(Boolean).join('；')
      if (!window.confirm(`${what}。仍要关闭吗？`)) return
    }
    onClose()
  }

  /** 排到队尾：命令还在跑时敲的东西按顺序等着，输出顺序才不会串。 */
  const enqueue = line => {
    queueRef.current.push(line)
    setQueued(queueRef.current.length)
    say(`已排队：${line}（队列 ${queueRef.current.length} 条）`)
    setInput('')
  }

  /**
   * 一行输入 → 该做的事。所有命令都从这里进：队列里的下一条也会回到这里重放，
   * 这样 `cd` / `!命令` / `ssh` 的语义只写在同一个地方。
   * `options.queued` 表示「这是从队列里回来的」：不再记历史，也不再排队。
   */
  const submit = async (raw, options = {}) => {
    const line = String(raw || '').replace(/\r/gu, '').trim()
    if (!line) return
    // 清屏是「看」的事：命令还在跑也该立刻生效，不该排在后面
    if (line === 'clear' || line === 'cls') { screenRef.current.clear(); refresh(); return }
    if (!options.queued) remember(line)
    const busy = (Boolean(jobRef.current) || startingRef.current) && !options.queued

    // 远程会话里 `!命令` 跑本机：查本地文件、看本地端口时不用先 logout 再连回来。
    // 只在连上远程时拦截——本机的 `!` 留给 shell 自己的历史展开。
    if (remoteRef.current && line.startsWith('!')) {
      const local = line.slice(1).trim()
      if (!local) { echoPrompt(line); say('用法：!命令 —— 在远程会话里跑一条本机命令'); return }
      if (busy) { enqueue(line); return }
      await execute(local, { local: true })
      return
    }
    if (/^help$/iu.test(line)) { echoPrompt(line); printHelp(); return }
    if (/^pwd$/iu.test(line)) {
      echoPrompt(line)
      say(remoteRef.current ? remoteRef.current.cwd : (cwd || info?.cwd || ''))
      return
    }
    if (/^exit$/iu.test(line)) {
      echoPrompt(line)
      if (remoteRef.current) disconnect()
      else requestClose()
      return
    }
    if (/^(logout|disconnect)$/iu.test(line)) { echoPrompt(line); disconnect(); return }
    if (/^trust$/iu.test(line)) { echoPrompt(line); await handleTrust(); return }
    const ssh = /^ssh(?:\s+([\s\S]*))?$/iu.exec(line)
    if (ssh) {
      // 换机器是切模式，不是排队能等到的事：要么先说清楚，要么等它一直跑下去都没有结果
      if (busy) {
        say('当前命令还在跑：Ctrl+C 中断它，或者等结束了再连远端。', 'error')
        setInput(line)
        return
      }
      echoPrompt(line)
      await handleSsh((ssh[1] || '').trim())
      return
    }
    const cd = /^cd(?:\s+([\s\S]*))?$/iu.exec(line)
    if (cd) {
      if (busy) { enqueue(line); return }
      echoPrompt(line)
      const target = (cd[1] || '').trim().replace(/^["']|["']$/gu, '')
      if (remoteRef.current) await changeRemoteDir(target)
      else await changeDir(target || info?.home || '')
      return
    }
    const open = /^open(?:\s+([\s\S]*))?$/iu.exec(line)
    if (open) { echoPrompt(line); await openAppByName((open[1] || '').trim()); return }
    // 其余交给 shell：还在跑就排队，等它结束再发
    if (busy) { enqueue(line); return }
    await execute(line)
  }
  submitRef.current = submit

  const complete = async () => {
    // 以输入框里的实际内容为准：刚打完字就按 Tab 时，state 可能还差一拍
    const value = inputRef.current?.value ?? input
    const tokens = value.split(/\s+/u)
    const last = tokens.at(-1) ?? ''
    const head = value.slice(0, value.length - last.length)
    const current = remoteRef.current
    if (tokens.length === 1) {
      const hits = (current ? REMOTE_BUILTINS : BUILTINS).filter(name => name.startsWith(last))
      if (hits.length === 1) { setInput(`${hits[0]} `); return }
      // 多个候选就列出来；继续往下走会去补文件名，那是另一回事
      if (hits.length > 1 && last) { say(hits.join('   ')); return }
    }
    // `ssh <Tab>` 补的是主机别名，不是本机文件名
    if (!current && tokens.length === 2 && HOST_COMMANDS.includes(tokens[0])) {
      const aliases = (hostsRef.current || []).map(host => host.alias).filter(alias => alias.startsWith(last))
      if (aliases.length === 1) { setInput(`${head}${aliases[0]} `); return }
      if (aliases.length > 1) { say(aliases.join('   ')); return }
    }
    let result
    try {
      result = current
        ? await sshCall('complete', { target: current.target, options: current.options, cwd: current.cwd, prefix: last })
        : await call('complete', { cwd: cwd || info?.cwd || '', prefix: last })
    } catch { return }
    const items = result?.items || []
    if (!items.length) return
    const base = result.dir || ''
    // 只有一个候选就直接落进输入行；目录顺手把 `/` 补上，省得再敲一次 Tab
    if (items.length === 1) {
      const item = items[0]
      setInput(`${head}${base}${item.name}${item.type === 'directory' ? '/' : ''}`)
      return
    }
    const names = items.map(item => `${item.name}${item.type === 'directory' ? '/' : ''}`)
    const common = names.reduce((prefix, name) => {
      let next = prefix
      while (next && !name.startsWith(next)) next = next.slice(0, -1)
      return next
    }, names[0])
    const typed = last.slice(base.length)
    if (common.length > typed.length) {
      setInput(`${head}${base}${common}`)
      return
    }
    // 补不动了就把候选列出来，别让人对着一个没反应的 Tab 发呆
    say(names.join('   '))
  }

  const cancel = async () => {
    // 真终端里 Ctrl+C 连正在敲的那一行一起丢掉，排队的命令也不再执行
    setInput('')
    const pending = queueRef.current.length
    if (pending) { queueRef.current.length = 0; setQueued(0) }
    const current = jobRef.current
    if (pending) say(`队列里的 ${pending} 条命令一并丢掉了。`)
    if (!current) return
    cancelRef.current = true
    try { await cancelJob(current) } catch { /* 已经结束就算了 */ }
  }

  const onKeyDown = event => {
    const searching = searchRef.current
    const node = inputRef.current
    // 键盘事件挂在窗口上（不是输入框上）：点过「中断」、拖过滚动条之后，
    // 焦点常常还在别处，但人已经又在打字了。终端不该要求先点一下输入行。
    const inInput = event.target === node
    const selection = window.getSelection?.()?.toString?.() || ''

    // 按钮上的 Enter / 空格是「按下这个按钮」，不能抢
    if (!inInput && (event.key === 'Enter' || event.key === ' ') && event.target?.closest?.('button')) return

    // Ctrl/Cmd + = / - / 0：字号。别让浏览器把整个界面拿去缩放
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['=', '+', '-', '_', '0'].includes(event.key)) {
      event.preventDefault()
      setFontIndex(current => {
        const next = event.key === '0'
          ? FONT_DEFAULT
          : clampFontIndex(current + (event.key === '-' || event.key === '_' ? -1 : 1))
        saveFontIndex(next)
        return next
      })
      return
    }

    // Ctrl+Shift+C 才是复制：终端里 Ctrl+C 得留给「中断」
    if (event.key.toLowerCase() === 'c' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      if (!selection) return
      event.preventDefault()
      void navigator.clipboard?.writeText(selection).catch(() => {})
      return
    }

    // 搜索模式先吃掉自己的键：Enter 接受、Esc 还原、再按 Ctrl+R 继续往前翻
    if (searching) {
      if (event.key === 'Escape') {
        event.preventDefault()
        applySearch(null)
        setInput(draftRef.current)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const hit = searching.hit || ''
        applySearch(null)
        setInput(hit)
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        applySearch(null)
        setInput(searching.hit || '')
        return
      }
      if (event.key === 'r' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        runSearch(searching.query, searching.step + 1)
        return
      }
      if (event.key === 'c' && event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        draftRef.current = ''
        applySearch(null)
        setInput('')
        return
      }
      if (event.key === 'Tab') { event.preventDefault(); return }
      // 其余按键交给输入框：onChange 会把新内容当作搜索词
      return
    }

    // Esc：正在连接 / 读主机密钥这种「一次性等待」可以中断
    if (event.key === 'Escape') {
      if (connectRef.current) { event.preventDefault(); connectRef.current.abort() }
      return
    }

    // 焦点不在输入行时，直接敲字也应该落进输入行（按钮上除外，见上面）
    if (!inInput) {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
        event.preventDefault()
        node?.focus({ preventScroll: true })
        setInput(current => `${current}${event.key}`)
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        node?.focus({ preventScroll: true })
        setInput(current => current.slice(0, -1))
        return
      }
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const value = input
      draftRef.current = ''
      setInput('')
      void submit(value)
      return
    }
    if (event.key === 'Tab') { event.preventDefault(); void complete(); return }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!history.length) return
      if (cursor < 0) { draftRef.current = input; prefixRef.current = input }
      // 已经敲了几个字时只翻「以它开头」的历史，而不是把整条历史都倒出来
      const prefix = prefixRef.current
      let index = cursor + 1
      while (index < history.length && prefix && !history[history.length - 1 - index].startsWith(prefix)) index += 1
      if (index >= history.length) return
      setCursor(index)
      setInput(history[history.length - 1 - index])
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (cursor < 0) return
      const index = cursor - 1
      setCursor(index)
      if (index < 0) prefixRef.current = ''
      setInput(index < 0 ? draftRef.current : history[history.length - 1 - index])
      return
    }
    if (event.key === 'r' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (!history.length) { say('还没有历史命令，先跑一条再来搜。'); return }
      draftRef.current = input
      node?.focus({ preventScroll: true })
      runSearch('')
      return
    }
    if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      screenRef.current.clear()
      refresh()
      return
    }
    if (event.key === 'c' && event.ctrlKey && !event.shiftKey) {
      // 有选区时让浏览器自己复制，否则才是「中断」
      if (selection) return
      event.preventDefault()
      void cancel()
      return
    }
    if (event.key === 'u' && event.ctrlKey) {
      event.preventDefault()
      setInput('')
      return
    }
    if ((event.key === 'a' || event.key === 'e') && event.ctrlKey) {
      event.preventDefault()
      if (!node) return
      const position = event.key === 'a' ? 0 : node.value.length
      node.focus({ preventScroll: true })
      requestAnimationFrame(() => node.setSelectionRange(position, position))
    }
  }

  const onPaste = event => {
    const text = event.clipboardData?.getData('text') || ''
    if (!text.includes('\n')) return
    event.preventDefault()
    const lines = text.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)
    if (!lines.length) return
    // 第一行留在输入行（让人看一眼再回车），其余排队——逐行重放，`cd` 也不会跑偏
    setInput(lines[0])
    if (lines.length > 1) {
      queueRef.current.push(...lines.slice(1))
      setQueued(queueRef.current.length)
      say(`粘贴了 ${lines.length} 行：第一行留在输入行，其余 ${lines.length - 1} 行排在后面。`)
    }
  }

  /**
   * 键盘挂在 document 上，而不是输入框（或窗口节点）上：点过「中断」、标题栏、滚动条之后，
   * 焦点会落到按钮或 body 上，那时再敲字，事件根本不会经过窗口节点。终端要的就是
   * 「在这个窗口里直接敲」——所以只在它是当前窗口时接管，别处的输入框一律不碰。
   */
  keyHandlerRef.current = onKeyDown
  React.useEffect(() => {
    if (!active || minimized) return undefined
    const handler = event => {
      const target = event.target
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing && target !== inputRef.current) return
      keyHandlerRef.current?.(event)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [active, minimized])

  // 关闭 / 卸载时停掉轮询，别让已经关掉的窗口还在后台刷状态
  React.useEffect(() => () => {
    generationRef.current += 1
    if (jobRef.current) void cancelJob(jobRef.current).catch(() => {})
  }, [cancelJob])

  React.useEffect(() => {
    if (active && !minimized) inputRef.current?.focus({ preventScroll: true })
  }, [active, minimized])

  const style = maximized
    ? { '--vscode-x': '0vw', '--vscode-y': '0vh', '--vscode-w': '100vw',
      '--vscode-h': 'calc(100vh - var(--world-desktop-top) - var(--world-taskbar-height))' }
    : { '--vscode-x': `${rect.x}vw`, '--vscode-y': `${rect.y}vh`,
      '--vscode-w': `${rect.w}vw`, '--vscode-h': `${rect.h}vh` }
  if (minimized) style.display = 'none'
  // 字号只作用于输出区与输入行：标题栏、状态栏保持和桌面其它窗口一致
  const fontSize = FONT_SIZES[fontIndex]
  style['--world-term-font-size'] = `${fontSize}px`
  style['--world-term-line-height'] = `${Math.round(fontSize * 1.44 * 2) / 2}px`

  const where = remote ? shortPath(remote.cwd, remote.home) : shortPath(cwd || info?.cwd || '', info?.home)

  return h('section', {
    className: `world-vscode-window world-terminal-window${maximized ? ' is-max' : ''}${remote ? ' is-remote' : ''}`,
    'data-world-app': 'terminal', 'data-world-term-mode': remote ? 'ssh' : 'local',
    'aria-label': '终端', 'aria-hidden': minimized,
    style, onPointerDown: onActivate,
  },
  h('header', {
    className: 'world-vscode-titlebar',
    onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    onDoubleClick: event => { if (!event.target.closest('button')) onToggleMaximize() },
  },
    h('div', { className: 'world-vscode-title' },
      h(TerminalGlyph, { size: 16 }),
      h('span', null, '终端'),
      remote
        ? h('span', { className: 'world-term-badge is-ssh', title: `${remote.hostName}:${remote.port}` }, remoteLabel(remote))
        : info ? h('span', { className: 'world-term-badge', title: info.shellPath || '' }, info.shell) : null,
      remote
        ? h('span', { className: 'world-term-title-path', title: remote.cwd }, where)
        : cwd ? h('span', { className: 'world-term-title-path', title: cwd },
          cwd === info?.home ? '~' : baseName(cwd)) : null),
    h('div', { className: 'world-vscode-controls' },
      h(Cap, { label: '最小化', onClick: onMinimize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('path', { d: 'M0 5h10', stroke: 'currentColor', strokeWidth: 1 }))),
      h(Cap, { label: maximized ? '还原' : '最大化', onClick: onToggleMaximize },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('rect', { x: 0.5, y: 0.5, width: 9, height: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }))),
      h(Cap, { label: '关闭', close: true, onClick: requestClose },
        h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
          h('path', { d: 'M0 0l10 10M10 0L0 10', stroke: 'currentColor', strokeWidth: 1 }))))),
  fatal
    ? h('div', { className: 'world-term-fatal', role: 'status' },
      h('strong', null, '无法打开终端'),
      h('span', null, fatal),
      h('span', null, '终端需要宿主的子进程服务；如果刚开始用，先在 DSH 里打开一个会话。'),
      h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, '重试'))
    : h('div', { className: 'world-term-body' },
      h('div', {
        className: 'world-term-scroll', ref: scrollRef, onScroll,
        // 点输出区是为了继续打字，但不能打断「选中一段输出复制」：松手后再看有没有选区
        onPointerUp: () => {
          requestAnimationFrame(() => {
            const selection = window.getSelection?.()
            if (selection && !selection.isCollapsed) return
            inputRef.current?.focus({ preventScroll: true })
          })
        },
      },
      h('div', { className: 'world-term-screen', 'data-world-term-screen': true },
        frame.trimmed
          ? h('div', { className: 'world-term-line world-term-trimmed' },
            h('span', null, `… 上面还有 ${frame.trimmed} 行已滚出窗口`))
          : null,
        frame.rows.map((runs, index) => h('div', { className: 'world-term-line', key: index },
          runs.length === 0
            ? '\u200b'
            : runs.map((run, offset) => h('span', { key: offset, style: cssOf(run.style) }, run.text)))),
        h('div', { className: 'world-term-line world-term-input-row' },
          h('span', {
            className: `world-term-prompt${remote ? ' is-remote' : ''}${search ? ' is-search' : ''}`,
            title: remote ? `${remote.user}@${remote.hostName}:${remote.port}${remote.cwd}` : cwd,
            'data-world-term-prompt': search ? 'search' : remote ? 'ssh' : 'local',
          }, prompt),
          h('input', {
            ref: inputRef, className: 'world-term-input', value: search ? search.query : input,
            'aria-label': search ? '反向搜索历史命令' : '输入命令',
            spellCheck: false, autoComplete: 'off', autoCapitalize: 'off',
            onChange: event => {
              const value = event.target.value
              // 搜索里每敲一个字都重新找一遍，从最新的一条开始
              if (searchRef.current) { runSearch(value, 0); return }
              setInput(value)
            },
            onPaste,
          }))),
      !stick
        ? h('button', { type: 'button', className: 'world-term-jump', onClick: scrollToEnd }, '跳到最新 ↓')
        : null),
    h('div', { className: 'world-term-status' },
      h('span', { className: 'world-term-status-path', title: remote ? `${remote.hostName}:${remote.port}${remote.cwd}` : cwd },
        remote ? `${remoteLabel(remote)}:${where}` : where),
      h('span', { className: 'world-term-status-right' },
        remote && typeof remote.latencyMs === 'number'
          ? h('span', { className: 'world-term-latency', title: '连接探测耗时，不代表每条命令的速度' },
            `⇅ ${formatDuration(remote.latencyMs)}`)
          : null,
        queued
          ? h('span', { className: 'world-term-queue', title: '这些命令在等当前这条结束' }, `队列 ${queued}`)
          : null,
        busy
          ? h('span', { className: 'world-term-busy' }, busy,
            h('button', { type: 'button', className: 'world-term-break', title: '中断（Esc）',
              onClick: () => connectRef.current?.abort() }, '取消'))
          : search
            ? h('span', { className: 'world-term-search', title: search.hit || '' },
              search.hit ? `↳ ${search.hit}` : '没有匹配的历史')
            : job
              ? h('span', { className: 'world-term-running' },
                h('i', null), `运行中 ${formatDuration(Date.now() - job.startedAt)}`,
                h('button', { type: 'button', className: 'world-term-break', onClick: () => void cancel() }, '中断'))
              : pendingTrust
                ? h('span', { className: 'world-term-trust', title: `核对 ${pendingTrust} 的指纹后写入 known_hosts` },
                  '主机密钥待确认 · 输入 trust')
                : h('span', { className: 'world-term-idle' },
                  sshNote || (isMac() ? '⌘L 清屏 · Ctrl+R 历史' : 'Ctrl+L 清屏 · Ctrl+R 历史'))))),
  !minimized && !maximized
    ? RESIZE_EDGES.map(edge => h('div', {
      key: edge, className: `world-vscode-resize world-vscode-resize-${edge}`, 'aria-hidden': true,
      onPointerDown: onResizeStart(edge), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
    }))
    : null)
}
