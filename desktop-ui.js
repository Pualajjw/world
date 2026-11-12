import { desktopError } from './desktop-client.js'
import { UI_ACTIONS, validateUiCommand } from './desktop-ui-protocol.js'

const fail = (message, code = 'WORLD_UI_INVALID') => { throw desktopError(message, code) }
const stale = () => fail('界面已经变化，请重新读取窗口布局后再操作。', 'WORLD_UI_STALE')
const tidy = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180)
const selectors = 'button,a[href],input,textarea,select,summary,[role],[tabindex],[contenteditable="true"],[draggable="true"],[aria-label],[data-nodeid],canvas,iframe,webview,h1,h2,h3,label,p,pre'
const round = value => Math.round(value * 100) / 100
const pack = rect => ({ x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) })
const contains = (rect, point) => point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < 1)
const intersect = (a, b) => ({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y),
  width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
  height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) })
const parentOf = node => node.parentElement || node.getRootNode?.().host || node.ownerDocument?.defaultView?.frameElement || null

function rootsFor(id) {
  let root
  if (id === 'dsh') return [document.querySelector('.world-window-frame'), document.getElementById('root'),
    ...[...document.body.children].filter(node => node.id !== 'root' && !node.dataset.worldPortal && node.dataset.windowsMenu === undefined
      && (node.matches('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]') || node.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')))].filter(Boolean)
  if (id === 'browser') root = document.querySelector('.world-browser-window')
  else if (id === 'lanchat') root = document.querySelector('.world-lanchat-window')
  else if (id === 'terminal') root = document.querySelector('.world-terminal-window')
  else if (id.startsWith('plugin:')) root = [...document.querySelectorAll('[data-world-plugin]')].find(node => node.dataset.worldPlugin === id.slice(7))
  else if (id.startsWith('vscode:')) root = [...document.querySelectorAll('[data-world-vscode-key]')].find(node => node.dataset.worldVscodeKey === id.slice(7))
  else if (id.startsWith('ext:')) root = [...document.querySelectorAll('[data-world-app-id]')].find(node => node.dataset.worldAppId === id.slice(4))
  const roots = root ? [root] : []
  if (id.startsWith('plugin:')) roots.push(...[...document.querySelectorAll('body > [data-world-dialog]')]
    .filter(node => node.dataset.worldDialog === id.slice(7) && node.dataset.worldAssistantDialog !== 'true'))
  return roots
}

function globalRect(node) {
  let rect = pack(node.getBoundingClientRect()), view = node.ownerDocument.defaultView
  while (view && view !== window) {
    const frame = view.frameElement
    if (!frame) break
    const outer = frame.getBoundingClientRect(), sx = outer.width / (frame.offsetWidth || outer.width || 1), sy = outer.height / (frame.offsetHeight || outer.height || 1)
    rect = { x: outer.x + (frame.clientLeft + rect.x) * sx, y: outer.y + (frame.clientTop + rect.y) * sy,
      width: rect.width * sx, height: rect.height * sy }
    view = frame.ownerDocument.defaultView
  }
  return pack(rect)
}

function within(node, roots) {
  for (let current = node; current;) {
    if (roots.some(root => root === current || root.contains(current))) return true
    current = parentOf(current)
  }
  return false
}

function accessibleName(node) {
  const text = element => element?.innerText ?? element?.textContent ?? ''
  const labels = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => text(node.ownerDocument.getElementById(id))).join(' ')
  return tidy(node.getAttribute('aria-label') || labels || [...(node.labels || [])].map(text).join(' ')
    || node.getAttribute('title') || node.getAttribute('placeholder') || node.getAttribute('alt')
    || (node.hasAttribute('data-nodeid') ? `端口 ${node.dataset.nodeid} ${node.dataset.handleid || node.dataset.handlepos || ''}`
      : node.matches('button,a,summary,label,p,pre,h1,h2,h3,[role="button"],[role="group"],[role="option"],[role="menuitem"],[role="tab"]') ? text(node) : ''))
}

function roleOf(node) {
  return node.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: ['checkbox', 'radio', 'range'].includes(node.type) ? node.type : 'textbox',
    TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button', CANVAS: 'canvas', IFRAME: 'frame', WEBVIEW: 'frame', LABEL: 'label' }[node.tagName])
    || (node.hasAttribute('data-nodeid') ? 'port' : /^H[1-6]$/.test(node.tagName) ? 'heading' : 'region')
}

function identityOf(node) {
  const context = node.closest('tr,li,[role="row"],[role="listitem"],[role="group"],[data-id]')
  const secret = node.tagName === 'INPUT' && (['password', 'file'].includes(node.type) || /password/i.test(node.autocomplete || ''))
  const value = !secret && 'value' in node ? String(node.value) : ''
  return JSON.stringify({ attributes: ['id', 'name', 'type', 'data-id', 'data-nodeid', 'data-handleid', 'aria-controls'].map(key => node.getAttribute(key)),
    value: secret ? null : [value.length, value.slice(0, 500)], checked: 'checked' in node ? node.checked : null,
    context: context ? [context.getAttribute('data-id'), tidy(context.innerText ?? context.textContent)] : null })
}

function visibleRect(node, windowRect) {
  const style = node.ownerDocument.defaultView.getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || node.closest('[hidden],[inert],[aria-hidden="true"]')) return null
  let rect = intersect(globalRect(node), windowRect)
  rect = intersect(rect, { x: 0, y: 0, width: innerWidth, height: innerHeight })
  for (let parent = node.parentElement; parent && rect.width > 0 && rect.height > 0; parent = parent.parentElement) {
    const css = parent.ownerDocument.defaultView.getComputedStyle(parent), bounds = globalRect(parent)
    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) rect = intersect(rect, { ...rect, x: bounds.x, width: bounds.width })
    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) rect = intersect(rect, { ...rect, y: bounds.y, height: bounds.height })
  }
  return rect.width > 0 && rect.height > 0 ? pack(rect) : null
}

