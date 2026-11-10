import { UI_ACTIONS, validateUiCommand } from './desktop-ui-protocol.js'

const fail = (message, code = 'WORLD_DESKTOP_INVALID') => { throw Object.assign(new Error(message), { code }) }
const actions = ['open_app', 'focus_window', 'minimize_window', 'maximize_window', 'restore_window', 'open_file', 'explain', 'layout', ...UI_ACTIONS]
const output = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Tools invoke the same desktop actions as the user; file reads use the calling model's session. */
export function desktopToolDefinitions({ bridge, brain, workbench, editor, sessions, getAttachments }) {
  const definitions = [{
    name: 'world_desktop_state',
    description: '读取 world 桌面的固定助手 brainSessionId、控制权 control.owner/controlId，以及应用、窗口、文件标签、未保存标记和光标位置。control.owner=human 时等待用户交接，不可自行授权。多个桌面时先返回候选桌面，再传 desktopId 查询。操作前后用它确认状态。',
    parameters: { type: 'object', properties: { desktopId: { type: 'string' } }, additionalProperties: false },
    output, timeoutMs: 20000,
    async execute(args = {}, exec = {}) {
      const desktops = bridge.list()
      if (!args.desktopId && desktops.length !== 1) return { connected: desktops.length > 0, desktops, requiresDesktopId: desktops.length > 1 }
      const result = await bridge.request({ action: 'state' }, { desktopId: args.desktopId, signal: exec.signal })
      return { ...result, ...(workbench ? { workbench: workbench.getState() } : {}) }
    },
  }, {
    name: 'world_desktop_action',
    description: '由 world 唯一的固定助手会话操作桌面；切换界面或重新交接不会更换助手会话。用户点击“交给助手”后，先用 state 取得 control.controlId，每次调用带上；用户接管后旧 id 失效，不可重试或自行授权。explain 用 message 在透明层说明当前工作；其他动作也可带 message。open_app 打开应用；focus/minimize/maximize/restore_window 操作窗口；open_file 打开固定助手工作区的 UTF-8 文件，line/column 从 1 开始，refresh=true 只重读未修改文件。返回实际结果。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: actions }, desktopId: { type: 'string' },
      appId: { type: 'string' }, windowId: { type: 'string' }, path: { type: 'string' },
      line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 },
      refresh: { type: 'boolean' },
      controlId: { type: 'string', description: '用户最近一次交接后，state.control.controlId 返回的值。' },
      message: { type: 'string', description: '向用户说明正在做什么的简短文字，最多 500 字。' },
      snapshotId: { type: 'string', description: 'world_desktop_layout 最近返回的目标窗口 snapshotId；布局变化后必须重读。' },
      targetId: { type: 'string' }, toTargetId: { type: 'string' },
      x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' },
      deltaX: { type: 'number' }, deltaY: { type: 'number' },
      text: { type: 'string' }, key: { type: 'string', description: '例如 Enter、Delete、Control+z。' }, value: { type: 'string' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] } },
      maxElements: { type: 'integer', minimum: 1, maximum: 1000 },
    }, required: ['action', 'controlId'], additionalProperties: false },
    output, timeoutMs: 20000,
    async execute(args, exec = {}) {
      if (!actions.includes(args?.action)) fail('不支持的桌面操作。')
      if (typeof args.controlId !== 'string' || !args.controlId || args.controlId.length > 128) fail('请先读取桌面状态，并提供本次交接的 controlId。')
      const sessionId = exec.agent?.session?.id
      if (!sessionId) fail('桌面操作需要在 DSH 会话中调用。', 'WORLD_DESKTOP_SESSION')
      const fixed = await brain.get()
      if (fixed.sessionId !== sessionId) fail('桌面仅接受固定助手会话的操作，不会切换到其他会话。', 'WORLD_DESKTOP_BRAIN')
      if (args.message !== undefined && (typeof args.message !== 'string' || args.message.length > 500)) fail('message 应为不超过 500 字的文字。')
      if (args.action === 'explain' && !args.message?.trim()) fail('explain 需要说明文字 message。')
      const command = { action: args.action, controlId: args.controlId, actor: { sessionId }, message: args.message?.trim() || '' }
      if (args.action === 'layout' || UI_ACTIONS.includes(args.action)) Object.assign(command, validateUiCommand(args))
      else if (args.action === 'open_app') {
        if (typeof args.appId !== 'string' || !args.appId || args.appId.length > 160) fail('open_app 需要 appId。')
        command.appId = args.appId
      } else if (args.action !== 'open_file' && args.action !== 'explain') {
        if (typeof args.windowId !== 'string' || !args.windowId || args.windowId.length > 160) fail('窗口操作需要 windowId。')
        command.windowId = args.windowId
      }
      if (args.action === 'open_file' || (args.action === 'open_app' && args.appId === 'vscode')) {
        const session = sessionId && sessions.get(sessionId)
        const cwd = session?.header?.cwd
        if (!cwd) fail('请在有工作目录的 DSH 会话中打开文件或编辑器。', 'WORLD_DESKTOP_SESSION')
        command.session = { id: sessionId, cwd }
        if (args.action === 'open_file') {
          if (typeof args.path !== 'string' || !args.path || args.path.length > 4096) fail('open_file 需要文件路径。')
          for (const key of ['line', 'column']) if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 1))
            fail(`${key} 必须是从 1 开始的整数。`)
          if (args.refresh !== undefined && typeof args.refresh !== 'boolean') fail('refresh 必须是布尔值。')
          if (args.windowId !== undefined && (typeof args.windowId !== 'string' || !args.windowId || args.windowId.length > 160)) fail('windowId 无效。')
          // Reuse the existing source service's path, symlink, encoding and size checks before touching the UI.
          const file = await editor.call('open', { sessionId, root: cwd, path: args.path }, exec.signal)
          Object.assign(command, { path: file.path, windowId: args.windowId, line: args.line || 1,
            column: args.column || 1, refresh: args.refresh === true })
        }
      }
      return bridge.request(command, { desktopId: args.desktopId, signal: exec.signal })
    },
  }]
  definitions[1].description += ' 窗口内部操作先读 world_desktop_layout；用 windowId、snapshotId 和 targetId（或 viewport CSS 像素坐标）点击、双击、右键、悬停、拖拽、滚动、填值、输入、按键或选项选择。fill 替换文本，type_text 在当前选区输入；操作返回新布局。DOM 输入不模拟系统级可信事件，跨域网页、原生 guest 和系统文件对话框不支持。布局过期请重读，不可猜测重试。'
  definitions.push({
    name: 'world_desktop_layout',
    description: '读取 world 所有虚拟窗口或指定 windowId 的实时 DOM 布局、控件标识、名称、可见位置和状态。需固定助手当前 controlId；不改变焦点。坐标为 viewport CSS 像素。密码和文件输入值不返回；跨域 / 原生网页只返回边框与不支持原因。后续操作使用本次 snapshotId 和 targetId。',
    parameters: { type: 'object', properties: { desktopId: { type: 'string' }, controlId: { type: 'string' }, windowId: { type: 'string' },
      maxElements: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['controlId'], additionalProperties: false },
    output, timeoutMs: 20000,
    execute(args, exec) { return definitions[1].execute({ ...args, action: 'layout' }, exec) },
  })
  definitions.push({
    name: 'world_desktop_screenshot',
    description: '截取 world 虚拟桌面并直接把图片返回给模型，用于核对真实渲染结果（像素、对齐、颜色），比布局数字更可靠。只包含 world 桌面区域：DSH 原生标题栏被裁掉，不会截到系统桌面；浏览器 webview 与内嵌 iframe 的内容一律用占位块替代，不读取、不截图网页内容。需要固定助手在用户交接后取得的本次 controlId；用户接管后旧 id 失效。',
    parameters: { type: 'object', properties: {
      desktopId: { type: 'string' },
      controlId: { type: 'string', description: '用户最近一次交接后，state.control.controlId 返回的值。' },
      maxWidth: { type: 'integer', minimum: 0, maximum: 3840, description: '输出最大宽度；0 表示原始像素。' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 png（无损，适合核对像素）。' },
      quality: { type: 'number', minimum: .1, maximum: 1, description: 'jpeg 质量，默认 0.9。' },
    }, required: ['controlId'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        { type: 'text', text: `world 桌面截图 ${value.width}×${value.height}（缩放 ${value.scale}；隐私占位：${value.redacted.length ? value.redacted.join(', ') : '无'}；区域 ${value.region.x},${value.region.y} ${value.region.width}×${value.region.height}）` },
        { type: 'image', attachment: value.image },
      ] },
    timeoutMs: 30000,
    async execute(args = {}, exec = {}) {
      const sessionId = exec.agent?.session?.id
      if (!sessionId) fail('桌面截图需要在 DSH 会话中调用。', 'WORLD_DESKTOP_SESSION')
      const fixed = await brain.get()
      if (fixed.sessionId !== sessionId) fail('桌面截图只属于 world 的固定助手会话。', 'WORLD_DESKTOP_BRAIN')
      if (typeof args.controlId !== 'string' || !args.controlId || args.controlId.length > 128)
        fail('请先读取桌面状态，并提供本次交接的 controlId。')
      const maxWidth = args.maxWidth ?? 0
      if (!Number.isSafeInteger(maxWidth) || maxWidth < 0 || maxWidth > 3840) fail('maxWidth 需要是 0 到 3840 的整数。')
      const format = args.format ?? 'png'
      if (!['png', 'jpeg'].includes(format)) fail('format 只支持 png 或 jpeg。')
      const quality = args.quality ?? .9
      if (typeof quality !== 'number' || quality < .1 || quality > 1) fail('quality 需要是 0.1 到 1 之间的数字。')
      const attachments = getAttachments?.()
      if (!attachments || typeof attachments.saveImage !== 'function')
        fail('当前宿主没有附件服务，无法把截图交给模型。', 'WORLD_SHOT_ATTACHMENT')
      const shot = await bridge.request({ action: 'screenshot', controlId: args.controlId,
        actor: { sessionId }, maxWidth, format, quality }, { desktopId: args.desktopId, signal: exec.signal })
      const base64 = typeof shot?.dataUrl === 'string' ? shot.dataUrl.split(',')[1] || '' : ''
      if (!base64) fail('桌面截图没有返回图像。', 'WORLD_SHOT_EMPTY')
      let image
      try {
        image = await attachments.saveImage({ data: Buffer.from(base64, 'base64'), mediaType: shot.mediaType || 'image/png',
          name: `world-desktop-${new Date(shot.capturedAt || Date.now()).toISOString().replace(/[:.]/gu, '-')}.${format === 'jpeg' ? 'jpg' : 'png'}` })
      } catch (error) {
        throw Object.assign(new Error(`桌面截图附件保存失败：${String(error?.message || error)}。可降低 maxWidth 后重试。`), { code: 'WORLD_SHOT_ATTACHMENT' })
      }
      return { width: shot.width, height: shot.height, scale: shot.scale, region: shot.region,
        redacted: Array.isArray(shot.redacted) ? shot.redacted : [], image }
    },
  })
  return definitions
}

export function registerDesktopTools(ctx, options) {
  ctx.inject(['tools'], scope => {
    for (const tool of desktopToolDefinitions({ ...options, getAttachments: () => ctx.get('attachments') }))
      scope.effect(() => scope.tools.register(tool), `world: ${tool.name}`)
  })
}
