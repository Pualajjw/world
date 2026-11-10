/**
 * world 内置浏览器的纯逻辑层：地址白名单、标签状态机、guest 租约池。
 *
 * 零 React / 零 DOM / 零宿主 import —— 可以直接在 node --test 里跑。
 * 契约来源（只读勘察，不 import）：
 *   apps/desktop/src/browser-guests.ts:29-42,72-93,111-126,156-169
 *   apps/desktop/src/preload-browser.ts:19-31
 *   packages/client/ui-sidebar-browser/src/client/browser/url.ts:25-45
 *   packages/client/ui-sidebar-browser/src/client/electron/ElectronWebviewPresentation.ts:52-60
 */

/** 独立 partition key：不与侧栏浏览器的 cwd:<path> 共享登录态；dsh 重启后 Cookie 清空。 */
export const BROWSER_WORKSPACE = 'world:desktop-browser'
/** P1 单窗口多标签；多窗口（上限 3）留到 P2，常量先定下来。 */
export const MAX_TABS = 8
export const MAX_WINDOWS = 3
export const MAX_ADDRESS_LENGTH = 16 * 1024
export const HOME_TAB = Object.freeze({ url: '', title: '新标签页' })

const FAILURE_TEXT = Object.freeze({
  empty: '请输入网址',
  invalid: '网址格式不正确或过长',
  protocol: '内置浏览器只支持 http / https 网址',
  credentials: '网址不能包含用户名或密码',
  'application-origin': '不能打开 DSH 自身的服务地址',
  'tab-limit': `最多只能打开 ${MAX_TABS} 个标签，请先关闭一个`,
  'bridge-failed': '无法申请网页容器，已切换到兼容模式',
  'load-failed': '网页加载失败',
})

export function describeBrowserFailure(reason) {
  return FAILURE_TEXT[reason] || String(reason || '未知错误')
}

/**
 * 解析地址栏输入，规则与侧栏浏览器 url.ts 对齐（含主进程 C3/C4 的两条硬约束）。
 * @param {string} input 用户输入
 * @param {string} [applicationOrigin] 当前 DSH 文档 origin，禁止回连宿主自身
 * @returns {{ok: true, target: {url: string, title: string}} | {ok: false, reason: string}}
 */
export function parseBrowserAddress(input, applicationOrigin) {
  const trimmed = String(input == null ? '' : input).trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'invalid' }
  const explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed)
  const candidate = explicitScheme ? trimmed : `https://${trimmed}`
  let url
  try { url = new URL(candidate) } catch { return { ok: false, reason: 'invalid' } }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (applicationOrigin !== undefined && applicationOrigin !== 'null' && applicationOrigin !== '') {
      try {
        if (url.origin === new URL(applicationOrigin).origin) return { ok: false, reason: 'application-origin' }
      } catch {
        // origin 不可解析时不做放行判断，交由主进程策略兜底
      }
    }
    return { ok: true, target: { url: url.href, title: url.hostname } }
  }
  return { ok: false, reason: 'protocol' }
}

/** 地址栏在无法读取跨域 URL 时用的短标签，绝不读页面正文。 */
export function hostLabel(url) {
  try { return new URL(url).hostname || '网页' } catch { return '网页' }
}

/**
 * webview 的启动属性。src 必须是 about:blank#<lease>，partition/name 必须逐字节匹配租约，
 * 否则主进程 will-attach-webview 会 preventDefault（browser-guests.ts:72-93）。
 * data-sidebar-browser-frame 是宿主快捷键转发识别 guest 的标记（preload-app.ts:47-51）。
 */
export function createGuestAttributes(reservation) {
  const lease = reservation?.lease
  const partition = reservation?.partition
  if (typeof lease !== 'string' || lease === '' || typeof partition !== 'string' || partition === '') {
    throw new Error('invalid browser reservation')
  }
  return {
    src: `about:blank#${lease}`,
    partition,
    name: lease,
    allowpopups: '',
    'data-sidebar-browser-frame': 'webview',
  }
}

/** 三档后端探测：只有 protocolVersion === 1 且三件套齐全才走 webview。 */
export function resolveBrowserBridge(root = globalThis) {
  const api = root?.dshDesktop
  if (api?.protocolVersion !== 1) return null
  const bridge = api?.browser
  if (!bridge || typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function'
    || typeof bridge.onOpenRequested !== 'function') return null
  return bridge
}

