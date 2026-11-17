import React from 'react'

const h = React.createElement
export function InternetGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('circle', { cx: 12, cy: 12, r: 9 }), h('ellipse', { cx: 12, cy: 12, rx: 4, ry: 9 }),
    h('path', { d: 'M3 12h18M5 6.5h14M5 17.5h14' }))
}
export const INTERNET_APPS = [
  { key: 'world-internet', label: '上网', icon: InternetGlyph, description: 'EasyTier · 连接配置、启动停止和实时日志' },
]
const PHASES = { stopped: '已停止', authorizing: '等待管理员授权', starting: '启动中', running: '运行中', stopping: '停止中', failed: '已退出 / 启动失败' }

/** Independent of the configuration window so an existing connection is visible on a fresh desktop. */
export function InternetTaskbar({ rpc, onOpen }) {
  const [connection, setConnection] = React.useState(null)
  React.useEffect(() => {
    let stopped = false, timer, request, reading = false
    const tick = async () => {
      window.clearTimeout(timer)
      if (stopped || document.hidden || reading) return
      reading = true; request = new AbortController()
      try {
        const result = await rpc.call('/api', 'world-internet/connection', {}, request.signal)
        if (!stopped && !request.signal.aborted) setConnection(result?.ok ? result.value : null)
      } catch { if (!stopped) setConnection(null) }
      finally { reading = false; if (!stopped && !document.hidden) timer = window.setTimeout(tick, 3000) }
    }
    const visibility = () => { if (document.hidden) { window.clearTimeout(timer); request?.abort() } else void tick() }
    document.addEventListener('visibilitychange', visibility)
    void tick()
    return () => { stopped = true; window.clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visibility) }
  }, [rpc])
  if (!connection?.connected) return null
  return h('button', { type: 'button', className: 'world-control-button', 'data-world-internet-tray': true,
    'aria-label': '网络：EasyTier 已连接，打开上网配置',
    title: `EasyTier 已连接 · ${connection.ipv4} · ${connection.peerCount} 个节点 · 点击打开上网配置`, onClick: onOpen },
    h(InternetGlyph, { size: 20 }))
}

