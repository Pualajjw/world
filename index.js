/** Host services: VSCode source files + the built-in LAN chat app. */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { FsError } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createCompanionMemory, conversationRow } from './companion-memory.js'
import { companionInstructions, createLifeLine, registerCompanionTools } from './companion-life.js'
import { createVscodeSourceEditor } from './source-editor.js'
import { createPathRevealer } from './vscode-reveal.js'
import { createVscodeGit } from './git.js'
import { createVscodeSearch } from './vscode-search.js'
import { createLanChatServer } from './lan-chat/server.mjs'
import { createModelFriends } from './model-friends.js'
import { registerLanChatTools } from './lan-chat-tool.js'
import { createDesktopBridge } from './desktop-bridge.js'
import { registerDesktopTools } from './desktop-tools.js'
import { createDesktopBrain } from './desktop-brain.js'
import { registerWorkbench } from './workbench.js'
import { createJournalStore, registerJournalTools } from './journal.js'
import { createTasksStore, registerTasksTools } from './tasks.js'

export const name = 'world'
export const inject = ['fs', 'connection', 'sessions', 'sandboxPolicy', 'sessionController', 'agents']

export function apply(ctx) {
  // 在资源管理器中显示需要宿主子进程；没有该服务时其余编辑功能照常工作，只让 reveal 报错。
  let revealer = null
  ctx.inject(['subprocess'], scope => {
    const created = createPathRevealer(scope.subprocess)
    revealer = created
    scope.effect(() => () => {
      if (revealer === created) revealer = null
      void created.dispose()
    }, 'world: VSCode reveal in Explorer')
  })
  const editor = createVscodeSourceEditor(ctx, {
    FsError, writableRoots,
    reveal(target, signal) {
      if (!revealer) throw new FsError('当前宿主没有子进程服务，无法打开资源管理器。', 'WORLD_REVEAL_UNAVAILABLE')
      return revealer.reveal(target, signal)
    },
  })
  ctx.effect(() => () => editor.dispose(), 'world: VSCode source editor')
  const desktop = createDesktopBridge()
  const brain = createDesktopBrain(ctx, { atomic: { withFileLock, writeFileAtomic } })
  const journal = createJournalStore({ atomic: { withFileLock, writeFileAtomic } })
  ctx.effect(() => () => journal.dispose(), 'world: diary lifetime')
  registerJournalTools(ctx, { journal, brain })
  const tasks = createTasksStore({ atomic: { withFileLock, writeFileAtomic } })
  ctx.effect(() => () => tasks.dispose(), 'world: tasks lifetime')
  registerTasksTools(ctx, { tasks, brain })
  // 世界内核：原文按天留在磁盘上，生活线只有一个闹钟，什么时候醒来由她自己定。
  const worldDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'world')
  const memory = createCompanionMemory({ dir: worldDir })
  let life = null
  void memory.refreshSelf().catch(() => {})
  const workbench = registerWorkbench(ctx, {
    brain, bridge: desktop, journal,
    promptOf: scope => {
      const fixed = brain.peek()
      if (!scope || scope.id !== fixed.sessionId || !fixed.profile) return ''
      return companionInstructions({ profile: fixed.profile, self: memory.selfTextSync(), life: life?.check() })
    },
    onHandoff: () => { void life?.refresh({ handoff: true }) },
    // 没有轮次在跑时，卡片显示她自己的下一个时间点，而不是「等你说话」。
    nextUp: () => { const text = life?.check(); return text ? `在自己的时间里：${text}` : '' },
  })
  ctx.effect(() => () => desktop.dispose(), 'world: desktop operations')

  life = createLifeLine({
    memory, workbench, dir: worldDir, logger: console, atomic: { writeFileAtomic },
    config: () => {
      const profile = brain.peek().profile
      return { life: profile ? profile.life !== false : true, wakeTime: profile?.wakeTime, reviewTime: profile?.reviewTime }
    },
    // 读一次磁盘上的绑定：peek() 在首次 load 之前是空的，不能拿它当「她有没有家」。
    available: async () => { try { return Boolean((await brain.get()).profile) } catch { return false } },
  })
  ctx.effect(() => () => life.stop(), 'world: life line lifetime')
  registerCompanionTools(ctx, { lifeOf: () => life, memory, brain })
  void life.start().catch(error => console.warn('[world] life line:', error))

  // 只记她自己的家：对话原文按天归档，工具调用留给下一次闹钟对照。
  const pendingCalls = new Map()
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const fixed = brain.peek().sessionId
    if (!fixed || !session || session.id !== fixed) return
    const row = conversationRow(event)
    if (row) void memory.append(row)
    if (event.type === 'tool/call' && event.data?.callId) {
      pendingCalls.set(event.data.callId, { tool: event.data.name, arguments: event.data.arguments, time: event.time })
    } else if (event.type === 'tool/result') {
      const id = event.data?.message?.toolCallId
      const call = pendingCalls.get(id)
      if (call) { pendingCalls.delete(id); life.observeCall(id, call) }
    } else if (event.type === 'turn/end') {
      for (const [id, call] of pendingCalls) { pendingCalls.delete(id); life.observeCall(id, call) }
      void life.onTurnEnd(event.data?.reason?.kind === 'completed')
    }
  }), 'world: her memory and actions')
  registerDesktopTools(ctx, { bridge: desktop, brain, workbench, editor, sessions: ctx.sessions })

  // 内置局域网聊天：UDP 发现 + HTTP 消息服务随 world 一起启动，端口通过 RPC 告诉客户端窗口。
  // models 是本机模型好友的 Host 桥接：把每个配置好的模型绑到一个真实 dsh 会话，
  // 消息走 sessionController.prompt，上下文由 dsh 自己维护（这里不拼 history）。
  const friends = createModelFriends(ctx)
  ctx.effect(() => () => friends.dispose(), 'world: model friends sessions')
  const chat = createLanChatServer({ models: friends })
  ctx.effect(() => {
    let disposed = false
    void chat.start().then(() => { if (disposed) void chat.stop() })
      .catch(error => console.warn('[world] LAN chat service:', String(error?.message || error)))
    return () => { disposed = true; void chat.stop() }
  }, 'world: LAN chat discovery + messaging')

  // 聊天记录查询工具：让任意 dsh 会话（包括模型好友自己的会话）能翻局域网聊天历史
  registerLanChatTools(ctx, { chat: () => chat })
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/world-lan-chat/port', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let message
      try { message = await request.json() }
      catch { return new Response('Invalid JSON', { status: 400 }) }
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
        || !message.rpcId || message.rpcId.length > 128 || message.method !== 'world-lan-chat/port'
        || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
        return new Response('Invalid LAN chat RPC envelope', { status: 400 })
      }
      let result
      try {
        const info = await chat.start()
        result = { ok: true, value: { port: info.port, world: info.world, installed: info.installed, bots: info.bots } }
      } catch (error) {
        result = { ok: false, error: { code: 'WORLD_LAN_CHAT', message: String(error?.message || error), details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
    },
  }), 'world: LAN chat port RPC')

  /**
   * One POST endpoint per operation, all sharing the same client-request envelope.
   * `code` is the fallback error code when the service throws without one.
   */
  function serve(scope, serviceName, operations, service, code) {
    for (const operation of operations) scope.effect(() => scope.connection.fetch.register({
      path: `/api/${serviceName}/${operation}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let message
        try { message = await request.json() }
        catch { return new Response('Invalid JSON', { status: 400 }) }
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
          || !message.rpcId || message.rpcId.length > 128 || message.method !== `${serviceName}/${operation}`
          || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
          return new Response(`Invalid ${serviceName} RPC envelope`, { status: 400 })
        }
        let result
        try { result = { ok: true, value: await service.call(operation, message.payload, request.signal) } }
        catch (error) {
          result = { ok: false, error: { code: error?.code ?? code, message: String(error?.message ?? error), details: {} } }
        }
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }), `world: ${serviceName} ${operation}`)
  }

  // list 是「打开文件夹」对话框：只列子目录，读写仍按 root + sandbox policy 校验。
  serve(ctx, 'world-vscode-source', ['open', 'save', 'list', 'reveal', 'probe'], editor, 'WORLD_VSCODE_SOURCE')
  serve(ctx, 'world-desktop', ['connect', 'poll', 'reply', 'disconnect', 'update'], desktop, 'WORLD_DESKTOP_ACTION')
  serve(ctx, 'world-desktop-brain', ['get', 'bind', 'configure', 'update_profile'], brain, 'WORLD_DESKTOP_BRAIN')
  // 自动推进的刹车：暂停只停「新轮次」，不动当前这一轮，也不撤销桌面授权。
  serve(ctx, 'world-workbench', ['get', 'pause', 'resume'], workbench, 'WORLD_WORKBENCH')
  serve(ctx, 'world-journal', ['list', 'get', 'write', 'pin', 'trash', 'restore', 'purge', 'clear'], journal, 'WORLD_DIARY_ACTION')
  serve(ctx, 'world-tasks', ['list', 'get', 'write', 'remove', 'clearDone'], tasks, 'WORLD_TASKS_ACTION')

  // 侧栏搜索：只读遍历会话工作目录，不需要子进程，也不碰沙箱写权限。
  const search = createVscodeSearch(ctx, { FsError })
  ctx.effect(() => () => search.dispose(), 'world: VSCode search')
  serve(ctx, 'world-vscode-search', ['find'], search, 'WORLD_VSCODE_SEARCH')

  // Git 需要宿主子进程服务；这里用 ctx.inject 让缺少该服务时其余内置应用照常工作。
  ctx.inject(['subprocess'], scope => {
    const git = createVscodeGit(ctx, { FsError, writableRoots, subprocess: scope.subprocess })
    scope.effect(() => () => git.dispose(), 'world: VSCode git')
    serve(scope, 'world-vscode-git', ['status', 'stage', 'unstage', 'commit', 'pull', 'push'], git, 'WORLD_VSCODE_GIT')
  })
}
