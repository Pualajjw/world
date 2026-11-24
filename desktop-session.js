// Only window state and file-tab metadata are persisted. Never serialize a host session, editor
// draft, browser URL, terminal process, or a launch/open request for later execution.
const KEY = ['dsh.world', 'desktop-session', 'v1'].join('.')
const singles = new Set(['dsh','terminal','browser','lanchat'])
const string = v => typeof v === 'string' ? v : ''
const isStoredFolder = path => typeof path === 'string' && /^(?:[a-z]:\/|\/)/i.test(path)
  && !/[\x00-\x1f\\]|(?:^|\/)\.{1,2}(?:\/|$)/.test(path)
const rectOf = r => ['x','y','w','h'].every(k => Number.isFinite(r?.[k])) && r.w > 0 && r.h > 0
  ? { x:r.x, y:r.y, w:r.w, h:r.h } : null

export function saveDesktopSession({single, editors, plugins, external, active, stack, pinned, docked}) {
  const windows = []
  const add = (id, {state,rect,lastOpen}, meta) => {
    if (state !== 'closed') windows.push({id, state, rect:rectOf(rect), lastOpen, ...meta})
  }
  for (const [id, win] of Object.entries(single)) add(id,win)
  for (const w of editors) add(`vscode:${w.key}`,w,{root:w.rootPath, extraRoots:w.extraRoots, collection:w.collectionId, fileSession:w.fileSession || undefined, session:w.session?.id || w.restoreSessionId})
  for (const w of plugins) add(`plugin:${w.key}`,w,{conversation:w.conversationSessionId})
  for (const w of external) add(`ext:${w.id}`,w)
  const docks = docked.map(({id,owner,visible}) => ({id,owner,visible:!!visible}))
  try { localStorage.setItem(KEY, JSON.stringify({windows,active,stack,pinned:[...pinned],docks})) } catch { /* optional storage */ }
}

export function readDesktopSession({installed, plugins, external, holders, fit}) {
  const empty = {single:{}, editors:[], plugins:[], external:[], stack:[], pinned:[], docks:[], active:'dsh', sequence:0}
  let saved
  try { saved = JSON.parse(localStorage.getItem(KEY)) } catch { return empty }
  if (!Array.isArray(saved?.windows)) return empty
  const output = {...empty}, ids = new Map()
  for (const w of saved.windows) {
    const id = string(w?.id), rect = rectOf(w?.rect)
    if (!rect || ids.has(id) || !['normal','min','max'].includes(w.state)) continue
    const split = id.indexOf(':'), kind = split < 0 ? id : id.slice(0,split), key = id.slice(split+1)
    const win = {state:w.state, lastOpen:w.lastOpen === 'max' ? 'max' : 'normal'}
    if (singles.has(id) && (id === 'dsh' || installed.has(id))) output.single[id] = win
    else if (kind === 'vscode' && installed.has(kind) && /^win[1-9]\d{0,8}$/.test(key)) {
      if (w.collection && !holders.has(w.collection)) continue
      output.editors.push(Object.assign(win,{key, rootPath:string(w.root),
        extraRoots:Array.isArray(w.extraRoots) && w.root && !w.collection ? w.extraRoots.filter(isStoredFolder) : undefined,
        collectionId:string(w.collection), fileSession:w.fileSession, restoreSessionId:string(w.session)}))
      output.sequence = Math.max(output.sequence,Number(key.slice(3)))
    } else if (kind === 'plugin' && (plugins.has(key) || (w.conversation && key === `world-conversation:${w.conversation}`))) {
      output.plugins.push(Object.assign(win,{key,conversationSessionId:key.startsWith('world-conversation:') ? string(w.conversation) : undefined}))
    } else if (kind === 'ext' && external.has(key)) output.external.push(Object.assign(win,{id:key}))
    else continue
    win.rect = fit(kind,rect); ids.set(id,win)
  }
  const known = list => Array.isArray(list) ? [...new Set(list)].filter(id => ids.has(id)) : []
  output.pinned = known(saved.pinned)
  output.stack = known(saved.stack).filter(id => ids.get(id).state !== 'min')
  output.active = saved.active === 'desktop' || output.stack.includes(saved.active) ? saved.active : output.stack.at(-1) || 'desktop'
  if (Array.isArray(saved.docks)) output.docks = saved.docks.filter(d => d && ids.has(d.id) && !d.id.startsWith('vscode:')
    && ids.has(`vscode:${d.owner}`)).sort((a,b) => Number(!!a.visible) - Number(!!b.visible))
  return output
}
