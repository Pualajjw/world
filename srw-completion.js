import { autocompletion, closeCompletion, insertCompletionText, pickedCompletion, startCompletion } from '@codemirror/autocomplete'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, tooltips } from '@codemirror/view'
import { bindingCode as codeLine, eachBinding, splitList } from './srw-bindings.js'
import { PB_CONTROL, PB_KEYWORD, PB_TYPES } from './highlight.js'
// Offline member signatures from the repository's src/types/{window,commandbutton,statictext,datawindow}.json.
import controlApi from './srw-control-api.json' with {type:'json'}

// Local-only PowerScript completion. The source is created for one mounted editable
// body. Immutable model members may be shared across scripts; draft locals must not be.
const word = '[\\p{L}_$][\\p{L}\\p{N}_$#-]*', tail = new RegExp(`(${word})$`, 'u')
const ident = /^[\p{L}\p{N}_$#-]*$/u
const limit = 64, step = 128
function applyName(view, option, from, to) {
  // Completing in the middle of Message|Box replaces the identifier, not its arguments.
  const line = view.state.doc.lineAt(to), rest = /^[\p{L}\p{N}_$#-]*/u.exec(line.text.slice(to-line.from))[0]
  view.dispatch({...insertCompletionText(view.state, option.label, from, to + rest.length), annotations: pickedCompletion.of(option)})
}
const item = (label, type, detail, boost = 0) => ({label, type, detail, boost, apply:applyName})
const sort = options => options.map(option => [option.label.toLowerCase(), option]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
let builtinIndex
function builtins() {
  return builtinIndex ||= sort([
    ...'MessageBox IsNull SetNull IsValid Len Left Right Mid Pos Trim Upper Lower Replace Space String Int Long Dec Real Double Date DateTime Time Today Now Abs Round Mod Min Max UpperBound LowerBound ClassName TypeOf Open Close OpenWithParm CloseWithReturn IsNumber IsDate IsTime RelativeDate DaysAfter FileOpen FileClose FileRead FileWrite FileExists GetProfileString SetProfileString'.split(' ').map(s => item(s,'function','PB 函数')),
    ...[...PB_TYPES].filter(s => s !== 'longptr').map(s => item(s,'type','类型')),
    ...[...PB_CONTROL,...PB_KEYWORD].map(s => item(s,'keyword','关键字')),
  ])
}
function declarations(code, kind, out) {
  eachBinding(code, (name, spelling, type, array) => {
    const opt = item(name,'variable',`${kind} · ${spelling}`, 8)
    if (!array) opt.receiverType = type // An unindexed array isn't an object receiver.
    out.set(name.toLowerCase(),opt)
  })
}
function scanDeclLine(code, kind, names) {
  if (!code) return
  if (!code.includes(';')) return declarations(code,kind,names)
  for (const stmt of code.split(';')) declarations(stmt,kind,names)
}
const memberCache = new WeakMap()
function members(owner) {
  if (!owner) return []
  if (!memberCache.has(owner)) memberCache.set(owner, sort([
    ...Object.keys(owner.props).map(k => item(k,'property','属性',4)),
    ...owner.children.map(o => item(o.name,'variable',o.base,4)),
    ...[...owner.scripts, ...(owner.declaredMembers || []), ...(owner.inheritedMembers || [])].filter(s => s.kind !== 'on')
      .map(s => item(s.name, s.kind === 'event' ? 'method' : 'function', `${s.kind === 'event' ? '事件' : '对象函数'} · ${s.signature}`, 6)),
  ]))
  return memberCache.get(owner)
}
const baseCache = new WeakMap()
function standardMembers(type) {
  const name = (type || '').toLowerCase()
  if (!Object.hasOwn(controlApi,name)) return []
  const api = controlApi[name]
  if (!baseCache.has(api)) baseCache.set(api, sort([
    ...Object.entries(api.functions).map(([k,sig]) => item(k,'function',`对象函数 · ${sig}`)),
    ...Object.entries(api.events).map(([k,sig]) => item(k,'method',`事件 · ${sig}`)),
    ...Object.entries(api.properties).map(([k,type]) => item(k,'property',`属性 · ${type}`)),
  ]))
  return baseCache.get(api)
}
// Binary prefix lookup. Never give CodeMirror thousands of candidates to score on
// each input. If this page is full, a narrower prefix requests the correct next page.
function lowerBound(list, key) {
  let lo = 0, hi = list.length
  while (lo < hi) { const mid = (lo+hi) >>> 1; if (list[mid][0] < key) lo = mid+1; else hi = mid }
  return lo
}
function exactName(list, name) {
  const entry = list[lowerBound(list,name)]
  return entry?.[0] === name ? entry[1] : undefined
}
// Chunks are immutable declaration snapshots. Remember one exact receiver (including
// a miss) on the head so narrowing a member prefix doesn't search the chunks again.
function priorLocal(head, name) {
  if (!head || head.lastName === name) return head?.lastLocal
  let local
  for (let chunk = head; chunk; chunk = chunk.previous) {
    local = exactName(chunk.list,name)
    if (local) break
  }
  head.lastName = name; head.lastLocal = local
  return local
}
function collect(lists, prefix) {
  const seen = new Map(), starts = lists.map(list => lowerBound(list,prefix))
  // A broad `this.` must not spend all 64 slots on instance variables before showing
  // a single function or event. Keep the first (nearest) definition on duplicates.
  let more = true
  while (more && seen.size < limit) {
    more = false
    for (let n=0; n<lists.length && seen.size<limit; n++) {
      const entry = lists[n][starts[n]]
      if (entry && entry[0].startsWith(prefix)) {
        more = true; starts[n]++
        if (!seen.has(entry[0])) seen.set(entry[0],entry[1])
      }
    }
  }
  return [...seen.values()]
}
// A Declare page can also be large. Read ranges line by line, share their name
// indexes across scripts, and replace the cache entry when a declaration draft changes.
const scopeCache = new WeakMap()
function* rangeLines(source, start, end) {
  while (start < end) {
    const lf = source.indexOf('\n', start), stop = lf < 0 ? end : Math.min(lf,end)
    yield source.slice(start,stop); start = stop+1
  }
}
const interrupted = ctx => ctx.aborted || ctx.view && (!ctx.view.dom.isConnected || ctx.view.state.doc !== ctx.state.doc)
async function indexPage(groups, label, ctx) {
  const vars = new Map()
  let lines = 0, until = performance.now()+5
  for (const group of groups) {
    const lex = {mode:''}
    for (const line of group) {
      scanDeclLine(codeLine(line,lex),label,vars)
      if (++lines % step === 0 && performance.now() >= until) {
        await new Promise(resolve => setTimeout(resolve,0))
        if (interrupted(ctx)) return null
        until = performance.now()+5
      }
    }
  }
  return vars
}
async function scopePage(session, kind, ctx) {
  if (interrupted(ctx) || !session.model) return []
  let cache = scopeCache.get(session)
  if (!cache) scopeCache.set(session,cache = new Map())
  const patch = session.edits.patches.get(`declare:${kind}`)?.doc, model = session.model
  let entry = cache.get(kind)
  const label = {instance:'实例变量',shared:'共享变量',global:'全局变量'}[kind]
  if (!entry) {
    const groups = model.declares[kind].map(r => rangeLines(session.text,r.start,r.end))
    const vars = await indexPage(groups,label,ctx)
    if (!vars) return []
    const inherited = kind !== 'instance' ? [] : Object.keys(model.root?.instanceProps || {})
      .filter(name => !vars.has(name)).map(name => item(name,'property','继承属性',4))
    entry = {inherited, original:sort([...vars.values(), ...inherited])}; cache.set(kind, entry)
  }
  if (!patch) { entry.patch = entry.draft = null; return entry.original }
  if (patch !== entry.patch) {
    const vars = await indexPage([patch.iterLines()],label,ctx)
    if (!vars) return []
    entry.patch = patch; entry.draft = sort([...vars.values(), ...entry.inherited.filter(o => !vars.has(o.label.toLowerCase()))])
  }
  return entry.draft
}
export function createScriptSource(session, script) {
  const chunks = [], owner = session.model.objects.get(script.owner)
  const params = new Map(), args = /\((.*)\)/.exec(script.signature)?.[1] || ''
  for (const arg of splitList(args)) declarations(arg,'参数',params)
  const parameters = sort([...params.values()])
  // Each checkpoint contains only declarations and end-of-chunk lexical mode, not source lines.
  let cursorPrefix = null // declarations and lexer mode strictly BEFORE this line
  function invalidate(line) {
    chunks.length = Math.min(chunks.length, Math.floor((line-1)/step))
    if (cursorPrefix && line < cursorPrefix.line) cursorPrefix = null
  }
  async function lookup(ctx, member) {
    const {state, pos, explicit} = ctx
    if (!member && (state.readOnly || !state.selection.main.empty || ctx.view?.compositionStarted)) return null
    const line = state.doc.lineAt(pos), before = line.text.slice(0,pos-line.from), typed = tail.exec(before.slice(-256))?.[0] || ''
    const head = before.slice(0,before.length-typed.length), dotted = /\.\s*$/.test(head)
    if (member ? !dotted : !explicit && !dotted && typed.length < 2) return null
    const {root, objects} = session.model, parent = owner?.within ? objects.get(owner.within) : null
    let receiver = owner, namedReceiver, variable
    if (dotted) {
      const match = /(?:^|[^\p{L}\p{N}_$#.\-])([\p{L}_$][\p{L}\p{N}_$#-]*)\s*\.\s*$/u.exec(head)
      const name = match?.[1].toLowerCase()
      if (!name) return null
      if (name === 'this' || name === 'parent') {
        receiver = name === 'this' ? owner : parent
        if (!receiver) return null
      } else namedReceiver = name
    }
    if (typed && /[\p{L}\p{N}_$#]/u.test(head.slice(-1))) return null
    if (!member) ctx.addEventListener('abort', () => {}, {onDocChange:true})
    const block = Math.floor((line.number-1)/step)
    // Build only completed chunks before the cursor. An edit discards the changed
    // suffix. A cold jump to a far line yields to input and is cancellable on edit.
    let until = performance.now()+5
    while (chunks.length < block) {
      const start = chunks.length*step+1, lex = {mode:chunks.at(-1)?.mode || ''}, vars = new Map()
      for (const text of state.doc.iterLines(start,start+step)) scanDeclLine(codeLine(text,lex),'局部变量',vars)
      const list = sort([...vars.values()]), previous = chunks.at(-1)?.locals
      // Skip declaration-free chunks entirely when collecting local names.
      chunks.push({mode:lex.mode, locals:list.length ? {list, previous} : previous})
      if (performance.now() >= until) {
        await new Promise(resolve => setTimeout(resolve,0))
        if (interrupted(ctx)) return null
        until = performance.now()+5
      }
    }
    const start = block*step+1
    if (!cursorPrefix || cursorPrefix.line > line.number || cursorPrefix.line < start) {
      cursorPrefix = {line:start, mode:chunks[block-1]?.mode || '', vars:new Map(), list:null}
    }
    if (cursorPrefix.line < line.number) {
      const lex = {mode:cursorPrefix.mode}
      for (const text of state.doc.iterLines(cursorPrefix.line,line.number)) scanDeclLine(codeLine(text,lex),'局部变量',cursorPrefix.vars)
      cursorPrefix.mode = lex.mode; cursorPrefix.line = line.number; cursorPrefix.list = null
    }
    const lex = {mode:cursorPrefix.mode}
    const code = codeLine(before,lex)
    if (lex.mode || lex.comment) return null
    const lists = []
    const history = chunks[block-1]?.locals
    let inline
    if (!dotted || namedReceiver) {
      const lastSemi = code.lastIndexOf(';')
      if (lastSemi >= 0) {
        inline = new Map(); scanDeclLine(code.slice(0,lastSemi),'局部变量',inline)
      }
    }
    if (namedReceiver) {
      variable = inline?.get(namedReceiver) || cursorPrefix.vars.get(namedReceiver) || priorLocal(history,namedReceiver) || params.get(namedReceiver)
      receiver = variable ? null : objects.get(namedReceiver)
      // Known controls keep their model-specific members. Only unresolved receivers
      // need one exact lookup in the full (uncapped) Instance declaration index.
      if (!variable && !receiver) variable = exactName(await scopePage(session,'instance',ctx),namedReceiver)
      if (member && !variable && !receiver) variable = exactName(await scopePage(session,'shared',ctx),namedReceiver) ||
        exactName(await scopePage(session,'global',ctx),namedReceiver)
      if (!member && !Object.hasOwn(controlApi,variable?.receiverType) && !receiver) return null
    }
    if (member) {
      if (interrupted(ctx)) return null
      if (variable) return variable.receiverType ? {type:variable.receiverType} : null
      if (!receiver) return null
      // Embedded objects may override a member locally. Otherwise prefer their declared base.
      const local = receiver === root || receiver.scripts.some(s => s.name.toLowerCase() === member) ||
        receiver.declaredMembers?.some(s => s.name.toLowerCase() === member)
      return {local:receiver.id, type:local ? null : receiver.base.toLowerCase()}
    }
    if (!dotted) {
      if (inline?.size) lists.push(sort([...inline.values()]))
      lists.push(cursorPrefix.list ||= sort([...cursorPrefix.vars.values()]))
      for (let locals = history; locals; locals = locals.previous) lists.push(locals.list)
      lists.push(parameters)
    }
    if (!dotted || receiver === root) lists.push(await scopePage(session,'instance',ctx))
    lists.push(members(receiver))
    if (!dotted && root !== owner) lists.push(members(root))
    if (!dotted) lists.push(await scopePage(session,'shared',ctx), await scopePage(session,'global',ctx), builtins())
    lists.push(standardMembers(variable?.receiverType || receiver?.nativeBase || receiver?.base))
    if (interrupted(ctx)) return null
    const prefix = typed.toLowerCase(), options = collect(lists,prefix)
    const complete = explicit ? null : new Set(options.map(o => o.label.toLowerCase()))
    if (!options.length || complete?.has(prefix)) return null // Enter on a complete word is still a newline
    return { from:pos-typed.length, options, validFor: options.length < limit ? text => {
      const lower = text.toLowerCase(); return ident.test(text) && lower.startsWith(prefix) && !complete?.has(lower)
    } : undefined }
  }
  return {source: ctx => lookup(ctx, null), resolveMember: (ctx, member) => lookup(ctx, member.toLowerCase()), invalidate}
}
export function scriptCompletion({source, invalidate}, paneGroup) {
  return [EditorState.phrases.of({Completions:'代码提示'}),
    // Sibling panes are isolated stacking contexts. Portal inside this design group,
    // not inside the clipped Script pane or outside the DSH window's focus boundary.
    paneGroup ? tooltips({parent:paneGroup, position:'absolute', tooltipSpace:() => paneGroup.getBoundingClientRect()}) : [],
    autocompletion({override:[source], filterStrict:true, tooltipClass:() => 'world-srw-suggestions'}),
    // Outside composition Windows IMEs can report key=Process (229) even though code=Space.
    // Use the physical key before the generic keymap; Alt+/ also works if Windows owns Ctrl+Space.
    Prec.highest(EditorView.domEventHandlers({
      keydown(e, view) {
        if (e.isComposing || view.compositionStarted || e.metaKey || e.shiftKey || e.getModifierState('AltGraph')) return false
        const manual = (e.ctrlKey && !e.altKey && e.code === 'Space') ||
          (e.altKey && !e.ctrlKey && (e.code === 'Slash' || e.key === '/'))
        if (!manual) return false
        return startCompletion(view)
      },
      compositionstart(_event, view) { closeCompletion(view) },
    })), EditorView.updateListener.of(u => {
      if (u.docChanged) u.changes.iterChangedRanges(from => invalidate(u.startState.doc.lineAt(from).number))
    })]
}