export function InternetPage({ rpc, visible = true }) {
  const [config, setConfig] = React.useState(null), [state, setState] = React.useState(null)
  const [action, setAction] = React.useState(''), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('')
  const [pollError, setPollError] = React.useState('')
  const [showSecret, setShowSecret] = React.useState(false), [follow, setFollow] = React.useState(true)
  const [pageVisible, setPageVisible] = React.useState(() => !document.hidden)
  const alive = React.useRef(true), lock = React.useRef(false), active = React.useRef(null), polling = React.useRef(null)
  const logView = React.useRef(null)
  React.useEffect(() => {
    alive.current = true
    const sync = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => { alive.current = false; document.removeEventListener('visibilitychange', sync); active.current?.abort(); polling.current?.abort() }
  }, [])
  const call = React.useCallback(async (operation, payload, signal) => {
    const result = await rpc.call('/api', `world-internet/${operation}`, payload, signal)
    if (!result?.ok) throw new Error(result?.error?.message || '无法访问上网服务。')
    return result.value
  }, [rpc])
  const run = async (operation, payload = {}) => {
    if (lock.current) return
    lock.current = true; setAction(operation === 'start' && state?.requiresElevation ? 'authorize' : operation); setError(''); setNotice('')
    polling.current?.abort()
    const controller = new AbortController(); active.current = controller
    try {
      const value = await call(operation, payload, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      setState(value)
      if (value.config) setConfig(value.config)
      if (operation === 'save') setNotice('配置已保存。')
    } catch (cause) { if (alive.current && !controller.signal.aborted) setError(cause.message || String(cause)) }
    finally { lock.current = false; if (alive.current) setAction('') }
  }
  React.useEffect(() => { void run('info') }, [])
  React.useEffect(() => {
    if (!visible || !pageVisible || !config) return
    let stopped = false, timer
    const tick = async () => {
      if (!lock.current) {
        const controller = new AbortController(); polling.current = controller
        try {
          const value = await call('status', {}, controller.signal)
          if (!stopped && alive.current && !controller.signal.aborted) { setState(value); setPollError('') }
        } catch (cause) { if (!stopped && alive.current && !controller.signal.aborted) setPollError(cause.message || String(cause)) }
      }
      if (!stopped) timer = window.setTimeout(tick, 1000)
    }
    void tick()
    return () => { stopped = true; window.clearTimeout(timer); polling.current?.abort() }
  }, [visible, pageVisible, Boolean(config), call])
  React.useEffect(() => {
    if (follow && logView.current) logView.current.scrollTop = logView.current.scrollHeight
  }, [state?.logs, follow])
  const edit = key => event => { setConfig(value => ({ ...value, [key]: event.target.value })); setNotice('') }
  const busy = Boolean(action), running = state?.running, disabled = busy || running || state?.supported === false
  const fields = [
    ['directory', '程序目录', state?.platform === 'win32' ? 'D:\\easytier-windows-x86_64（留空从 PATH 查找）' : '例如 /usr/local/bin，留空从 PATH 查找'], ['ipv4', '本机 IP', '10.192.168.3'],
    ['secret', '网络密钥', '请输入网络密钥'], ['peer', '节点地址', 'udp://118.178.196.123:11010'],
  ]
  return h('div', { className: 'world-resource-manager world-internet', 'data-world-internet': true, 'aria-busy': busy },
    h('form', { className: 'world-internet-form', onSubmit: event => { event.preventDefault(); void run('start', { config }) } },
      ...fields.map(([key, label, placeholder]) => h('label', { key }, label,
        h('input', { type: key === 'secret' && !showSecret ? 'password' : 'text', value: config?.[key] || '',
          'aria-label': label, placeholder, disabled: disabled || !config, required: key !== 'directory',
          autoComplete: 'off', spellCheck: false, onChange: edit(key) }))),
      h('div', { className: 'world-internet-actions' },
        h('button', { type: 'button', disabled: busy || !config, 'aria-pressed': showSecret, onClick: () => setShowSecret(value => !value) }, showSecret ? '隐藏密钥' : '显示密钥'),
        h('button', { type: 'button', disabled: disabled || !config, onClick: () => { void run('save', { config }) } }, action === 'save' ? '保存中…' : '保存配置'),
        h('button', { type: 'submit', className: 'is-primary', disabled: disabled || !config }, action === 'authorize' ? '等待授权…' : action === 'start' ? '启动中…' : '启动上网'),
        h('button', { type: 'button', disabled: busy || !running, onClick: () => { void run('stop') } }, action === 'stop' ? '停止中…' : '停止'))),
    h('div', { className: 'world-internet-status', role: 'status' },
      busy ? ({ info: '正在读取配置…', save: '正在保存配置…', authorize: '请在 Windows 系统窗口中批准管理员授权…', start: '正在启动 EasyTier…', stop: '正在停止 EasyTier…', clear: '正在清空日志…' }[action])
        : `${PHASES[state?.phase] || '正在读取…'}${state?.pid ? ` · PID ${state.pid}` : ''}${state?.exitCode != null ? ` · 退出码 ${state.exitCode}` : ''}`,
      notice && ` · ${notice}`),
    (error || state?.error || pollError) && h('p', { className: 'world-processes-error', role: 'alert' }, error || state.error || pollError),
    !config && !busy && h('button', { type: 'button', onClick: () => { void run('info') } }, '重试读取配置'),
    state?.supported === false && h('p', { className: 'world-processes-error', role: 'alert' }, '上网功能支持 Windows、macOS 和 Linux。'),
    h('div', { className: 'world-internet-logbar' }, h('strong', null, '实时日志'),
      h('button', { type: 'button', 'aria-pressed': follow, onClick: () => setFollow(value => !value) }, follow ? '暂停滚动' : '自动滚动'),
      h('button', { type: 'button', disabled: busy, onClick: () => { void run('clear') } }, '清空日志')),
    state?.truncated && h('p', { className: 'world-processes-hint' }, '仅保留最近日志，较早内容已截断。'),
    h('pre', { className: 'world-internet-logs', ref: logView, 'aria-label': 'EasyTier 日志', tabIndex: 0 }, state?.logs || '启动后在这里查看 EasyTier 输出。'),
    h('p', { className: 'world-processes-hint' },
      state?.requiresElevation ? '启动时会弹出 Windows 管理员授权，仅提升 EasyTier 权限。关闭窗口后连接继续运行，点击「停止」断开。'
        : 'EasyTier 需要管理员／网络管理权限。关闭窗口后连接继续运行，点击「停止」断开。连接情况请查看日志。'))
}
