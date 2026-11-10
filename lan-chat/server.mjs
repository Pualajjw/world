/**
 * 局域网聊天服务（零第三方依赖）
 *
 * - UDP 广播发现：同一网段里同样启动本服务的 dsh/world 实例会自动出现在通讯录里，
 *   广播里带上检测到的 @local/dsh-world 版本，界面上直接显示对方装的是哪个版本。
 * - HTTP + SSE：页面状态、消息、建群、昵称；消息点对点转发给目标设备，不经过外部服务器。
 * - 本机模型好友：Host 通过 options.models 注入模型目录与 dsh 会话桥接；
 *   每个模型绑定一个真实 dsh 会话，消息 prompt 进去、回复从会话事件流取，上下文由 dsh 维护；
 *   本地发出的消息 @ 到模型时把回答写进聊天，回复不转发到其它设备。独立模式没有这个桥接。
 * - 聊天记录另存：会话 / 消息 / 绑定关系写在 `<home>/lan-chat/state.json`，与 dsh 会话互不依赖。
 * - 独立运行 `node server.mjs`，或由 plugin.js 在 dsh Host 里启动同一个服务。
 */
import dgram from 'node:dgram'
import http from 'node:http'
import { exec } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createStateStore } from './store.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = Number(process.env.LAN_CHAT_PORT || 53317)
const DISCOVERY_PORT = Number(process.env.LAN_CHAT_DISCOVERY_PORT || 53318)
const HELLO_INTERVAL = 3000
const PEER_TTL = 11000
const MAX_TEXT = 2000
const PROTOCOL = 'dsh-world-lan-chat/1'
const LOBBY_ID = 'g-lan-lobby'
const BOT_PREFIX = 'bot:'
const BOT_TIMEOUT_MS = 330_000       // 外层兜底：桥接内部一轮 turn 上限 300s + 重试，这里只防挂死
const BOT_MAX_CONCURRENT = 3
const BOT_REFRESH_INTERVAL = 30_000
const MAX_BOTS_PER_MESSAGE = 4
const MAX_MESSAGES = 300                 // 每个会话在内存 / 磁盘里保留的条数

const STATIC = {
  '/': 'app.html', '/index.html': 'app.html', '/app.html': 'app.html',
  '/app.css': 'app.css', '/app.js': 'app.js', '/markdown.js': 'markdown.js', '/prototype.html': 'prototype.html',
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

function intOf(ip) { return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0) }
function ipOf(value) { return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.') }
function broadcastOf(address, netmask) { return ipOf((intOf(address) & intOf(netmask)) | (~intOf(netmask) >>> 0)) }

function localInterfaces() {
  const result = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      result.push({ name, address: item.address, netmask: item.netmask, broadcast: broadcastOf(item.address, item.netmask) })
    }
  }
  return result
}
function primaryAddress() {
  const list = localInterfaces()
  return (list.find(item => /^192\.168\./.test(item.address)) || list.find(item => /^10\./.test(item.address)) || list[0])?.address || '127.0.0.1'
}
function isLan(remote) {
  const ip = String(remote || '').replace(/^::ffff:/, '')
  return ip === '::1' || ip === '127.0.0.1' || /^192\.168\./.test(ip) || /^10\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip)
}

/** 探测本机是否装了 world 插件：优先看同目录的上一级（源码 / 安装目录），再看常见 profile 位置。 */
function detectWorld() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(ROOT, '..', 'package.json'),
    path.join(home, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-world', 'package.json'),
    path.join(home, 'plugins', 'world', 'package.json'),
  ]
  for (const file of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (manifest?.name === '@local/dsh-world' || manifest?.meta?.title === 'world') {
        return { installed: true, name: '@local/dsh-world', version: String(manifest.version || 'unknown') }
      }
    } catch {}
  }
  return { installed: false, name: '@local/dsh-world', version: 'unknown' }
}

function identityFile() { return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'lan-chat', 'identity.json') }
async function loadIdentity() {
  const file = identityFile()
  try {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (typeof saved.id === 'string' && saved.id && typeof saved.nickname === 'string' && saved.nickname) return saved
  } catch {}
  const identity = { id: randomUUID(), nickname: '我 · ' + os.hostname().slice(0, 12) }
  try { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, JSON.stringify(identity, null, 2), 'utf8') } catch {}
  return identity
}

function cleanText(value, limit) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit)
}
function now() { return Date.now() }
/** 会话 id 太长，界面上只显示前 8 位。 */
function shortSession(id) {
  const value = String(id || '')
  return value ? value.slice(0, 8) : '（未绑定）'
}
function systemMessage(conversationId, text, action) {
  const message = { id: 's-' + randomUUID(), conversationId, from: '', fromName: '', text, at: now(), kind: 'system' }
  if (action && typeof action === 'object') {
    message.action = { type: 'open', conversationId: cleanText(action.conversationId, 80),
      label: cleanText(action.label, 30) || '打开会话' }
  }
  return message
}

function botMemberOf(bot) {
  if (!bot?.id) return null
  return {
    id: cleanText(bot.id, 120), name: cleanText(bot.name, 40) || cleanText(bot.model, 40) || '模型',
    provider: cleanText(bot.provider, 80), model: cleanText(bot.model, 120),
    providerName: cleanText(bot.providerName, 40), ownerId: cleanText(bot.ownerId, 80), bot: true,
  }
}

function botMembersOf(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set(), result = []
  for (const item of value.slice(0, 32)) {
    const member = botMemberOf(item)
    if (!member || !member.id || seen.has(member.id)) continue
    seen.add(member.id); result.push(member)
  }
  return result
}

/** 一个模型好友可以被 @ 的写法：显示名、模型 id、bot id、provider/model。 */
function botAliases(bot) {
  return Array.from(new Set([
    bot?.name, bot?.model, bot?.id,
    bot?.provider && bot?.model ? bot.provider + '/' + bot.model : '',
  ].filter(Boolean).map(String)))
}

/**
 * 找出文本里 @ 到的模型好友。一个位置只认最长匹配，避免 `@模型A` 同时命中
 * 某个更短的同名前缀；多个不同位置可以一次 @ 多个模型。
 */
export function findMentions(text, friends = []) {
  const source = String(text == null ? '' : text)
  const lower = source.toLowerCase()
  const hits = []
  for (const bot of friends) {
    if (!bot?.id) continue
    let best = null
    for (const alias of botAliases(bot).sort((a, b) => b.length - a.length)) {
      const token = '@' + alias
      const index = lower.indexOf(token.toLowerCase())
      if (index < 0) continue
      if (!best || index < best.index || (index === best.index && token.length > best.length)) {
        best = { bot, index, length: token.length }
      }
    }
    if (best) hits.push(best)
  }
  const byIndex = new Map()
  for (const hit of hits) {
    const previous = byIndex.get(hit.index)
    if (!previous || hit.length > previous.length) byIndex.set(hit.index, hit)
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index)
}

export function parseMentions(text, friends = []) {
  return findMentions(text, friends).map(hit => hit.bot)
}

/** 把 @ 提及从给模型的 prompt 里摘掉，剩下的才是真正要干的活。 */
export function mentionPrompt(text, friends = []) {
  let result = String(text == null ? '' : text)
  for (const hit of findMentions(result, friends).sort((a, b) => b.index - a.index)) {
    result = result.slice(0, hit.index) + result.slice(hit.index + hit.length)
  }
  return result.replace(/\s+/g, ' ').trim()
}