/**
 * 标签状态机。snapshot 是缓存的不可变对象，可直接喂给 useSyncExternalStore。
 * 一个 tab 不持有 DOM：元素由 browser-app.js 按 tab.id 命令式挂载，切标签不销毁。
 */
export function createTabStore({ maxTabs = MAX_TABS } = {}) {
  let nextId = 0
  let tabs = []
  let activeId = null
  let snapshot = { tabs, activeId, version: 0 }
  const listeners = new Set()

  const publish = () => {
    snapshot = { tabs, activeId, version: snapshot.version + 1 }
    for (const listener of [...listeners]) listener()
  }
  const makeTab = patch => ({
    id: `tab${++nextId}`,
    ...HOME_TAB,
    address: 'requested',
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    mode: 'pending',
    ...patch,
  })

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get activeId() { return activeId },
    /** 触顶返回 null，不静默丢页。 */
    addTab(patch = {}) {
      if (tabs.length >= maxTabs) return null
      const tab = makeTab(patch)
      tabs = [...tabs, tab]
      activeId = tab.id
      publish()
      return tab
    },
    update(id, patch) {
      const index = tabs.findIndex(tab => tab.id === id)
      if (index < 0) return null
      const tab = { ...tabs[index], ...patch }
      tabs = [...tabs.slice(0, index), tab, ...tabs.slice(index + 1)]
      publish()
      return tab
    },
    activate(id) {
      if (activeId === id || !tabs.some(tab => tab.id === id)) return false
      activeId = id
      publish()
      return true
    },
    /** 关最后一个标签时保留一个空白新标签页（不自动关窗）。 */
    closeTab(id) {
      const index = tabs.findIndex(tab => tab.id === id)
      if (index < 0) return { removed: null, replacement: null }
      const removed = tabs[index]
      if (tabs.length === 1) {
        const replacement = makeTab()
        tabs = [replacement]
        activeId = replacement.id
        publish()
        return { removed, replacement }
      }
      const next = tabs.filter(tab => tab.id !== id)
      if (activeId === id) activeId = next[Math.min(index, next.length - 1)].id
      tabs = next
      publish()
      return { removed, replacement: null }
    },
  }
}

/**
 * lease 池：acquire 一个标签一次，release 严格恰好一次，dispose 兜底全部释放。
 * watchOpen 订阅随该 lease 一起注销，避免 _blank 回调打到已关闭的标签。
 */
export function createLeasePool({ bridge, workspace = BROWSER_WORKSPACE, onError } = {}) {
  const leases = new Map()
  let disposed = false
  const report = error => { try { onError?.(error) } catch {} }

  async function acquire() {
    if (!bridge || disposed) throw new Error('browser bridge unavailable')
    const reservation = await bridge.acquire(workspace)
    if (!reservation || typeof reservation.lease !== 'string' || typeof reservation.partition !== 'string') {
      throw new Error('invalid browser reservation')
    }
    // acquire 期间整窗被卸载：立刻归还，绝不把 lease 泄漏给主进程
    if (disposed) {
      try { await bridge.release(reservation.lease) } catch (error) { report(error) }
      throw new Error('browser pool disposed')
    }
    leases.set(reservation.lease, { unsubs: new Set() })
    return reservation
  }

  function watchOpen(lease, listener) {
    const record = leases.get(lease)
    if (!record || typeof bridge?.onOpenRequested !== 'function') return () => {}
    let unsubscribe = () => {}
    try { unsubscribe = bridge.onOpenRequested(lease, listener) || (() => {}) }
    catch (error) { report(error) }
    const dispose = () => {
      if (!record.unsubs.has(dispose)) return
      record.unsubs.delete(dispose)
      try { unsubscribe() } catch (error) { report(error) }
    }
    record.unsubs.add(dispose)
    return dispose
  }

  async function release(lease) {
    const record = leases.get(lease)
    if (!record) return false
    leases.delete(lease)
    for (const dispose of [...record.unsubs]) dispose()
    try { await bridge.release(lease) } catch (error) { report(error) }
    return true
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    await Promise.all([...leases.keys()].map(release))
  }

  return {
    acquire, release, watchOpen, dispose,
    has: lease => leases.has(lease),
    get size() { return leases.size },
  }
}
