/** Static PB export reader. Scripts are source ranges, never evaluated or duplicated per view. */
import { createMenuReader } from './srm-model.js'
import { bindingCode, eachBinding } from './srw-bindings.js'
import { scanSrd } from './srd-model.js'

const ident = '[\\w$#-]+'
const typeHeader = new RegExp(`^(global\\s+)?type\\s+(${ident})\\s+from\\s+(${ident})(?:\\s+within\\s+(${ident}))?`, 'i')
const fnHeader = new RegExp(`^(?:(?:public|protected|private|global|local|shared)\\s+)*(function|subroutine)\\s+(?:${ident}(?:\\[\\])?\\s+)?(${ident})\\s*\\(`, 'i')
const eventHeader = /^event\s+(?:type\s+[\w$#-]+\s+)?([\w$#-]+)\b/i
const prop = /^(?:(?:[\w$#-]+)\s+)?([\w.]+)\s*=\s*(.+)$/i
const nonVisual = /^(?:nonvisualobject|transaction|datastore|pipeline|timing|error|dynamicdescriptionarea|dynamicstagingarea|inet|internetresult|message|oleobject|mailSession)$/i
// An SRU may derive from a standard visual control even without overriding its dimensions.
const visualBases = new Set('userobject window graphicalobject graphicobject dragobject windowobject animation checkbox commandbutton datawindow dropdownlistbox dropdownpicturelistbox editmask graph groupbox hprogressbar hscrollbar htrackbar inkedit inkpicture line listbox listview mdiclient multilineedit olecontrol olecustomcontrol oval picture picturebutton picturehyperlink picturelistbox polygon radiobutton rectangle richtextedit roundrectangle singlelineedit statichyperlink statictext tab tabpage treeview vprogressbar vscrollbar vtrackbar'.split(' '))
const lower = s => s.toLowerCase()
const prefixes = new Map(Object.entries({ cb: 'commandbutton', dw: 'datawindow', st: 'statictext', tv: 'treeview', mle: 'multilineedit', sle: 'singlelineedit', pb: 'picturebutton' }))
// Preserve quoted text and strip comments only outside PB strings (~ escapes the next character).
function codeLine(raw, lex) {
  if (!lex.block && !lex.quote && !/["'\/]/.test(raw)) return raw
  let out = '', start = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i], next = raw[i + 1]
    if (lex.block) {
      if (c === '*' && next === '/') { lex.block = false; start = ++i + 1 }
    } else if (lex.quote) {
      if (c === '~') i++; else if (c === lex.quote) lex.quote = ''
    } else if (c === '"' || c === "'") lex.quote = c
    else if (c === '/' && next === '/') return out + raw.slice(start, i)
    else if (c === '/' && next === '*') { out += raw.slice(start, i) + ' '; lex.block = true; i++ }
  }
  return out + (lex.block ? '' : raw.slice(start))
}
function literal(value) {
  const v = value.trim(), q = v[0]
  return (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1).replace(/~(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c)) : v
}
function* assignments(text) {
  let start = 0, quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === '~') i++; else if (c === quote) quote = '' }
    else if (c === '"' || c === "'") quote = c
    else if (c === ';') { yield text.slice(start, i); start = i + 1 }
  }
  yield text.slice(start)
}
export const pbX = n => Math.round(Number(n) * 7 / 32)
export const pbY = n => Math.round(Number(n) / 4)
export function* scanSrw(text, filename) {
  // Application type prototypes are global by ownership, not by access modifier.
  const extension = lower(filename.split('.').pop()), sru = extension === 'sru', sra = extension === 'sra'
  const declares = { global: [], shared: [], instance: [], globalExternal: [], localExternal: [] }
  const model = { root: null, objects: new Map(), scripts: [], variables: declares.instance, declares, isApplication: sra, partial: false }
  const menu = extension === 'srm' && createMenuReader(literal)
  const stem = lower(filename.split(/[\\/]/).pop().replace(/\.sr[wuam]$/i, ''))
  let owner, section = '', sectionKind = '', block = null, variable = null, directive = false, ignored = false
  let publicVars = true, prototypes
  const lex = { block: false, quote: '' }
  const object = (name, base, within = '') => {
    const id = lower(name)
    let obj = model.objects.get(id)
    if (!obj) { obj = { id, name, base, within: lower(within), props: Object.create(null), scripts: [], children: [] }; model.objects.set(id, obj) }
    return obj
  }
  const assign = (obj, s) => { const m = prop.exec(s); if (m && obj) obj.props[lower(m[1])] = literal(m[2]) }
  for (let start = 0, line = 1; start < text.length; line++) {
    const end = text.indexOf('\n', start), next = end < 0 ? text.length : end + 1
    const eol = end < 0 ? next : end, raw = text.slice(start, text.charCodeAt(eol - 1) === 13 ? eol - 1 : eol), offset = start
    start = next
    if (!(line % 128)) yield
    const trimmed = raw.trim()
    if (!lex.block && !lex.quote && trimmed.startsWith('@') && !/^@end\b/i.test(trimmed)) {
      const head = /^@([\w$#-]+)\.(sr\w)\.(?:([\w$#-]+)\.)?(.+)$/i.exec(trimmed)
      if (head) {
        ignored = lower(head[2]) !== extension || lower(head[1]) !== stem; block = null; section = ''; directive = !ignored
        if (!ignored) {
          model.partial = true; model.root ||= object(head[1], menu ? 'menu' : sra ? 'application' : sru ? '' : 'window')
          owner = head[3] ? object(head[3], menu ? 'menu' : prefixes.get(lower(head[3]).split('_')[0]) || 'userobject', model.root.id) : model.root
        }
      }
    }
    if (ignored) continue
    if (directive && !lex.block && !lex.quote && trimmed.startsWith('//:')) {
      const cmd = /^\/\/:(\w+):(.*)$/i.exec(trimmed)
      if (cmd && owner) {
        const op = lower(cmd[1]), val = cmd[2].trim()
        // Never let a script textarea overwrite layout directives or overlapping variable ranges.
        if (block && block.editStart != null) {
          if (!text.slice(block.editStart, offset).trim()) block.editStart = next
          else block.editStart = null
        }
        if (op === 'set_attribute' || op === 'set_win_attribute') for (const s of assignments(val)) assign(op === 'set_win_attribute' ? model.root : owner, s.trim())
        if (op === 'ctrl_type') owner.base = val
        if (op === 'within') owner.within = lower(val)
        if (op === 'type_variables' || (sra && op === 'global_variables')) declares[op === 'type_variables' ? 'instance' : 'global'].push({ start: offset + raw.indexOf(':', raw.indexOf('//:') + 3) + 1, end: offset + raw.length, owner: owner.id, inline: true, complete: true })
      }
      continue
    }
    const insideString = Boolean(lex.quote)
    let code = codeLine(raw, lex).trim()
    if (insideString || !code) continue
    if (directive) code = code.replace(/^@[\w$#-]+\.sr[wuam]\.(?:[\w$#-]+\.)?/i, '').replace(/^@end\s/i, 'end ')
    if (block) {
      if (blockEnds[block.kind].test(code)) { block.end = offset; block.complete = true; block = null }
      else if (menu && block.kind === 'on' && lower(block.name) === 'create') menu.read(model.objects.get(block.owner), code)
      continue
    }
    if (section) {
      if (sra && section === 'forward') {
        const ref = /^global\s+([\w$#-]+)\s+([\w$#-]+)$/i.exec(code)
        if (ref && nonVisual.test(ref[1])) object(ref[2], ref[1], stem)
      }
      if (section === 'type' && owner === model.root && /^end\s+type$/i.test(code)) model.variableInsertion = next
      if (section === 'type' && !/^end\s+type\b/i.test(code)) {
        assign(owner, code)
        const event = eventHeader.exec(code)
        if (event && owner) (owner.declaredMembers ||= []).push({name:event[1],kind:'event',signature:code})
      }
      if (section === 'prototypes' && sectionKind === 'forward') {
        const fn = fnHeader.exec(code)
        if (fn && model.root) (model.root.declaredMembers ||= []).push({name:fn[2],kind:lower(fn[1]),signature:code})
      }
      if (section === 'variables' && !/^end\s+variables\b/i.test(code)) {
        if (sru && variable && owner && owner === model.root) {
          const access = /^(public|protected|private):$/i.exec(code)
          if (access) publicVars = lower(access[1]) === 'public'
          const scalar = /^(?:(public|private|protected)\s+)?(string|boolean|u?long|unsignedlong|u?int|integer|unsignedinteger|longlong|byte|double|real|decimal|dec)\s+([\w$#-]+)(?:\s*=\s*(.+))?$/i.exec(code)
          if (scalar && (scalar[1] ? lower(scalar[1]) === 'public' : publicVars)) {
            owner.instanceProps ||= Object.create(null)
            owner.instanceProps[lower(scalar[3])] = scalar[4] ? literal(scalar[4]) : ({ boolean: 'false', string: '' }[lower(scalar[2])] ?? '0')
          }
        }
        const ref = /^([\w$#-]+)\s+([\w$#-]+)\s*$/i.exec(code)
        if (ref && nonVisual.test(ref[1])) object(ref[2], ref[1], owner?.id)
      }
      if (section === 'prototypes' && sectionKind === 'type') {
        const last = prototypes.runs.at(-1), closing = /^end\s+prototypes$/i.test(code)
        // Only a new declaration changes scope. Continued signatures, comments,
        // indentation and blank lines belong to the same editable source run.
        const kind = sra || /^global\b/i.test(code) ? 'globalExternal'
          : /^(?:(?:public|protected|private|local)\s+)*(?:function|subroutine)\b/i.test(code) ? 'localExternal' : last?.kind || 'localExternal'
        if ((!closing && kind !== last?.kind) || (closing && !last && offset > prototypes.start)) {
          if (last) last.end = offset
          const run = { kind, start: last ? offset : prototypes.start, end: text.length, owner: owner?.id }
          prototypes.runs.push(run); declares[kind].push(run)
        }
        if (closing) {
          if (prototypes.runs.length) prototypes.runs.at(-1).end = offset
          for (const run of prototypes.runs) run.complete = true
          model.prototypeInsertion ??= offset
          section = ''; sectionKind = ''
        }
        continue
      }
      if (lower(code) === `end ${section}`) {
        if (section === 'variables') for (const range of declares[sectionKind]) if (range.end > offset) { range.end = offset; range.complete = true }
        variable = null; section = ''; sectionKind = ''
      }
      continue
    }
    if (/^forward$/i.test(code)) { section = 'forward'; continue }
    if (/^(type|forward)\s+prototypes$/i.test(code)) {
      section = 'prototypes'; sectionKind = /^type/i.test(code) ? 'type' : 'forward'
      if (sectionKind === 'type') { prototypes = { start: next, runs: [] }; model.hasPrototypes = true }
      continue
    }
    if (/^(type|shared|global)\s+variables$/i.test(code)) {
      publicVars = true; section = 'variables'
      sectionKind = /^type/i.test(code) ? 'instance' : /^shared/i.test(code) ? 'shared' : 'global'
      const range = { start: next, end: text.length, owner: owner?.id, kind: sectionKind }
      declares[sectionKind].push(range)
      if (sectionKind === 'instance') variable = range
      continue
    }
    if (model.root && lower(code).split(/\s+/).join(' ') === `global ${model.root.id} ${model.root.id}`) model.variableInsertion = next
    const type = (menu ? menu.typeHeader : typeHeader).exec(code)
    if (type) {
      owner = object(type[2], type[3], type[4]); section = 'type'
      if (type[1] || (!model.root && !type[4])) model.root = owner
      if (sru && owner === model.root) owner.autoInstantiate = /\bautoinstantiate\b/i.test(code.slice(type[0].length))
      continue
    }
    const ev = eventHeader.exec(code), fn = !ev && fnHeader.exec(code), life = !ev && !fn && (menu ? menu.lifeHeader : /^on\s+([\w$#-]+)\.([\w$#-]+)/i).exec(code)
    if ((sru || sra) && !model.root && (fn || ev)) { model.partial = true; model.root = owner = object(stem, sra ? 'application' : '') }
    const target = life ? model.objects.get(lower(life[1])) : owner || model.root
    if ((!ev && !fn && !life) || !target) continue
    const kind = ev ? 'event' : fn ? lower(fn[1]) : 'on', name = ev ? ev[1] : fn ? fn[2] : life[2]
    block = { id: `${target.id}:${kind}:${lower(name)}:${offset}`, owner: target.id, name, kind, line, start: offset, end: text.length,
      signature: code.split(';', 1)[0] }
    const semi = raw.indexOf(';')
    // Leave the signature and the terminating end event/function/on outside the editable body.
    block.editStart = life ? next : semi < 0 ? null : raw.slice(semi + 1).trim() ? offset + semi + 1 : next
    target.scripts.push(block); model.scripts.push(block)
  }
  let finalized = 0
  for (const obj of model.objects.values()) {
    if (!(++finalized % 128)) yield
    obj.nonvisual = nonVisual.test(obj.base)
    if (obj !== model.root) (model.objects.get(obj.within) || model.root)?.children.push(obj)
  }
  if (menu) menu.link(model)
  const root = model.root
  // For external ancestors only use evidence local to the export, never a name prefix or script text.
  model.hasLayout = sru ? Boolean(root && !root.nonvisual && (visualBases.has(lower(root.base)) || root.props.width != null || root.props.height != null ||
    root.children.some(o => o.within && !o.nonvisual && lower(o.base) !== 'structure'))) : !sra
  if (sru && root?.base && !visualBases.has(lower(root.base)) && !nonVisual.test(root.base)) model.customBase = root.base
  if (root && !model.hasLayout) root.nonvisual = true
  return model
}
const blockEnds = { event: /^end\s+event\b/i, on: /^end\s+on\b/i, function: /^end\s+function\b/i, subroutine: /^end\s+subroutine\b/i }

// Navigation is a one-member query, not a second painter model or a project-wide symbol index.
// Walk the live target once (CodeMirror Text or a native source string), retaining just two line numbers.
function* sourceLines(text, from = 0, to = text.length) {
  if (from >= to) { yield ''; return }
  do {
    const end = text.indexOf('\n', from)
    if (end < 0 || end >= to) { yield text.slice(from,to); return }
    yield text.slice(from,end); from = end+1
  } while (from < to)
}

// Reuse this painter's parsed objects and scripts. Only an unmatched name needs a walk of
// its declaration pages; never materialize the full draft or a second index to find one row.
export async function findPainterMember(session, scope, member, signal) {
  signal.throwIfAborted()
  const model = session.model, owner = model.objects.get(lower(scope)), name = lower(member)
  if (!owner) return null
  const script = owner.scripts.find(s => lower(s.name) === name)
  if (script) return { view:'script', object:owner.id, script:script.id, key:script.id, line:1 }
  const child = model.objects.get(name)
  if (child?.within === owner.id) return { object:child.id, view:child.nonvisual || !session.hasLayout ? 'properties'
    : lower(child.base) === 'datawindow' && lower(child.props.visible || '') === 'false' ? 'controls' : 'layout' }
  if (session.isSrm) return null // The menu painter has no Variables page.
  let visited = 0, until = performance.now()+5
  for (const kind of ['localExternal','instance','shared','globalExternal','global']) {
    if (!model.isApplication && kind.startsWith('global')) continue // These panes show the application's SRA, not this file.
    const key = `declare:${kind}`, patch = session.edits.patches.get(key), ranges = model.declares[kind]
    const owned = r => (r.owner || model.root?.id) === owner.id
    if (patch ? (ranges.length ? !ranges.every(owned) : owner !== model.root) : !ranges.some(owned)) continue
    let line = 0
    // Original ranges are joined with one newline in the pane; a modified page is already one CM Text.
    for (const range of patch ? [null] : ranges) {
      const lex = {mode:''}, relevant = !range || owned(range)
      for (const raw of patch ? patch.doc.iterLines() : sourceLines(session.text,range.start,range.end)) {
        line++
        if (!(++visited % 128) && performance.now() >= until) {
          await new Promise(resolve => setTimeout(resolve,0)); signal.throwIfAborted(); until = performance.now()+5
        }
        if (!relevant) continue
        const code = bindingCode(raw,lex).trim()
        if (!lower(code).includes(name)) continue
        let found = false
        if (kind.endsWith('External')) found = lower(fnHeader.exec(code)?.[2] || '') === name
        else for (const stmt of code.split(';')) eachBinding(stmt, id => { if (lower(id) === name) found = true })
        if (found) return {view:'variables', object:owner.id, declare:kind, key, line}
      }
    }
  }
  return null
}
export async function findMemberDefinition(text, scope, member, signal) {
  scope = lower(scope); member = lower(member)
  let owner = scope, section = '', body = '', declaration, typeLine, line = 0, until = performance.now()+5
  const lex = { mode:'' }
  for (const raw of typeof text === 'string' ? sourceLines(text) : text.iterLines()) {
    if (!(line++ % 128)) {
      if (performance.now() >= until) { await new Promise(resolve => setTimeout(resolve,0)); until = performance.now()+5 }
      signal?.throwIfAborted()
    }
    const code = bindingCode(raw, lex).trim()
    if (!code) continue
    const directive = /^@([\w$#-]+)\.sr\w\.(?:([\w$#-]+)\.)?(.+)$/i.exec(code)
    const header = directive ? directive[3] : code
    if (directive) { owner = lower(directive[2] || directive[1]); section = body = '' }
    if (body) { if (blockEnds[body].test(header.replace(/^@end\b/i,'end'))) body = ''; continue }
    if (section === 'forward') { if (/^end\s+forward$/i.test(header)) section = ''; continue }
    if (/^end\s+(?:prototypes|type|variables)$/i.test(header)) { section = ''; continue }
    if (/^forward$/i.test(header)) { section = 'forward'; continue }
    if (/^(?:forward|type)\s+prototypes$/i.test(header)) { section = 'prototypes'; continue }
    if (/^(?:global|type|shared)\s+variables$/i.test(header)) { section = 'variables'; continue }
    const type = typeHeader.exec(header)
    if (type) {
      owner = lower(type[2]); section = 'type'
      if (owner === scope) typeLine ??= line
      if (owner === member && lower(type[4] || '') === scope) declaration = line // Prefer the type body to its field in the container.
      continue
    }
    const fn = fnHeader.exec(header), ev = !fn && eventHeader.exec(header)
    if (fn || ev) {
      if (!section) body = fn ? lower(fn[1]) : 'event'
      if (owner === scope && lower(fn ? fn[2] : ev[1]) === member) {
        if (body) return { line, member:true }
        declaration ??= line // Prefer an implementation to a forward or external prototype.
      }
    } else if (!section && /^on\s+/i.test(header)) body = 'on'
    else if (!declaration && owner === scope && (section === 'variables' || section === 'type') && lower(header).includes(member)) {
      eachBinding(header, name => { if (lower(name) === member) declaration = line })
      const assigned = prop.exec(header)
      if (assigned && lower(assigned[1]) === member) declaration ??= line
    }
  }
  return {line:declaration || typeLine || 1, member:Boolean(declaration)}
}

// Keep the same cancellable, time-sliced indexing for the tab preset and for a regenerated source.
function parseAsync(text, path, ready, scan = scanSrw) {
  const parser = scan(text, path)
  let timer
  const tick = () => {
    const until = performance.now() + 6
    do { const result = parser.next(); if (result.done) { ready(result.value); return } } while (performance.now() < until)
    timer = setTimeout(tick, 0)
  }
  timer = setTimeout(tick, 0)
  return () => { clearTimeout(timer); parser.return() }
}

// A derived SRU can be completely empty. Follow only sibling SRUs, never open editor tabs or inherit editable ranges.
export function parsePainter(text, path, ready, readBase) {
  if (/\.srd$/i.test(path)) return parseAsync(text, path, ready, scanSrd)
  const controller = new AbortController(), seen = new Set(), chain = []
  let cancel
  const next = async model => {
    chain.push(model)
    const base = model.customBase
    if (readBase && base && chain.length < 12 && !seen.has(lower(base))) {
      seen.add(lower(base))
      let source
      try { source = await readBase(base, controller.signal) } catch { /* absent or outside the current library */ }
      if (controller.signal.aborted) return
      if (typeof source === 'string') {
        cancel = parseAsync(source, `${base}.sru`, ancestor => ancestor.root?.id === lower(base) ? next(ancestor) : finish())
        return
      }
    }
    finish()
  }
  const finish = () => {
    chain.at(-1).unresolvedBase = chain.at(-1).customBase
    for (let i = chain.length - 2; i >= 0; --i) {
      const child = chain[i], parent = chain[i + 1]
      child.hasLayout = parent.unresolvedBase ? child.hasLayout || parent.hasLayout : parent.hasLayout
      child.root.nonvisual = !child.hasLayout
      child.root.instanceProps = { ...parent.root.instanceProps, ...child.root.instanceProps }
      child.root.props = { ...parent.root.props, ...child.root.props }
      child.root.nativeBase = parent.root.nativeBase || parent.root.base
      child.root.inheritedMembers = [...(parent.root.declaredMembers || []), ...parent.root.scripts, ...(parent.root.inheritedMembers || [])]
        .filter(m => m.kind !== 'on' && !/^private\s/i.test(m.signature))
        .map(({name,kind,signature}) => ({name,kind,signature}))
      child.unresolvedBase = parent.unresolvedBase
    }
    ready(chain[0])
  }
  cancel = parseAsync(text, path, next)
  return () => { controller.abort(); cancel() }
}