export function createLanChatServer(options = {}) {
  const basePort = Number(options.port || DEFAULT_PORT) || DEFAULT_PORT
  const discoveryPort = Number(options.discoveryPort || DISCOVERY_PORT) || DISCOVERY_PORT
  const identity = { id: '', nickname: '' }
  const world = detectWorld()
  // Host 注入的「本机模型好友」桥接：独立模式（start.cmd）没有宿主时为 null，功能自动缺席。
  const friends = options.models || null
  let me = null
  let peers = []
  let bots = []
  let conversations = []
  let messages = Object.create(null)
  const bindings = Object.create(null)   // botId -> dsh sessionId（一个模型同时只绑一个 dsh 会话）
  let udp = null
  let server = null
  let port = 0
  let started = false
  let disposed = false
  const sse = new Set()
  const timers = []
  const pending = Object.create(null)   // conversationId -> 正在思考的模型名数组
  const retrying = Object.create(null)  // conversationId -> { 模型名: { attempt, attempts } }
  const botQueue = []
  const botSignals = new Set()
  const greeted = new Set()             // 已经在这个 dsh 会话里说过开场白的模型会话
  let botRunning = 0
  let botsRefreshing = false
  let announceTicks = 0
  // 发现通道的健康度：UDP 收不到广播时，HTTP 在线通知仍可兜底，并把原因写进诊断。
  const net = {
    startedAt: 0,
    udp: { bound: false, address: '', port: discoveryPort, announced: 0, received: 0,
      lastSentAt: 0, lastReceivedAt: 0, lastError: '' },
    http: { pushed: 0, pushFailed: 0, received: 0, lastPushedAt: 0, lastReceivedAt: 0 },
    rejected: { self: 0, protocol: 0, offLan: 0, malformed: 0 },
  }
  const homeDir = () => options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const store = createStateStore({
    file: () => path.join(homeDir(), 'lan-chat', 'state.json'),
    getState: () => persistable(),
    onWarning: error => { if (options.onWarning) options.onWarning('会话存储: ' + String(error?.message || error)) },
  })

  function hello() {
    return {
      proto: PROTOCOL, type: 'hello', id: me.id, name: me.nickname, machine: os.hostname(),
      ip: me.ip, port, world: me.world, worldInstalled: world.installed, at: now(),
    }
  }

  function ensureLobby() {
    let lobby = conversations.find(item => item.id === LOBBY_ID)
    if (!lobby) {
      lobby = { id: LOBBY_ID, kind: 'group', name: '局域网大厅', icon: '🌐', tone: 'cyan',
        notice: '同一网段的设备会自动出现在大厅里，说声「在吗」试试 📡', memberIds: [me.id], unread: 0, updatedAt: now() }
      conversations.unshift(lobby)
      messages[LOBBY_ID] = [systemMessage(LOBBY_ID, '局域网大厅已就绪')]
    }
    if (!lobby.memberIds.includes(me.id)) lobby.memberIds.unshift(me.id)
    // 模型好友是本机资源，不作为大厅的默认成员；只有显式加入其它群聊后才可被 @。
    lobby.memberIds = lobby.memberIds.filter(id => !String(id).startsWith(BOT_PREFIX))
    lobby.botMembers = []
    lobby.allowOthersMention = false
    for (const peer of peers) if (!lobby.memberIds.includes(peer.id)) lobby.memberIds.push(peer.id)
    return lobby
  }

  /* ------------------------- 落盘 / 读回 ------------------------- */

  /** 写盘用的精简快照：只保留能重建界面的字段，在线状态、正在思考这类瞬态不写。 */
  function persistable() {
    return {
      version: 1,
      savedAt: now(),
      conversations: conversations.slice(0, 60).map(conv => ({
        id: conv.id, kind: conv.kind, name: conv.name, icon: conv.icon, tone: conv.tone,
        peerId: conv.peerId, notice: conv.notice, memberIds: [...conv.memberIds].slice(0, 40),
        botMembers: botMembersOf(conv.botMembers), allowOthersMention: conv.allowOthersMention === true,
        ownerId: cleanText(conv.ownerId, 80), settingsVersion: Math.max(0, Number(conv.settingsVersion) || 0),
        bot: Boolean(conv.bot), ownerBotId: conv.ownerBotId, contextSince: conv.contextSince || 0,
        updatedAt: conv.updatedAt, unread: conv.unread || 0,
      })),
      messages: Object.fromEntries(Object.entries(messages).map(([id, list]) => [id,
        list.slice(-MAX_MESSAGES).map(message => ({
          id: message.id, from: message.from, fromName: message.fromName, text: message.text,
          at: message.at, kind: message.kind, mine: Boolean(message.mine), action: message.action,
        }))])),
      bindings: { ...bindings },
    }
  }

  function restoreMessage(conversationId, raw) {
    const message = {
      id: cleanText(raw?.id, 100) || 'm-' + randomUUID(), conversationId,
      from: cleanText(raw?.from, 80), fromName: cleanText(raw?.fromName, 40),
      text: cleanText(raw?.text, MAX_TEXT), at: Number(raw?.at) || now(),
      kind: raw?.kind === 'system' ? 'system' : 'text',
    }
    if (raw?.mine) message.mine = true
    if (raw?.action?.conversationId) {
      message.action = { type: 'open', conversationId: cleanText(raw.action.conversationId, 80),
        label: cleanText(raw.action.label, 30) || '打开会话' }
    }
    messages[conversationId].push(message)
  }

  /** 重启后把会话 / 消息 / 绑定原样接回来；文件坏了就当没有历史，不影响服务启动。 */
  async function restore() {
    const data = await store.read()
    if (!data) return
    const known = new Set()
    for (const raw of Array.isArray(data.conversations) ? data.conversations : []) {
      const id = cleanText(raw?.id, 80)
      if (!id || known.has(id)) continue
      known.add(id)
      const kind = raw.kind === 'group' ? 'group' : 'direct'
      conversations.push({
        id, kind, name: cleanText(raw.name, 40) || '会话',
        icon: cleanText(raw.icon, 8) || (kind === 'group' ? '💬' : '?'),
        tone: cleanText(raw.tone, 16) || 'blue',
        peerId: cleanText(raw.peerId, 80) || undefined,
        notice: cleanText(raw.notice, 200),
        memberIds: Array.from(new Set([me.id, ...(Array.isArray(raw.memberIds) ? raw.memberIds : [])
          .map(value => cleanText(value, 120)).filter(Boolean)])).slice(0, 40),
        botMembers: botMembersOf(raw.botMembers), allowOthersMention: raw.allowOthersMention === true,
        ownerId: cleanText(raw.ownerId, 80), settingsVersion: Math.max(0, Number(raw.settingsVersion) || 0),
        bot: Boolean(raw.bot),
        ownerBotId: cleanText(raw.ownerBotId, 120) || undefined,
        contextSince: Number(raw.contextSince) || 0,
        unread: 0, updatedAt: Number(raw.updatedAt) || now(),
      })
    }
    for (const [id, list] of Object.entries(data.messages || {})) {
      if (!known.has(id) || !Array.isArray(list)) continue
      messages[id] = messages[id] || []
      for (const raw of list.slice(-MAX_MESSAGES)) restoreMessage(id, raw)
    }
    for (const [botId, sessionId] of Object.entries(data.bindings || {})) {
      const bot = cleanText(botId, 120), sid = cleanText(sessionId, 120)
      if (bot.startsWith(BOT_PREFIX) && sid) bindings[bot] = sid
    }
  }

  function snapshot() {
    ensureLobby()
    const seen = Object.create(null)
    for (const [id, list] of Object.entries(messages)) seen[id] = list.slice(-MAX_MESSAGES)
    return {
      me: { ...me },
      peers: peers.map(peer => ({ ...peer, online: peer.online && now() - peer.lastSeen < PEER_TTL })),
      network: networkSnapshot(),
      bots: bots.map(bot => ({ ...bot, sessionId: bindings[bot.id] || '' })).map(bot => ({ ...bot })),
      bindings: { ...bindings },
      pending: Object.fromEntries(Object.entries(pending).map(([id, names]) => [id, [...names]])),
      retrying: Object.fromEntries(Object.entries(retrying).map(([id, table]) =>
        [id, Object.entries(table).map(([name, info]) => ({ name, attempt: info.attempt, attempts: info.attempts }))])),
      conversations: conversations.map(conv => ({ ...conv, memberIds: [...conv.memberIds] })),
      messages: seen,
    }
  }

  function broadcast() {
    const payload = 'data: ' + JSON.stringify({ type: 'state', state: snapshot() }) + '\n\n'
    for (const res of sse) { try { res.write(payload) } catch { sse.delete(res) } }
  }
  function stateChanged() { broadcast() }

  /* --------------------- 本机模型好友 --------------------- */

  function warn(error) {
    if (options.onWarning) options.onWarning('模型好友: ' + String(error?.message || error))
  }

  /** 从宿主重新拉一次模型目录；模型增删/改名后 30 秒内自动生效。 */
  async function refreshBots() {
    if (!friends?.list || disposed || botsRefreshing) return
    botsRefreshing = true
    try {
      let list
      try { list = await friends.list() } catch (error) { warn(error); return }
      if (disposed) return
      const seen = new Set()
      const next = []
      for (const item of Array.isArray(list) ? list : []) {
        const id = cleanText(item?.id, 120)
        if (!id || seen.has(id)) continue
        seen.add(id)
        next.push({
          id, provider: cleanText(item.provider, 80), model: cleanText(item.model, 120),
          name: cleanText(item.name, 40) || cleanText(item.model, 40) || '模型',
          description: cleanText(item.description, 200), providerName: cleanText(item.providerName, 40),
          machine: '本机模型', ip: '127.0.0.1', world: '本机', online: true, bot: true,
        })
      }
      const fingerprint = rows => rows.map(row => row.id + '|' + row.name + '|' + row.provider).join('\n')
      const changed = fingerprint(next) !== fingerprint(bots)
      bots = next
      // 模型好友不自动进入大厅；只有显式选择才会成为群成员。
      ensureLobby()
      if (changed) stateChanged()
    } finally { botsRefreshing = false }
  }

  function setPending(conversationId, name, active) {
    const list = pending[conversationId] || (pending[conversationId] = [])
    const index = list.indexOf(name)
    if (active && index < 0) list.push(name)
    if (!active && index >= 0) list.splice(index, 1)
    if (!list.length) delete pending[conversationId]
    stateChanged()
  }

  /** 重试状态只影响输入框上方那行提示，不进消息流，避免刷屏。 */
  function setRetrying(conversationId, name, info) {
    const table = retrying[conversationId] || (retrying[conversationId] = Object.create(null))
    if (info) table[name] = { attempt: info.attempt, attempts: info.attempts }
    else delete table[name]
    if (!Object.keys(table).length) delete retrying[conversationId]
    stateChanged()
  }

  /* --------------------- 模型 ⇄ dsh 会话 --------------------- */

  function sessionOf(botId) { return String(bindings[botId] || '') }

  function forgetBotSession(bot) {
    const previous = sessionOf(bot.id)
    delete bindings[bot.id]
    delete bot.sessionId
    if (previous) greeted.delete(previous)
    store.schedule()
    stateChanged()
  }

  /**
   * 取这个模型绑定的 dsh 会话；没绑定或会话已经没了，就现建一个。
   * 参数是模型 id（好友目录里的那一行），建好后记进 bindings 并落盘。
   */
  async function ensureBotSession(bot) {
    if (!friends?.createSession) throw new Error('宿主没有提供 dsh 会话能力，模型好友不能干活')
    const existing = sessionOf(bot.id)
    if (existing) {
      const alive = friends.hasSession ? await friends.hasSession(existing).catch(() => false) : true
      if (alive) return existing
      delete bindings[bot.id]
    }
    const sessionId = await friends.createSession({
      provider: bot.provider, model: bot.model,
      title: '局域网聊天 · ' + bot.name,
    })
    bindings[bot.id] = sessionId
    bot.sessionId = sessionId
    store.schedule()
    stateChanged()
    return sessionId
  }

  /** 手动绑定到一个已有 dsh 会话（用户在 dsh 里挑的那个）。 */
  function bindBot(bot, sessionId) {
    const id = cleanText(sessionId, 120)
    if (!id) return false
    bindings[bot.id] = id
    bot.sessionId = id
    greeted.delete(id)
    store.schedule()
    stateChanged()
    return true
  }

  /**
   * 每轮送进 dsh 会话的正文。世界观提示词不用在这里拼 —— 那个会话本身有完整的系统提示词；
   * 这里只补一句「你现在在局域网聊天里」，让模型知道这句话从哪来、回复给谁看。
   */
  function buildBotPrompt(conv, bot, text, intro, speaker) {
    const head = [
      '【局域网聊天】你在 dsh world 的「局域网聊天」里扮演模型好友「' + bot.name + '」。',
      '当前聊天：' + (conv.name || '未命名') + (conv.kind === 'group' ? '（群聊）' : '（私聊）'),
      '发言人：' + (speaker || me.nickname + '（本机用户）'),
      intro ? '这是你在这个聊天里收到的第一句话，之后接着这里说，不用重复自我介绍。' : '',
      '回复会原样显示在聊天气泡里：直接给结论，不要复述这段说明。',
    ].filter(Boolean).join('\n')
    return head + '\n\n' + text
  }

  /** 真正跑模型：确保会话存在 → prompt 进去 → 等 dsh 把这一轮跑完。 */
  async function attemptBot(conv, bot, text, speaker) {
    if (disposed) throw new Error('聊天服务已停止')
    const sessionId = await ensureBotSession(bot)
    if (disposed) throw new Error('聊天服务已停止')
    const intro = !greeted.has(sessionId)
    const prompt = buildBotPrompt(conv, bot, text, intro, speaker)
    const controller = new AbortController()
    botSignals.add(controller)
    const timer = setTimeout(() => controller.abort(new Error('模型调用超时')), BOT_TIMEOUT_MS)
    try {
      const reply = await friends.ask({
        sessionId, text: prompt, signal: controller.signal,
        // 桥接自己会退避重试，这里只把「第几次」透出给界面
        onRetry: info => { if (!disposed) setRetrying(conv.id, bot.name, info) },
      })
      greeted.add(sessionId)
      return reply
    } finally {
      clearTimeout(timer)
      botSignals.delete(controller)
    }
  }

  async function runBotTask(conv, bot, text, speaker) {
    setPending(conv.id, bot.name, true)
    try {
      const reply = await attemptBot(conv, bot, text, speaker)
      if (disposed) return
      appendMessage(conv, { id: 'bot-' + randomUUID(), from: bot.id, fromName: bot.name,
        text: cleanText(reply, MAX_TEXT), at: now(), kind: 'text' })
    } catch (error) {
      if (disposed) return
      const tried = Number(error?.attempts) > 1 ? Number(error.attempts) : 0
      const prefix = tried ? '「' + bot.name + '」重试 ' + tried + ' 次仍失败：' : '「' + bot.name + '」没能回复：'
      appendMessage(conv, { id: 'boterr-' + randomUUID(), from: '', fromName: '',
        text: prefix + cleanText(error?.message || error, 220), at: now(), kind: 'system' })
    } finally {
      setRetrying(conv.id, bot.name, null)
      setPending(conv.id, bot.name, false)
    }
  }

  function pumpBotTasks() {
    while (!disposed && botRunning < BOT_MAX_CONCURRENT && botQueue.length) {
      const task = botQueue.shift()
      botRunning += 1
      Promise.resolve().then(task).catch(error => warn(error)).finally(() => { botRunning -= 1; pumpBotTasks() })
    }
  }

  /** 只有本机模型好友被明确邀请入群后才响应；其他成员能否 @ 由群设置控制。 */
  async function handleBotMentions(conv, text, { remote = false, sender = '' } = {}) {
    if (!friends?.ask || disposed || !bots.length) return
    if (conv.kind === 'group' && remote && conv.allowOthersMention !== true) return
    const eligible = conv.kind === 'group'
      ? bots.filter(bot => (conv.memberIds || []).includes(bot.id)
        && botMembersOf(conv.botMembers).some(member => member.id === bot.id && member.ownerId === me.id))
      : bots
    const hits = findMentions(text, eligible)
    const direct = conv.kind === 'direct' && String(conv.peerId || '').startsWith(BOT_PREFIX)
      ? eligible.find(row => row.id === conv.peerId) : null
    const chosen = []
    for (const hit of hits) if (!chosen.some(row => row.id === hit.bot.id)) chosen.push(hit.bot)
    // 私聊某个模型时不用 @ 也能派活；但一旦显式 @ 了别人，就只让被 @ 的模型回答。
    if (!chosen.length && direct) chosen.push(direct)
    if (!chosen.length) return
    const prompt = mentionPrompt(text, chosen.slice(0, MAX_BOTS_PER_MESSAGE)) || cleanText(text, MAX_TEXT)
    const speaker = remote && sender ? cleanText(sender, 24) + '（群成员）' : ''
    for (const bot of chosen.slice(0, MAX_BOTS_PER_MESSAGE)) {
      botQueue.push(() => runBotTask(conv, bot, prompt, speaker))
    }
    pumpBotTasks()
  }

  function sendJson(res, code, body) {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
    res.end(text)
  }
  async function readJson(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 64 * 1024) throw new Error('请求体过大')
    }
    const value = JSON.parse(raw || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
    return value
  }

  function upsertConversation(candidate, fallbackId) {
    const id = cleanText(candidate?.id || fallbackId, 80)
    if (!id) return null
    let conv = conversations.find(item => item.id === id)
    if (!conv) {
      conv = { id, kind: candidate?.kind === 'group' ? 'group' : 'direct',
        name: cleanText(candidate?.name || '新会话', 40) || '新会话', icon: cleanText(candidate?.icon || '💬', 8),
        tone: cleanText(candidate?.tone || 'blue', 16), peerId: cleanText(candidate?.peerId, 80) || undefined,
        notice: cleanText(candidate?.notice, 200), memberIds: [me.id], botMembers: botMembersOf(candidate?.botMembers),
        allowOthersMention: candidate?.allowOthersMention === true, ownerId: cleanText(candidate?.ownerId, 80),
        settingsVersion: Math.max(0, Number(candidate?.settingsVersion) || 0),
        unread: 0, updatedAt: now() }
      conversations.unshift(conv)
      messages[id] = messages[id] || []
    }
    for (const memberId of Array.isArray(candidate?.memberIds) ? candidate.memberIds.slice(0, 40) : []) {
      const value = cleanText(memberId, 120)
      if (value && !conv.memberIds.includes(value)) conv.memberIds.push(value)
    }
    const incomingBots = botMembersOf(candidate?.botMembers)
    if (incomingBots.length) {
      const byId = new Map(botMembersOf(conv.botMembers).map(item => [item.id, item]))
      for (const bot of incomingBots) byId.set(bot.id, bot)
      conv.botMembers = [...byId.values()].slice(0, 32)
    }
    const incomingSettingsVersion = Math.max(0, Number(candidate?.settingsVersion) || 0)
    if (typeof candidate?.allowOthersMention === 'boolean'
      && (incomingSettingsVersion > (Number(conv.settingsVersion) || 0)
        || (incomingSettingsVersion === 0 && conv.allowOthersMention === undefined))) {
      conv.allowOthersMention = candidate.allowOthersMention
      conv.settingsVersion = incomingSettingsVersion
    }
    if (!conv.ownerId && candidate?.ownerId) conv.ownerId = cleanText(candidate.ownerId, 80)
    if (candidate?.name && conv.name !== candidate.name && !candidate.localOnly) conv.name = cleanText(candidate.name, 40)
    store.schedule()
    return conv
  }

  function appendMessage(conv, message) {
    if (!conv || !message || typeof message.text !== 'string') return
    const id = cleanText(message.id, 100) || 'm-' + randomUUID()
    const list = messages[conv.id] || (messages[conv.id] = [])
    if (list.some(item => item.id === id)) return
    const row = { id, conversationId: conv.id, from: cleanText(message.from, 80),
      fromName: cleanText(message.fromName, 40), text: cleanText(message.text, MAX_TEXT),
      at: Number(message.at) || now(), kind: message.kind === 'system' ? 'system' : 'text' }
    if (message.mine) row.mine = true
    if (message.action?.conversationId) {
      row.action = { type: 'open', conversationId: cleanText(message.action.conversationId, 80),
        label: cleanText(message.action.label, 30) || '打开会话' }
    }
    list.push(row)
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES)
    conv.updatedAt = row.at
    store.schedule()
  }

  function targetsFor(conv) {
    if (!conv) return []
    const ids = conv.kind === 'direct' ? [conv.peerId] : conv.memberIds
    return ids.map(id => peers.find(peer => peer.id === id && peer.online)).filter(Boolean)
  }
  function forward(peer, packet) {
    if (!peer?.ip || !peer?.port) return
    const body = JSON.stringify(packet)
    const req = http.request({ host: peer.ip, port: peer.port, path: '/api/receive', method: 'POST', timeout: 2500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => res.resume())
    req.on('error', () => {})
    req.on('timeout', () => req.destroy())
    req.end(body)
  }

  /** 同机多实例 / UDP 广播被拦截时的补充通道：探测本机邻近端口的 /api/ping。 */
  function localProbe() {
    if (!me) return
    for (let candidate = basePort; candidate < basePort + 12; candidate++) {
      if (candidate === port) continue
      const req = http.get({ host: '127.0.0.1', port: candidate, path: '/api/ping', timeout: 350 }, res => {
        let raw = ''
        res.on('data', chunk => { raw += chunk; if (raw.length > 4096) req.destroy() })
        res.on('end', () => {
          let data
          try { data = JSON.parse(raw) } catch { return }
          const peerId = cleanText(data?.id, 100)
          if (!peerId || peerId === me.id || !Number.isInteger(data?.port)) return
          const existing = peers.find(item => item.id === peerId)
          if (existing) {
            existing.lastSeen = now()
            if (!existing.online) { existing.online = true; stateChanged() }
            return
          }
          peers.push({ id: peerId, name: cleanText(data.nickname, 24) || '本机另一实例',
            machine: cleanText(data.machine, 60) || '127.0.0.1', ip: '127.0.0.1', port: data.port,
            world: cleanText(data.world, 60) || world.name, worldInstalled: Boolean(data.worldInstalled),
            online: true, lastSeen: now() })
          stateChanged()
        })
      })
      req.on('error', () => {})
      req.on('timeout', () => req.destroy())
    }
  }

  function announce() {
    if (!udp || !me) return
    announceTicks++
    net.udp.lastSentAt = now()
    const body = Buffer.from(JSON.stringify(hello()))
    const targets = new Set(['255.255.255.255', ...localInterfaces().map(item => item.broadcast)])
    for (const target of targets) {
      try {
        net.udp.announced++
        udp.send(body, discoveryPort, target, error => { if (error) net.udp.lastError = String(error?.message || error) })
      } catch (error) { net.udp.lastError = String(error?.message || error) }
    }
    // 对方防火墙只拦 UDP 入站时，广播永远到不了；每两次广播用 HTTP 再把「我在」推给已认识的设备。
    if (announceTicks % 2 === 0) for (const peer of peers) pushPresence(peer)
  }

  function upsertPeer(record) {
    const index = peers.findIndex(item => item.id === record.id)
    const previous = index >= 0 ? peers[index] : null
    const changed = !previous || !previous.online || previous.name !== record.name || previous.ip !== record.ip
      || previous.port !== record.port || previous.world !== record.world || previous.via !== record.via
    if (index >= 0) peers[index] = record
    else peers.push(record)
    for (const conv of conversations) if (conv.kind === 'direct' && conv.peerId === record.id) conv.name = record.name
    if (changed) stateChanged()
    return { previous, changed }
  }

  /** 把 UDP/HTTP 收到的那份身份统一成 peer 记录；来源地址以 socket 为准，不信任 payload 里的 ip。 */
  function peerRecord(packet, address, via = 'udp') {
    if (packet?.proto !== PROTOCOL) { net.rejected.protocol++; return null }
    if (!packet.id) { net.rejected.protocol++; return null }
    if (packet.id === me?.id) { net.rejected.self++; return null }
    const ip = String(address || '').replace(/^::ffff:/, '')
    if (!isLan(ip)) { net.rejected.offLan++; return null }
    const portNumber = Number(packet.port)
    return {
      id: cleanText(packet.id, 80), name: cleanText(packet.name, 24) || '未命名设备',
      machine: cleanText(packet.machine, 60) || ip, ip,
      port: Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536 ? portNumber : basePort,
      world: cleanText(packet.world, 60) || '@local/dsh-world', worldInstalled: Boolean(packet.worldInstalled),
      online: true, lastSeen: now(), via,
    }
  }

  function pushPresence(peer) {
    if (!peer?.ip || !peer?.port) return
    net.http.lastPushedAt = now()
    const body = JSON.stringify({ ...hello(), type: 'presence' })
    const req = http.request({ host: peer.ip, port: peer.port, path: '/api/presence', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume()
      if (res.statusCode >= 200 && res.statusCode < 300) net.http.pushed++
      else net.http.pushFailed++
    })
    req.on('error', () => { net.http.pushFailed++ })
    req.on('timeout', () => { net.http.pushFailed++; req.destroy() })
    req.end(body)
  }

  function onUdpMessage(buffer, rinfo) {
    let packet
    try { packet = JSON.parse(buffer.toString('utf8')) } catch { net.rejected.malformed++; return }
    if (packet?.proto !== PROTOCOL || !packet.id) { net.rejected.protocol++; return }
    const address = String(rinfo.address || '').replace(/^::ffff:/, '')
    if (!isLan(address)) { net.rejected.offLan++; return }
    if (packet.id === me?.id) { net.rejected.self++; return }
    if (packet.type === 'bye') {
      const peer = peers.find(item => item.id === packet.id)
      if (peer && peer.online) { peer.online = false; stateChanged() }
      return
    }
    if (packet.type !== 'hello') return
    const record = peerRecord(packet, address)
    if (!record) return
    net.udp.received++
    net.udp.lastReceivedAt = now()
    const { previous } = upsertPeer(record)
    // 新邻居：UDP 回一声让对方立刻看到我；同时用 HTTP 再通知一次，UDP 入站被防火墙拦截时也不会变成单向可见。
    if (!previous) {
      try { udp.send(Buffer.from(JSON.stringify(hello())), discoveryPort, record.ip) } catch {}
      pushPresence(record)
    }
  }

  function inboundAt() {
    return Math.max(net.udp.lastReceivedAt || 0, net.http.lastReceivedAt || 0)
  }

  function networkWarnings() {
    const warnings = []
    if (!net.udp.bound) {
      warnings.push(`本机 UDP ${discoveryPort} 未绑定成功${net.udp.lastError ? `：${net.udp.lastError}` : ''}；请检查端口是否被另一个实例占用，或运行账号是否有权限。`)
    } else if (net.startedAt && now() - inboundAt() > 15000) {
      warnings.push(`启动后还没收到局域网广播。请确认防火墙放行 UDP ${discoveryPort} 入站（Kylin 安全中心 / Windows 防火墙），并确认双方在同一网段。`)
    }
    if (peers.length > 0 && net.http.pushed === 0 && net.http.pushFailed > 0) {
      warnings.push(`已发现设备，但 HTTP 在线通知一直失败；请检查对方 TCP ${basePort} 入站是否放行。`)
    }
    return warnings
  }

  function networkSnapshot() {
    return {
      discoveryPort, httpPort: port, udpBound: net.udp.bound, udpError: net.udp.lastError,
      lastInboundAt: inboundAt() || null, lastUdpAt: net.udp.lastReceivedAt || null, lastHttpAt: net.http.lastReceivedAt || null,
      announced: net.udp.announced, httpPushed: net.http.pushed, httpPushFailed: net.http.pushFailed,
      onlinePeers: peers.filter(peer => peer.online && now() - peer.lastSeen < PEER_TTL).length,
      warnings: networkWarnings(),
    }
  }

  function diagnostics() {
    return {
      generatedAt: now(), startedAt: net.startedAt, id: me?.id || '', nickname: me?.nickname || '',
      machine: os.hostname(), ips: localInterfaces().map(item => ({ name: item.name, address: item.address, broadcast: item.broadcast })),
      discoveryPort, httpPort: port, udp: { ...net.udp }, http: { ...net.http }, rejected: { ...net.rejected },
      peers: peers.map(peer => ({ ...peer, online: peer.online && now() - peer.lastSeen < PEER_TTL })),
      warnings: networkWarnings(),
    }
  }

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      void refreshBots()   // 打开窗口 / 点「刷新」时顺带同步模型目录，完成后由 SSE 推新状态
      return sendJson(res, 200, snapshot())
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') return sendJson(res, 200, {
      ok: true, id: me.id, port, world: me.world, nickname: me.nickname, machine: me.machine, worldInstalled: world.installed,
    })
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      if (!isLan(req.socket.remoteAddress)) return sendJson(res, 403, { error: '只接受局域网请求' })
      return sendJson(res, 200, diagnostics())
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
      res.write(': connected\n\n')
      sse.add(res)
      const keep = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(keep); sse.delete(res) })
      return
    }
    // dsh 里已有的会话列表，给「绑定到会话」用
    if (req.method === 'GET' && url.pathname === '/api/bots/sessions') {
      if (!friends?.listSessions) return sendJson(res, 200, { items: [], available: false })
      let items = []
      try { items = await friends.listSessions() } catch (error) {
        return sendJson(res, 500, { error: cleanText(error?.message || error, 200), items: [] })
      }
      const taken = Object.fromEntries(Object.entries(bindings))
      return sendJson(res, 200, { items: items.map(item => ({ ...item,
        botId: Object.keys(taken).find(id => taken[id] === item.id) || '' })), available: true })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 GET / POST' })
    if (!isLan(req.socket.remoteAddress)) return sendJson(res, 403, { error: '只接受局域网请求' })

    let body
    try { body = await readJson(req) } catch (error) { return sendJson(res, 400, { error: error.message }) }

    // HTTP 在线通知：UDP 广播被对端防火墙拦截时，已发现设备仍可通过 TCP 看到「我在」。
    if (url.pathname === '/api/presence') {
      const record = peerRecord(body, req.socket.remoteAddress, 'http')
      if (!record) return sendJson(res, 400, { error: '在线通知无效' })
      net.http.received++
      net.http.lastReceivedAt = now()
      upsertPeer(record)
      return sendJson(res, 200, { ok: true, id: me.id, port, nickname: me.nickname })
    }

    if (url.pathname === '/api/profile') {
      const nickname = cleanText(body.nickname, 24)
      if (!nickname) return sendJson(res, 400, { error: '昵称不能为空' })
      identity.nickname = nickname
      me.nickname = nickname
      try { await fsp.writeFile(identityFile(), JSON.stringify(identity, null, 2), 'utf8') } catch {}
      announce(); stateChanged()
      return sendJson(res, 200, { ok: true, state: snapshot() })
    }

    if (url.pathname === '/api/read') {
      const conv = conversations.find(item => item.id === body.conversationId)
      if (conv && conv.unread) { conv.unread = 0; store.schedule() }
      return sendJson(res, 200, { ok: true, state: snapshot() })
    }

    // 把某个模型绑定到会话（传空 conversationId 就是解绑）
    if (url.pathname === '/api/bind') {
      const bot = bots.find(item => item.id === cleanText(body.botId, 120))
      if (!bot) return sendJson(res, 400, { error: '这个模型不在本机模型目录里' })
      const sessionId = cleanText(body.sessionId, 120)
      if (!sessionId) {
        forgetBotSession(bot)
        return sendJson(res, 200, { ok: true, state: snapshot() })
      }
      const alive = friends?.hasSession ? await friends.hasSession(sessionId).catch(() => false) : true
      if (!alive) return sendJson(res, 400, { error: '这个 dsh 会话不存在或已经删除' })
      bindBot(bot, sessionId)
      return sendJson(res, 200, { ok: true, sessionId, state: snapshot() })
    }

    // 清空上下文 = 给这个模型换一个全新的 dsh 会话；聊天记录一条都不删
    if (url.pathname === '/api/context/reset') {
      const bot = bots.find(item => item.id === cleanText(body.botId, 120))
        || bots.find(item => item.id === conversations.find(conv => conv.id === cleanText(body.conversationId, 80))?.ownerBotId)
      if (!bot) return sendJson(res, 400, { error: '这个模型不在本机模型目录里' })
      if (!friends?.createSession) return sendJson(res, 400, { error: '宿主没有提供 dsh 会话能力' })
      try {
        const sessionId = await friends.createSession({
          provider: bot.provider, model: bot.model, title: '局域网聊天 · ' + bot.name,
        })
        bindBot(bot, sessionId)
        const conv = conversations.find(item => item.id === cleanText(body.conversationId, 80))
        if (conv) appendMessage(conv, systemMessage(conv.id,
          '「' + bot.name + '」换了一个新会话，上下文从头开始；这里的历史消息仍然保留'))
        return sendJson(res, 200, { ok: true, sessionId, state: snapshot() })
      } catch (error) {
        return sendJson(res, 500, { error: cleanText(error?.message || error, 200) })
      }
    }

    if (url.pathname === '/api/send') {
      const conv = conversations.find(item => item.id === body.conversationId)
      const text = cleanText(body.text, MAX_TEXT)
      if (!conv || !text) return sendJson(res, 400, { error: '会话不存在或消息为空' })
      const message = { id: 'm-' + randomUUID(), conversationId: conv.id, from: me.id, fromName: me.nickname,
        text, at: now(), kind: 'text', mine: true }
      appendMessage(conv, message)
      const packet = { type: 'message', from: me, conversation: { ...conv, localOnly: true }, message }
      for (const peer of targetsFor(conv)) forward(peer, packet)
      stateChanged()
      // 模型回复只落在本机：不转发给其它设备，否则对端也会解析 @ 再跑一次模型。
      void handleBotMentions(conv, text).catch(error => warn(error))
      return sendJson(res, 200, { ok: true, state: snapshot() })
    }

    if (url.pathname === '/api/conversations') {
      const kind = body.kind === 'group' ? 'group' : 'direct'
      let conv, id
      // 给某个模型单独开一个聊天窗口，并把它绑定的 dsh 会话建好（新窗口仍共用同一个 dsh 会话）
      if (body.kind === 'bot') {
        const bot = bots.find(item => item.id === cleanText(body.botId, 120))
        if (!bot) return sendJson(res, 400, { error: '这个模型不在本机模型目录里' })
        const name = cleanText(body.name, 30) || bot.name
        id = 'b-' + randomUUID().slice(0, 8)
        conv = { id, kind: 'direct', peerId: bot.id, name, icon: '🤖', tone: 'blue', bot: true,
          ownerBotId: bot.id, memberIds: [me.id, bot.id], unread: 0, updatedAt: now(),
          notice: '模型会话：上下文接着它绑定的那个 dsh 会话' }
        conversations.unshift(conv)
        messages[id] = [systemMessage(id, '已为「' + bot.name + '」创建会话「' + name + '」')]
        try {
          const sessionId = await ensureBotSession(bot)
          messages[id].push(systemMessage(id, '上下文在 dsh 会话 ' + shortSession(sessionId) + ' 里，重启 dsh 后照样接着聊'))
        } catch (error) {
          messages[id].push(systemMessage(id, '暂时没能建 dsh 会话：' + cleanText(error?.message || error, 160)))
        }
        store.schedule()
        stateChanged()
        return sendJson(res, 200, { ok: true, id, sessionId: sessionOf(bot.id), state: snapshot() })
      }
      if (kind === 'direct') {
        const peer = peers.find(item => item.id === body.peerId)
        const bot = bots.find(item => item.id === body.peerId)
        if (!peer && !bot) return sendJson(res, 400, { error: '该设备不在线' })
        const target = peer || bot
        id = 'd-' + target.id
        conv = conversations.find(item => item.id === id)
        if (!conv) {
          conv = { id, kind: 'direct', peerId: target.id, name: target.name,
            icon: bot ? '🤖' : target.name.slice(0, 1), tone: 'blue',
            ...(bot ? { bot: true } : {}), memberIds: [me.id, target.id], unread: 0, updatedAt: now() }
          conversations.unshift(conv)
          messages[id] = [systemMessage(id, bot
            ? '已连接本机模型「' + bot.name + '」，直接发消息或 @ 它就能让它干活'
            : '已连接，可以开始私聊了')]
        }
      } else {
        const name = cleanText(body.name, 30)
        if (!name) return sendJson(res, 400, { error: '群聊名称不能为空' })
        const memberIds = Array.from(new Set((Array.isArray(body.memberIds) ? body.memberIds : [])
          .map(value => cleanText(value, 80)).filter(value => value && value !== me.id && peers.some(peer => peer.id === value)))).slice(0, 32)
        const invitedBotIds = Array.from(new Set((Array.isArray(body.botIds) ? body.botIds : [])
          .map(value => cleanText(value, 120)).filter(Boolean))).slice(0, 32)
        const invitedBots = invitedBotIds.map(id => bots.find(bot => bot.id === id)).filter(Boolean)
        if (invitedBotIds.length !== invitedBots.length) return sendJson(res, 400, { error: '只能邀请本机模型好友' })
        if (!memberIds.length && !invitedBots.length) return sendJson(res, 400, { error: '至少邀请一位成员或模型好友' })
        if (memberIds.length + invitedBots.length > 39) return sendJson(res, 400, { error: '群聊最多邀请39位成员' })
        id = 'g-' + randomUUID().slice(0, 8)
        conv = { id, kind: 'group', name, icon: '💬', tone: 'purple', notice: '欢迎加入新群聊 🎉',
          memberIds: [me.id, ...memberIds, ...invitedBots.map(bot => bot.id)],
          botMembers: invitedBots.map(bot => botMemberOf({ ...bot, ownerId: me.id })),
          allowOthersMention: body.allowOthersMention === true, ownerId: me.id, settingsVersion: 1, unread: 0, updatedAt: now() }
        conversations.unshift(conv)
        messages[id] = [systemMessage(id, '你创建了群聊「' + name + '」')]
        for (const bot of invitedBots) appendMessage(conv, systemMessage(id, '模型好友「' + bot.name + '」已加入群聊'))
        for (const peer of targetsFor(conv)) forward(peer, { type: 'conversation', from: me, conversation: conv, message: systemMessage(id, '你被邀请加入群聊「' + name + '」') })
      }
      stateChanged()
      return sendJson(res, 200, { ok: true, id, state: snapshot() })
    }

    if (url.pathname === '/api/group/settings') {
      const conv = conversations.find(item => item.id === cleanText(body.conversationId, 80))
      if (!conv || conv.kind !== 'group') return sendJson(res, 400, { error: '群聊不存在' })
      if (conv.id === LOBBY_ID) return sendJson(res, 400, { error: '局域网大厅不支持邀请模型或修改 @ 权限' })
      if (conv.ownerId && conv.ownerId !== me.id) return sendJson(res, 403, { error: '只有建群者可以修改群设置' })
      if (!conv.ownerId) conv.ownerId = me.id // 旧版群聊第一次保存设置时，固定本机为群设置拥有者。
      const requested = Array.from(new Set((Array.isArray(body.botIds) ? body.botIds : [])
        .map(value => cleanText(value, 120)).filter(Boolean))).slice(0, 32)
      const invitedBots = requested.map(id => bots.find(bot => bot.id === id)).filter(Boolean)
      if (requested.length !== invitedBots.length) return sendJson(res, 400, { error: '只能邀请本机模型好友' })
      const existing = new Set((conv.botMembers || []).map(member => member.id))
      const added = invitedBots.filter(bot => !existing.has(bot.id))
      if (conv.memberIds.length + added.length > 40) return sendJson(res, 400, { error: '群聊最多邀请39位成员' })
      for (const bot of added) {
        conv.botMembers = [...(conv.botMembers || []), botMemberOf({ ...bot, ownerId: me.id })].slice(0, 32)
        if (!conv.memberIds.includes(bot.id)) conv.memberIds.push(bot.id)
      }
      if (typeof body.allowOthersMention === 'boolean') conv.allowOthersMention = body.allowOthersMention
      conv.settingsVersion = Math.max(0, Number(conv.settingsVersion) || 0) + 1
      for (const bot of added) appendMessage(conv, systemMessage(conv.id, '模型好友「' + bot.name + '」已加入群聊'))
      store.schedule()
      for (const peer of targetsFor(conv)) forward(peer, { type: 'conversation', from: me, conversation: conv })
      stateChanged()
      return sendJson(res, 200, { ok: true, state: snapshot() })
    }

    if (url.pathname === '/api/receive') {
      const from = body.from && typeof body.from === 'object' ? body.from : {}
      const fromId = cleanText(from.id, 80)
      const fromLabel = cleanText(from.nickname || from.name, 24) || '新成员'
      if (!fromId || fromId === me.id) return sendJson(res, 400, { error: '来源无效' })
      if (body.type === 'message' && body.message) {
        const incoming = body.conversation && typeof body.conversation === 'object' ? body.conversation : {}
        // 私聊会话在接收方要以「发消息的人」命名，而不是发送方给这个会话起的名字
        const candidate = incoming.kind === 'group' ? incoming
          : { ...incoming, name: fromLabel || '新成员', peerId: fromId, localOnly: true }
        const conv = upsertConversation(candidate, cleanText(body.message.conversationId, 80) || (fromId ? 'd-' + fromId : ''))
        if (conv) {
          const isGroup = conv.kind === 'group'
          if (!isGroup && !conv.peerId) conv.peerId = fromId
          if (!isGroup && (!conv.name || conv.name === '新会话')) conv.name = fromLabel || '新成员'
          appendMessage(conv, { ...body.message, from: fromId, fromName: fromLabel || conv.name })
          conv.unread = (conv.unread || 0) + 1
          if (isGroup) void handleBotMentions(conv, String(body.message.text || ''), { remote: true, sender: fromLabel })
        }
      } else if (body.type === 'conversation' && body.conversation) {
        const conv = upsertConversation(body.conversation, '')
        if (conv && body.message) appendMessage(conv, { ...body.message, from: fromId, fromName: fromLabel })
      } else return sendJson(res, 400, { error: '未知的事件类型' })
      stateChanged()
      return sendJson(res, 200, { ok: true })
    }
    return sendJson(res, 404, { error: '未知接口' })
  }

  const httpHandler = (req, res) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return sendJson(res, 400, { error: '无效 URL' }) }
    if (url.pathname.startsWith('/api/')) { handleApi(req, res, url).catch(error => sendJson(res, 500, { error: error.message })); return }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    const file = STATIC[url.pathname]
    if (!file) return sendJson(res, 404, { error: '未找到' })
    fsp.readFile(path.join(ROOT, file)).then(content => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
      res.end(content)
    }).catch(() => sendJson(res, 404, { error: '文件不存在' }))
  }

  function listen(serverInstance, candidatePort, attempt = 0) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        serverInstance.off('listening', onListening)
        if (error.code === 'EADDRINUSE' && attempt < 10) resolve(listen(serverInstance, candidatePort + 1, attempt + 1))
        else reject(error)
      }
      const onListening = () => { serverInstance.off('error', onError); resolve(candidatePort) }
      serverInstance.once('error', onError)
      serverInstance.once('listening', onListening)
      serverInstance.listen(candidatePort, '0.0.0.0')
    })
  }

  async function start() {
    if (started) return { port, world: me.world, installed: world.installed, bots: bots.length }
    disposed = false
    const saved = await loadIdentity()
    identity.id = saved.id
    identity.nickname = saved.nickname
    // 同一台机器可能同时跑多个 dsh / 独立服务：让端口参与身份，否则双方会把自己发出的 hello 当成自己而忽略
    me = { id: saved.id + ':' + basePort, nickname: saved.nickname, machine: os.hostname(),
      ip: primaryAddress(), port: basePort, world: world.name + ' ' + world.version }

    // 先把上次的会话 / 消息 / 模型绑定接回来，再对外提供服务
    await restore()

    server = http.createServer(httpHandler)
    try { port = await listen(server, basePort) } catch (error) { server = null; throw error }
    me.id = saved.id + ':' + port
    me.port = port
    ensureLobby()
    await refreshBots()

    net.startedAt = now()
    Object.assign(net.udp, { bound: false, address: '', port: discoveryPort, announced: 0, received: 0, lastSentAt: 0, lastReceivedAt: 0, lastError: '' })
    Object.assign(net.http, { pushed: 0, pushFailed: 0, received: 0, lastPushedAt: 0, lastReceivedAt: 0 })
    Object.assign(net.rejected, { self: 0, protocol: 0, offLan: 0, malformed: 0 })
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    udp.on('message', onUdpMessage)
    udp.on('error', error => {
      net.udp.lastError = String(error?.message || error)
      if (options.onWarning) options.onWarning('UDP: ' + net.udp.lastError)
    })
    await new Promise(resolve => {
      udp.once('error', error => {
        net.udp.bound = false
        net.udp.lastError = String(error?.message || error)
        resolve()
      })
      udp.bind(discoveryPort, '0.0.0.0', () => {
        udp.removeListener('error', resolve)
        try { udp.setBroadcast(true) } catch (error) { net.udp.lastError = String(error?.message || error) }
        net.udp.bound = true
        net.udp.address = '0.0.0.0'
        net.udp.port = discoveryPort
        resolve()
      })
    })

    announce()
    localProbe()
    timers.push(setInterval(announce, HELLO_INTERVAL))
    timers.push(setInterval(localProbe, 4000))
    timers.push(setInterval(() => { void refreshBots() }, BOT_REFRESH_INTERVAL))
    timers.push(setInterval(() => {
      let changed = false
      for (const peer of peers) {
        const online = now() - peer.lastSeen < PEER_TTL
        if (peer.online !== online) { peer.online = online; changed = true }
      }
      if (changed) stateChanged()
    }, 2000))
    // 先把模型目录填好，端口 RPC 第一次返回就能带上正确的模型好友数量（标题栏徽标不等 30 秒）
    await refreshBots()
    started = true
    return { port, world: me.world, installed: world.installed, bots: bots.length }
  }

  async function stop() {
    if (!started) return
    started = false
    disposed = true
    botQueue.length = 0
    for (const controller of botSignals) { try { controller.abort(new Error('聊天服务已停止')) } catch {} }
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    try { udp?.send(Buffer.from(JSON.stringify({ ...hello(), type: 'bye' })), discoveryPort, '255.255.255.255') } catch {}
    await new Promise(resolve => { try { udp?.close(resolve) } catch { resolve() } })
    udp = null
    net.udp.bound = false
    for (const res of sse) { try { res.end() } catch {} }
    sse.clear()
    await new Promise(resolve => { if (!server) return resolve(); server.close(() => resolve()) })
    server = null
    // 停服前把挂起的改动落盘，下次启动才能接着看
    try { await store.flush() } catch {}
  }

  /* --------------------- 给 dsh 会话用的查询接口 --------------------- */

  /** 全部聊天会话（含大厅），按最近活跃排序。 */
  function listConversations() {
    if (!me) return []
    ensureLobby()
    return conversations.map(conv => ({
      id: conv.id, name: conv.name, kind: conv.kind, members: conv.memberIds.length,
      messages: (messages[conv.id] || []).length, updatedAt: conv.updatedAt,
      bot: Boolean(conv.bot), ownerBotId: conv.ownerBotId || '',
    })).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 按会话 / 关键词 / 时间范围翻聊天记录，按时间倒序返回。
   * 数据来自本机保存的聊天记录（`<home>/lan-chat/state.json` 恢复出来的那份），
   * 不依赖 dsh 会话本身，所以模型可以在任何会话里查任意聊天窗口的历史。
   * @param {{conversationId?: string, query?: string, limit?: number, since?: number, until?: number}} options
   */
  function searchMessages(options = {}) {
    if (!me) return []
    const conversationId = cleanText(options.conversationId, 80)
    const query = cleanText(options.query, 200).toLowerCase()
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 30))
    const since = Number(options.since) || 0
    const until = Number(options.until) || 0
    const rows = []
    for (const conv of conversations) {
      if (conversationId && conv.id !== conversationId) continue
      for (const message of messages[conv.id] || []) {
        if (since && message.at < since) continue
        if (until && message.at > until) continue
        if (query) {
          const text = String(message.text || '').toLowerCase()
          const name = String(message.fromName || '').toLowerCase()
          if (!text.includes(query) && !name.includes(query)) continue
        }
        rows.push({
          conversationId: conv.id, conversation: conv.name, kind: conv.kind,
          id: message.id, from: message.from, fromName: message.fromName,
          at: message.at, text: message.text, system: message.kind === 'system',
        })
      }
    }
    rows.sort((a, b) => b.at - a.at)
    return rows.slice(0, limit)
  }

  return { start, stop, snapshot, announce, refreshBots, searchMessages, listConversations,
    get port() { return port }, get bots() { return bots.map(row => ({ ...row })) },
    get world() { return me?.world || world.name + ' ' + world.version }, get started() { return started } }
}

async function startStandalone() {
  const service = createLanChatServer()
  const info = await service.start()
  console.log('局域网聊天已启动')
  console.log('  world 插件：' + info.world + (info.installed ? '（已检测到）' : '（未在本机检测到安装痕迹）'))
  console.log('  本机地址：' + primaryAddress() + ':' + info.port)
  console.log('  界面：http://127.0.0.1:' + info.port + '/')
  console.log('  原型：http://127.0.0.1:' + info.port + '/prototype.html')
  console.log('  模型好友：' + info.bots + ' 个（独立模式没有宿主，需由 dsh 启动才会出现）')
  console.log('  发现端口：UDP ' + DISCOVERY_PORT + '（需要在防火墙里放行）')
  if (process.env.LAN_CHAT_OPEN === '1') {
    const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    exec(opener + ' "http://127.0.0.1:' + info.port + '/"', { windowsHide: true }, () => {})
  }
  const shutdown = () => { service.stop().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return service
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStandalone().catch(error => { console.error('启动失败：' + error.message); process.exitCode = 1 })
}

export { startStandalone, DEFAULT_PORT, DISCOVERY_PORT }
