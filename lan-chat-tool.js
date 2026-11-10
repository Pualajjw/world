/**
 * 给 dsh 会话用的局域网聊天查询工具。
 *
 * 模型好友的上下文在真实 dsh 会话里，它看不到聊天窗口的界面；这两个工具让它
 * 能自己去翻本机保存的聊天记录（`<home>/lan-chat/state.json` 恢复出来的那份）：
 *
 * - `lan_chat_conversations`：先看有哪些聊天窗口、各有多少条消息，拿到会话 id；
 * - `lan_chat_history`：按会话 / 关键词 / 时间范围查具体消息。
 *
 * 两个都只读，不写盘、不触发模型、不影响正在聊的人。
 */

/** 宿主服务可能以不同方式暴露（严格 ctx.get 在服务未 ACTIVE 时返回 undefined）。 */
function hostService(ctx, name) {
  try { const value = ctx.get?.(name); if (value) return value } catch {}
  try { const value = ctx.get?.(name, false); if (value) return value } catch {}
  try { const value = ctx[name]; if (value) return value } catch {}
  return undefined
}

function clockOf(at) {
  const date = new Date(Number(at) || 0)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function lineOf(row) {
  const who = row.system ? '系统' : (row.fromName || '成员')
  return '[' + clockOf(row.at) + '] ' + who + '：' + String(row.text || '').replace(/\s*\n\s*/g, ' ⏎ ')
}

/**
 * @param ctx dsh Host 上下文
 * @param options.chat 取聊天服务（`() => createLanChatServer(...)` 的实例）
 * @param options.namePrefix 工具名前缀，默认 `lan_chat`
 */
export function registerLanChatTools(ctx, options = {}) {
  const getChat = typeof options.chat === 'function' ? options.chat : () => undefined
  const prefix = String(options.namePrefix || 'lan_chat')

  function chatOf() {
    const chat = getChat()
    if (!chat) throw new Error('局域网聊天服务还没启动')
    return chat
  }

  ctx.effect(() => {
    const tools = hostService(ctx, 'tools')
    if (!tools?.register) return undefined
    const offs = []

    offs.push(tools.register({
      name: prefix + '_conversations',
      description: '列出局域网聊天里所有的聊天窗口（群聊 / 私聊 / 模型会话），带会话 id、类型、消息条数和最近更新时间。想查某个窗口的聊天记录时，先用它拿到会话 id，再调用 ' + prefix + '_history。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object', additionalProperties: true,
          properties: { total: { type: 'number' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text || '没有聊天会话。') }],
      },
      timeoutMs: 8000,
      async execute() {
        const rows = chatOf().listConversations() || []
        if (!rows.length) return { total: 0, text: '聊天服务里还没有任何会话。' }
        const lines = rows.map(row => '- ' + row.name + '（' + row.id + '，'
          + (row.kind === 'group' ? '群聊' : '私聊') + '，' + row.messages + ' 条，最近 '
          + clockOf(row.updatedAt) + (row.bot ? '，模型会话' : '') + '）')
        return { total: rows.length, conversations: rows,
          text: '共 ' + rows.length + ' 个聊天窗口：\n' + lines.join('\n') }
      },
    }))

    offs.push(tools.register({
      name: prefix + '_history',
      description: '查询局域网聊天的聊天记录（本机保存的那份，重启后仍在）。可按会话 id、关键词、时间范围过滤，默认按时间倒序返回最近 30 条。回答「之前聊过什么」「谁说过 X」这类问题前先查这个。',
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '会话 id（先用 ' + prefix + '_conversations 拿）。不填则跨所有会话搜索。' },
          query: { type: 'string', description: '关键词，按消息正文或发言人名字做包含匹配。不填则按时间取最近的消息。' },
          limit: { type: 'number', description: '最多返回多少条，1~200，默认 30。' },
          hours: { type: 'number', description: '只看最近多少小时内的消息，例如 24。不填则不限时间。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object', additionalProperties: true,
          properties: { total: { type: 'number' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text || '没有匹配的聊天记录。') }],
      },
      timeoutMs: 8000,
      async execute(args) {
        const hours = Number(args?.hours)
        const options = {
          conversationId: typeof args?.conversationId === 'string' ? args.conversationId : '',
          query: typeof args?.query === 'string' ? args.query : '',
          limit: Number(args?.limit) || 30,
          since: Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3600_000 : 0,
        }
        const rows = chatOf().searchMessages(options) || []
        if (!rows.length) {
          return { total: 0, text: '没有匹配的聊天记录'
            + (options.query ? '（关键词「' + options.query + '」）' : '')
            + (options.conversationId ? '（会话 ' + options.conversationId + '）' : '') + '。' }
        }
        const lines = rows.map(row => '- 【' + row.conversation + '】' + lineOf(row))
        return { total: rows.length, rows,
          text: '匹配到 ' + rows.length + ' 条（按时间倒序）：\n' + lines.join('\n') }
      },
    }))

    return () => { for (const off of offs) { try { off?.() } catch {} } }
  }, 'world: LAN chat query tools')
}