function* elements(root, depth = 0) {
  yield root
  for (const node of root.querySelectorAll('*')) {
    if (node.matches(selectors)) yield node
    if (node.shadowRoot && depth < 4) yield* elements(node.shadowRoot, depth + 1)
    if (node.tagName === 'IFRAME' && depth < 4) {
      try { if (node.contentDocument?.body) yield* elements(node.contentDocument.body, depth + 1) } catch {}
    }
  }
}

function framePoint(node, point) {
  const frames = []
  for (let view = node.ownerDocument.defaultView; view && view !== window; view = view.frameElement.ownerDocument.defaultView) frames.unshift(view.frameElement)
  let local = point
  for (const frame of frames) { const rect = frame.getBoundingClientRect(); local = { x: (local.x - rect.x) * (frame.offsetWidth / rect.width) - frame.clientLeft,
    y: (local.y - rect.y) * (frame.offsetHeight / rect.height) - frame.clientTop } }
  return local
}

function nextFrame(signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = error => { cancelAnimationFrame(frame); clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
    const abort = () => finish(signal.reason)
    const frame = requestAnimationFrame(() => finish())
    const timer = setTimeout(() => finish(), 40)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Current DOM geometry and bounded input for world-owned windows; no injected scripts/selectors. */
export function createDesktopUi({ getState, activate, dispatch = body => body(), onHumanInput = () => {}, onPointer }) {
  const ids = new WeakMap(), snapshots = new Map(), observedFrames = new Map()
  let sequence = 0, busy = false, disposed = false
  const lifetime = new AbortController()
  const captured = new Map()
  let passthrough = null
  const pointerDispatch = (node, body) => dispatch(() => {
    if (!passthrough && !disposed) {
      passthrough = document.createElement('style')
      passthrough.textContent = '.world-control-overlay,.world-control-overlay *,[data-world-assistant-dialog],[data-world-assistant-dialog] *{pointer-events:none!important}'
      document.head.append(passthrough)
      passthrough.sheet.disabled = true
    }
    const prototype = node.ownerDocument.defaultView.Element.prototype
    const original = Object.fromEntries(['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'].map(key => [key, prototype[key]]))
    const pointerId = 2147483646
    prototype.setPointerCapture = function (id) { if (id === pointerId) captured.set(id, this); else return original.setPointerCapture.call(this, id) }
    prototype.releasePointerCapture = function (id) { if (id === pointerId) captured.delete(id); else return original.releasePointerCapture.call(this, id) }
    prototype.hasPointerCapture = function (id) { return id === pointerId ? captured.get(id) === this : original.hasPointerCapture.call(this, id) }
    const sheet = passthrough?.sheet
    if (sheet) sheet.disabled = false
    try { return body() }
    finally { if (sheet) sheet.disabled = true; for (const [key, value] of Object.entries(original)) prototype[key] = value }
  })
  const idFor = node => { if (!ids.has(node)) ids.set(node, `ui-${++sequence}`); return ids.get(node) }
  const bounds = id => { const root = rootsFor(id)[0]; return root ? globalRect(root) : null }
  const frameInput = doc => {
    if (doc === document || observedFrames.has(doc)) return
    const input = event => { if (event.isTrusted) onHumanInput() }
    for (const type of ['pointerdown', 'wheel', 'keydown']) doc.addEventListener(type, input, true)
    observedFrames.set(doc, () => { for (const type of ['pointerdown', 'wheel', 'keydown']) doc.removeEventListener(type, input, true) })
  }
  function layout(args = {}) {
    const state = getState(), windows = [], max = args.maxElements || 400
    let remaining = max
    const requested = args.windowId ? state.windows.filter(win => win.id === args.windowId) : state.windows
    if (args.windowId && !requested.length) fail('窗口不存在或已关闭。', 'WORLD_DESKTOP_WINDOW')
    for (const win of requested) {
      const roots = rootsFor(win.id), rect = bounds(win.id), items = [], nodes = new Map(), visited = new Set()
      const snapshotId = crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-')
      if (win.state !== 'min' && rect) for (const root of roots) for (const node of elements(root)) {
        if (node.nodeType !== 1 || visited.has(node)) continue
        visited.add(node)
        const clipped = visibleRect(node, rect)
        if (!clipped || remaining <= 0) continue
        frameInput(node.ownerDocument)
        const id = idFor(node), role = roleOf(node), name = accessibleName(node), fullRect = globalRect(node)
        const sensitive = node.tagName === 'INPUT' && (node.type === 'password' || /password/i.test(node.autocomplete || ''))
        const entry = { id, tag: node.tagName.toLowerCase(), role, name, rect: fullRect, visibleRect: clipped,
          disabled: node.matches(':disabled,[aria-disabled="true"]'), readOnly: Boolean(node.readOnly), focused: node.ownerDocument.activeElement === node }
        entry.attributes = Object.fromEntries(['id', 'name', 'type', 'data-id', 'data-nodeid', 'data-handleid', 'data-handlepos', 'data-testid']
          .filter(key => node.hasAttribute(key)).map(key => [key, node.getAttribute(key).slice(0, 160)]))
        if ('value' in node && !sensitive && node.type !== 'file') {
          const value = String(node.value)
          entry.value = value.slice(0, 500)
          entry.valueLength = value.length
          entry.valueTruncated = value.length > 500
        }
        if (sensitive || node.type === 'file') entry.valueOmitted = true
        if ('checked' in node) entry.checked = Boolean(node.checked)
        if (node.hasAttribute('aria-expanded')) entry.expanded = node.getAttribute('aria-expanded') === 'true'
        if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
          entry.scroll = { left: node.scrollLeft, top: node.scrollTop, width: node.scrollWidth, height: node.scrollHeight, clientWidth: node.clientWidth, clientHeight: node.clientHeight }
        if (node.tagName === 'SELECT') entry.options = [...node.options].slice(0, 80).map(option => ({ value: option.value, label: tidy(option.label), disabled: option.disabled }))
        if (['IFRAME', 'WEBVIEW'].includes(node.tagName)) {
          let readable = false
          try { readable = node.tagName === 'IFRAME' && Boolean(node.contentDocument?.body) } catch {}
          entry.contentReadable = readable
          if (!readable) entry.unsupported = '跨域网页 / 原生 guest 内容需要 Desktop 原生输入与布局通道。'
        }
        const frame = node.ownerDocument.defaultView.frameElement
        if (frame) entry.frameId = idFor(frame)
        let parent = parentOf(node)
        while (parent && !nodes.has(idFor(parent))) parent = parentOf(parent)
        if (parent) entry.parentId = idFor(parent)
        nodes.set(id, { node, rect: fullRect, name, identity: identityOf(node) })
        items.push(entry); remaining--
      }
      const snapshot = { snapshotId, windowId: win.id, controlId: state.control.controlId, rect, nodes, roots }
      snapshots.set(win.id, snapshot)
      windows.push({ windowId: win.id, name: win.name, state: win.state, active: win.active, rect, snapshotId,
        elements: items, truncated: remaining <= 0 })
    }
    for (const id of snapshots.keys()) if (!state.windows.some(win => win.id === id)) snapshots.delete(id)
    for (const [doc, off] of observedFrames) {
      let connected = false
      try { connected = Boolean(doc.defaultView?.frameElement?.isConnected) } catch {}
      if (!connected) { off(); observedFrames.delete(doc) }
    }
    return { capturedAt: Date.now(), viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      coordinateSpace: 'viewport-css-pixels', inputBackend: 'dom', trustedInput: false,
      capabilities: { actions: UI_ACTIONS, nativeDialogs: false, nativeGuests: false, cssHover: false }, windows }
  }
  function resolveTarget(snapshot, id, point) {
    let target = id && snapshot.nodes.get(id)
    if (id && !target) stale()
    if (!target && point) {
      const candidates = [...snapshot.nodes.values()].filter(item => contains(item.rect, point))
      target = candidates.at(-1)
    }
    if (!target) fail('坐标处没有当前布局中的可操作元素，请重新读取布局。')
    let { node } = target
    if (!node.isConnected || !within(node, rootsFor(snapshot.windowId)) || !sameRect(target.rect, globalRect(node))
      || target.name !== accessibleName(node) || target.identity !== identityOf(node)) stale()
    if (node.matches(':disabled,[aria-disabled="true"]')) fail('目标控件已禁用。', 'WORLD_UI_DISABLED')
    if (node.tagName === 'INPUT' && node.type === 'file') fail('系统文件选择框需要原生输入通道。', 'WORLD_UI_UNSUPPORTED')
    if (['IFRAME', 'WEBVIEW'].includes(node.tagName)) fail('请操作可读取的 frame 内部元素；跨域 / 原生网页需要宿主输入通道。', 'WORLD_UI_UNSUPPORTED')
    const clip = visibleRect(node, snapshot.rect)
    if (!clip) stale()
    const location = point || { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 }
    if (!contains(clip, location)) fail('坐标不在目标控件的当前可见区域内。')
    // The assistant's own translucent panel may cover the work area; other app windows may not.
    const local = framePoint(node, location)
    const top = node.ownerDocument.elementsFromPoint(local.x, local.y).find(item => !item.closest?.('.world-control-overlay,[data-world-assistant-dialog]'))
    if (top && !within(top, rootsFor(snapshot.windowId))) fail('目标被另一个窗口遮挡，请先将目标窗口置前并重读布局。', 'WORLD_UI_OCCLUDED')
    if (id && top && top !== node && !node.contains(top)) fail('目标被其他控件或对话框遮挡，请先处理遮挡后重读布局。', 'WORLD_UI_OCCLUDED')
    if (!id && top && within(top, rootsFor(snapshot.windowId))) node = top
    return { node, point: location }
  }
  const event = (node, type, point, options = {}) => pointerDispatch(node, () => {
    const view = node.ownerDocument.defaultView, local = framePoint(node, point)
    const settings = { bubbles: true, cancelable: true, composed: true, view, clientX: local.x, clientY: local.y,
      pointerId: 2147483646, pointerType: 'mouse', isPrimary: true, ...options }
    const Constructor = type.startsWith('pointer') ? view.PointerEvent : type === 'wheel' ? view.WheelEvent : view.MouseEvent
    return node.dispatchEvent(new Constructor(type, settings))
  })
  const focus = node => dispatch(() => {
    const target = node.closest('button,input,textarea,select,a[href],summary,[tabindex],[contenteditable="true"]') || node
    target.focus({ preventScroll: true })
  })
  async function execute(raw, signal) {
    if (disposed) fail('窗口操作已卸载。', 'WORLD_DESKTOP_TAKEN_OVER')
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const args = validateUiCommand(raw)
    if (busy) fail('另一个界面动作尚未结束，请等待结果后再继续。', 'WORLD_UI_BUSY')
    const snapshot = snapshots.get(args.windowId), state = getState()
    if (!snapshot || snapshot.snapshotId !== args.snapshotId || snapshot.controlId !== state.control.controlId) stale()
    const win = state.windows.find(win => win.id === args.windowId)
    if (!win || win.state === 'min' || !sameRect(snapshot.rect, bounds(args.windowId) || {})) stale()
    busy = true
    try {
      signal.throwIfAborted()
      await activate(args.windowId, signal)
      signal.throwIfAborted()
      const target = resolveTarget(snapshot, args.targetId, args.x === undefined ? null : { x: args.x, y: args.y })
      const modifiers = Object.fromEntries((args.modifiers || []).map(value => [{ Control: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', Meta: 'metaKey' }[value], true]))
      const modifierKeys = args.action === 'press_key' ? [] : args.modifiers || []
      const sendModifiers = type => dispatch(() => {
        const held = type === 'keyup' ? { ...modifiers } : {}
        for (const key of modifierKeys) {
          held[{ Control: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', Meta: 'metaKey' }[key]] = type === 'keydown'
          target.node.dispatchEvent(new target.node.ownerDocument.defaultView.KeyboardEvent(type,
            { bubbles: true, cancelable: true, key, code: `${key}Left`, ...held }))
        }
      })
      sendModifiers('keydown')
      try { await perform(args, target, snapshot, modifiers, signal) }
      finally { sendModifiers('keyup') }
      await nextFrame(signal)
      signal.throwIfAborted()
      if (!getState().windows.some(win => win.id === args.windowId)) {
        snapshots.delete(args.windowId)
        return { windowId: args.windowId, action: args.action, delivery: 'dom', closed: true, layout: layout() }
      }
      return { windowId: args.windowId, action: args.action, delivery: 'dom', layout: layout({ windowId: args.windowId }) }
    } finally { busy = false }
  }
  async function perform(args, target, snapshot, modifiers, signal) {
    const { node, point } = target
    if (onPointer && ['hover', 'click', 'double_click', 'context_click', 'drag', 'scroll'].includes(args.action)) {
      onPointer(point, snapshot.controlId, args.action)
      await nextFrame(signal)
      if (resolveTarget(snapshot, args.targetId, point).node !== node) stale()
    }
    if (args.action === 'focus_element') { focus(node); return }
    if (['hover', 'click', 'double_click', 'context_click'].includes(args.action)) {
      event(node, 'pointerover', point, modifiers); event(node, 'mouseover', point, modifiers)
      event(node, 'pointermove', point, modifiers); event(node, 'mousemove', point, modifiers)
      if (args.action === 'hover') return
      const button = args.action === 'context_click' ? 2 : 0, count = args.action === 'double_click' ? 2 : 1
      for (let index = 1; index <= count; index++) {
        signal.throwIfAborted()
        event(node, 'pointerdown', point, { ...modifiers, button, buttons: button === 2 ? 2 : 1, detail: index })
        event(node, 'mousedown', point, { ...modifiers, button, buttons: button === 2 ? 2 : 1, detail: index })
        focus(node)
        event(node, 'pointerup', point, { ...modifiers, button, buttons: 0, detail: index })
        event(node, 'mouseup', point, { ...modifiers, button, buttons: 0, detail: index })
        event(node, button === 2 ? 'contextmenu' : 'click', point, { ...modifiers, button, detail: index })
      }
      if (count === 2) event(node, 'dblclick', point, { ...modifiers, detail: 2 })
      return
    }
    if (args.action === 'scroll') {
      const allowed = event(node, 'wheel', point, { ...modifiers, deltaX: args.deltaX || 0, deltaY: args.deltaY || 0, deltaMode: 0 })
      if (allowed) {
        let scroller = node
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight || scroller.scrollWidth > scroller.clientWidth)) scroller = scroller.parentElement
        if (!scroller || !within(scroller, snapshot.roots)) fail('目标区域没有可滚动的容器。', 'WORLD_UI_UNSUPPORTED')
        scroller.scrollBy({ left: args.deltaX || 0, top: args.deltaY || 0, behavior: 'instant' })
      }
      return
    }
    if (['fill', 'type_text', 'select_option'].includes(args.action)) {
      // Typing is an action too: park the cursor on the field so the pulse lands where the text goes.
      onPointer?.(point, snapshot.controlId, args.action)
      focus(node)
      if (node.readOnly || node.disabled) fail('目标不能编辑。', 'WORLD_UI_DISABLED')
      const view = node.ownerDocument.defaultView
      if (args.action === 'select_option') {
        if (node.tagName !== 'SELECT' || ![...node.options].some(option => option.value === args.value && !option.disabled)) fail('请选择布局中存在且可用的选项。')
        dispatch(() => { Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value').set.call(node, args.value)
          node.dispatchEvent(new view.Event('input', { bubbles: true })); node.dispatchEvent(new view.Event('change', { bubbles: true })) })
        return
      }
      if (!['INPUT', 'TEXTAREA'].includes(node.tagName) && !node.isContentEditable) fail('目标不是文本输入控件。')
      if (node.tagName === 'INPUT' && ['file', 'checkbox', 'radio', 'button', 'submit', 'hidden'].includes(node.type)) fail('此控件不接受文本输入。')
      dispatch(() => {
        if (args.action === 'type_text' || node.isContentEditable) {
          if (args.action === 'fill') node.ownerDocument.execCommand('selectAll')
          if (!node.ownerDocument.execCommand('insertText', false, args.text)) fail('此编辑器不支持当前文本插入，请改用 fill 或其原生控件。', 'WORLD_UI_UNSUPPORTED')
        } else {
          const prototype = node.tagName === 'INPUT' ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, args.text)
          node.dispatchEvent(new view.Event('input', { bubbles: true })); node.dispatchEvent(new view.Event('change', { bubbles: true }))
        }
      })
      return
    }
    if (args.action === 'press_key') { pressKey(node, args.key, modifiers, dispatch, snapshot.roots); return }
    if (args.action === 'drag') { await drag(target, resolveTarget(snapshot, args.toTargetId, args.toX === undefined ? null : { x: args.toX, y: args.toY }), modifiers, signal, snapshot.controlId); return }
    fail('不支持的界面动作。')
  }
  async function drag(from, to, modifiers, signal, controlId) {
    const view = from.node.ownerDocument.defaultView
    if (from.node.ownerDocument !== to.node.ownerDocument) fail('跨 frame 拖拽需要原生输入通道。', 'WORLD_UI_UNSUPPORTED')
    if (from.node.draggable) {
      const transfer = new view.DataTransfer(), send = (node, type, point) => pointerDispatch(node, () => node.dispatchEvent(new view.DragEvent(type,
        { bubbles: true, cancelable: true, view, ...framePoint(node, point), clientX: framePoint(node, point).x, clientY: framePoint(node, point).y, dataTransfer: transfer })))
      send(from.node, 'dragstart', from.point)
      try {
        if (onPointer) for (let step = 1; step <= 12; step++) {
          signal.throwIfAborted()
          onPointer({ x: from.point.x + (to.point.x - from.point.x) * step / 12, y: from.point.y + (to.point.y - from.point.y) * step / 12 }, controlId)
          await nextFrame(signal)
        }
        signal.throwIfAborted(); send(to.node, 'dragenter', to.point); send(to.node, 'dragover', to.point); await nextFrame(signal)
        signal.throwIfAborted(); send(to.node, 'drop', to.point) }
      finally { send(from.node, 'dragend', to.point) }
      return
    }
    const protect = event => { if (event.isTrusted) event.stopImmediatePropagation() }
    for (const type of ['pointermove', 'mousemove']) view.addEventListener(type, protect, true)
    let finished = false
    try {
      event(from.node, 'pointerdown', from.point, { ...modifiers, button: 0, buttons: 1 })
      event(from.node, 'mousedown', from.point, { ...modifiers, button: 0, buttons: 1 })
      for (let step = 1; step <= 12; step++) {
        signal.throwIfAborted()
        const point = { x: from.point.x + (to.point.x - from.point.x) * step / 12, y: from.point.y + (to.point.y - from.point.y) * step / 12 }
        onPointer?.(point, controlId)
        const local = framePoint(from.node, point), hit = pointerDispatch(from.node, () => from.node.ownerDocument.elementFromPoint(local.x, local.y)) || from.node
        event(captured.get(2147483646) || from.node, 'pointermove', point, { ...modifiers, buttons: 1 })
        event(hit, 'mousemove', point, { ...modifiers, buttons: 1 })
        await nextFrame(signal)
      }
      signal.throwIfAborted()
      event(to.node, 'pointerup', to.point, { ...modifiers, button: 0 })
      event(to.node, 'mouseup', to.point, { ...modifiers, button: 0 })
      finished = true
    } finally {
      try {
        if (!finished) {
          event(from.node, 'pointercancel', from.point, { buttons: 0 })
          if (from.node.isConnected) event(from.node, 'mouseup', from.point, { buttons: 0 })
          else dispatch(() => view.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, view, buttons: 0 })))
        }
      } catch { /* The source realm may have navigated or unmounted during cancellation. */ }
      finally {
        for (const type of ['pointermove', 'mousemove']) try { view.removeEventListener(type, protect, true) } catch {}
        captured.clear()
      }
    }
  }
  return { bounds, layout, execute, dispose() {
    disposed = true; lifetime.abort(desktopError('桌面已卸载。', 'WORLD_DESKTOP_TAKEN_OVER'))
    snapshots.clear(); passthrough?.remove(); passthrough = null
    for (const off of observedFrames.values()) off()
    observedFrames.clear()
  } }
}

function pressKey(node, key, modifiers, dispatch, roots) {
  const parts = key.split('+'), name = parts.pop(), keys = { ...modifiers }
  for (const part of parts) {
    const prop = { Control: 'ctrlKey', Ctrl: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', Meta: 'metaKey' }[part]
    if (!prop) fail('快捷键修饰符无效。')
    keys[prop] = true
  }
  if (/^F\d+$/.test(name) || (keys.altKey && name === 'F4') || ((keys.ctrlKey || keys.metaKey) && ['r', 'l', 'w', 't', 'n'].includes(name.toLowerCase())))
    fail('系统 / 宿主窗口级快捷键不属于虚拟窗口控件操作。', 'WORLD_UI_UNSUPPORTED')
  const view = node.ownerDocument.defaultView, normalized = name === 'Space' ? ' ' : name
  const init = { bubbles: true, cancelable: true, composed: true, key: normalized,
    code: normalized.length === 1 && /[a-z]/i.test(normalized) ? `Key${normalized.toUpperCase()}` : name, ...keys }
  dispatch(() => {
    node.focus({ preventScroll: true })
    const held = {}, modifierNames = { ctrlKey: 'Control', shiftKey: 'Shift', altKey: 'Alt', metaKey: 'Meta' }
    for (const [prop, modifier] of Object.entries(modifierNames)) if (keys[prop]) {
      held[prop] = true
      node.dispatchEvent(new view.KeyboardEvent('keydown', { bubbles: true, key: modifier, code: `${modifier}Left`, ...held }))
    }
    try {
    const allowed = node.dispatchEvent(new view.KeyboardEvent('keydown', init))
    if (allowed) {
      const editable = node.tagName === 'TEXTAREA' || node.isContentEditable || (node.tagName === 'INPUT' && !['file', 'checkbox', 'radio', 'button', 'submit', 'range', 'hidden'].includes(node.type))
      if (name === 'Tab') {
        const entries = roots.flatMap(root => [...root.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')])
          .filter(item => item.tabIndex >= 0 && !item.matches(':disabled,[hidden],[aria-hidden="true"]') && item.getClientRects().length)
        const current = entries.indexOf(node), next = entries[(current + (keys.shiftKey ? -1 : 1) + entries.length) % entries.length]
        next?.focus({ preventScroll: true })
      } else
      if (editable && (keys.ctrlKey || keys.metaKey) && name.toLowerCase() === 'a') {
        if (node.select) node.select(); else node.ownerDocument.execCommand('selectAll')
      } else if (editable && (keys.ctrlKey || keys.metaKey) && ['z', 'y'].includes(name.toLowerCase())) {
        node.ownerDocument.execCommand(name.toLowerCase() === 'y' || keys.shiftKey ? 'redo' : 'undo')
      } else if (editable && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(name) && 'selectionStart' in node && node.selectionStart !== null) {
        const start = node.selectionStart, end = node.selectionEnd, delta = name === 'ArrowLeft' ? -1 : 1
        const anchor = node.selectionDirection === 'backward' ? end : start, active = node.selectionDirection === 'backward' ? start : end
        const position = name === 'Home' ? 0 : name === 'End' ? node.value.length : !keys.shiftKey && start !== end ? delta < 0 ? start : end
          : Math.max(0, Math.min(node.value.length, (keys.shiftKey ? active : start) + delta))
        node.setSelectionRange(keys.shiftKey ? Math.min(anchor, position) : position, keys.shiftKey ? Math.max(anchor, position) : position, position < anchor ? 'backward' : 'forward')
      } else if (editable && !keys.ctrlKey && !keys.metaKey && !keys.altKey) {
        if (['Backspace', 'Delete'].includes(name)) node.ownerDocument.execCommand(name === 'Backspace' ? 'delete' : 'forwardDelete')
        else if (name === 'Enter' && (node.tagName === 'TEXTAREA' || node.isContentEditable)) node.ownerDocument.execCommand('insertText', false, '\n')
        else if (name === 'Enter' && node.form) node.form.requestSubmit()
        else if (normalized.length === 1) node.ownerDocument.execCommand('insertText', false, normalized)
      } else if (['Enter', ' '].includes(normalized) && node.matches('button,summary,a[href],input[type="checkbox"],input[type="radio"]')) node.click()
    }
    node.dispatchEvent(new view.KeyboardEvent('keyup', init))
    } finally {
      for (const [prop, modifier] of Object.entries(modifierNames)) if (keys[prop]) {
        held[prop] = false
        node.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true, key: modifier, code: `${modifier}Left`, ...held }))
      }
    }
  })
}
