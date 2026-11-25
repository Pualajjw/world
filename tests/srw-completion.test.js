import test from 'node:test'
import assert from 'node:assert/strict'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState, Text } from '@codemirror/state'
import { readFileSync } from 'node:fs'
import catalog from '../srw-control-api.json' with {type:'json'}
import { scanSrw, parsePainter } from '../srw-model.js'
import { createScriptSource } from '../srw-completion.js'

function fixture(args = 'readonly string as_key', instance = 'string is_name') {
  const text = `global type n_test from nonvisualobject
end type
type variables
${instance}
end variables
global variables
integer gi_version
end variables
public function string of_find (${args});return ""
end function
public function integer of_total ();return 1
end function`
  const parser = scanSrw(text,'n_test.sru'); let done
  do done = parser.next(); while (!done.done)
  const session = {text, model:done.value, edits:{patches:new Map()}}
  return {session, ...createScriptSource(session,session.model.root.scripts[0])}
}
async function ask(f, doc, explicit=false) {
  f.invalidate(1) // each helper call replaces the entire script
  const state = EditorState.create({doc}); return f.source(new CompletionContext(state,state.doc.length,explicit))
}
const labels = r => r?.options.map(o => o.label) || []
test('context-sensitive, case-insensitive Script names; draft variables and parameters',async () => {
  const f = fixture()
  assert.ok(labels(await ask(f,'mEsS')).includes('MessageBox'))
  assert.deepEqual(labels(await ask(f,'this.OF_t')), ['of_total'])
  assert.ok(labels(await ask(f,'THIS.')).includes('is_name'))
  assert.deepEqual(labels(await ask(f,'other.')),[])
  assert.deepEqual(labels(await ask(f,'as_')),['as_key']); assert.deepEqual(labels(await ask(f,'gi_')),['gi_version'])
  assert.deepEqual(labels(await ask(f,'decimal{2} ld_one, ld_two[]\nld_')),['ld_one','ld_two'])
  assert.deepEqual(labels(await ask(f,'return missing\nmi')),['Mid','Min'])
  assert.equal(await ask(f,'m'),null); assert.ok(labels(await ask(f,'m',true)).includes('MessageBox'))
  f.session.edits.patches.set('declare:instance',{doc:Text.of(['string is_new'])})
  assert.deepEqual(labels(await ask(f,'this.is_')), ['is_new'])
  assert.equal(await ask(f,'return'),null); assert.ok(labels(await ask(f,'return',true)).includes('return'))
  assert.deepEqual(labels(await ask(f,'this.as_')),[])
})
test('scalar local members use the declared PB type, not the owner or a same-named object', async () => {
  const f = fixture()
  const r = await ask(f,'DataWindow ldw_main, ldw_detail\nLDW_DETAIL.GeTi')
  assert.ok(labels(r).includes('getitemstring'))
  assert.match(r.options.find(o => o.label === 'getitemstring').detail, /getitemstring\(long r,string c/)
  assert.ok(r.options.every(o => o.label.startsWith('geti')))
  for (const [type, prefix, expected] of [['window','arranges','arrangesheets'],['commandbutton','setf','setfocus'],['statictext','tex','text']]) {
    assert.ok(labels(await ask(f,`${type} obj; obj.${prefix}`)).includes(expected))
  }
  const broad = await ask(f,'datawindow ldw\nldw.')
  assert.equal(broad.options.length,64); assert.ok(!labels(broad).includes('of_total'))
  assert.deepEqual(labels(await ask(f,'DataWindow n_test; n_test.rowc')), ['rowcount'])
  for (const doc of ['string n_test; n_test.of_', 'DataWindow n_test[5]; n_test.rowc',
    'custom_type n_test; n_test.of_', '/* DataWindow ldw */; ldw.rowc',
    'DataWindow ldw\n// ldw.rowc', 'DataWindow ldw\n"ldw.rowc', 'DataWindow ldw\nthis.ldw.rowc']) {
    assert.equal(await ask(f,doc,true),null,doc)
  }
  assert.deepEqual(labels(await ask(f,'n_test.of_t')), ['of_total'])
})
test('scalar parameters resolve from this signature after locals and before named objects', async () => {
  const f = fixture('readonly DataWindow adw, REF window aw, commandbutton ab, statictext ast, datawindow many[], string n_test')
  for (const [expr,label] of [['ADW.GetItemStr','getitemstring'],['aw.arranges','arrangesheets'],['ab.setf','setfocus'],['ast.textc','textcolor']]) {
    assert.deepEqual(labels(await ask(f,expr)),[label])
  }
  assert.deepEqual(labels(await ask(f,'window adw; adw.arranges')),['arrangesheets'])
  for (const doc of ['string adw\nadw.geti','many.rowc','n_test.of_','this.adw','// adw.rowc','"adw.rowc']) {
    assert.equal(await ask(f,doc,true),null,doc)
  }
  const other = createScriptSource(f.session,f.session.model.root.scripts[1])
  assert.equal(await ask(other,'adw.geti'),null)
})
test('instance receivers follow the current declarations, not a stale type or another scope', async () => {
  const f = fixture('window obj', 'datawindow idw_detail, obj, idw_many[]; statictext ist\ncommandbutton ib\nwindow iw')
  for (const [expr,label] of [['IDW_DETAIL.GetItemStr','getitemstring'],['iw.arranges','arrangesheets'],['ib.setf','setfocus'],['ist.textc','textcolor'],['obj.arranges','arrangesheets']]) {
    assert.deepEqual(labels(await ask(f,expr)),[label])
  }
  for (const expr of ['obj.rowc', 'idw_many.rowc', 'string idw_detail; idw_detail.rowc', 'idw.rowc']) {
    assert.equal(await ask(f,expr,true),null,expr)
  }
  const {patches} = f.session.edits
  patches.set('declare:instance',{doc:Text.of(['window idw_detail'])})
  assert.deepEqual(labels(await ask(f,'idw_detail.arranges')),['arrangesheets'])
  assert.equal(await ask(f,'idw_detail.rowc'),null)
  patches.set('declare:instance',{doc:Text.empty})
  patches.set('declare:shared',{doc:Text.of(['window idw_detail'])})
  patches.set('declare:global',{doc:Text.of(['datawindow idw_detail'])})
  assert.equal(await ask(f,'idw_detail.',true),null)
  patches.delete('declare:instance'); assert.deepEqual(labels(await ask(f,'idw_detail.rowc')),['rowcount'])
})
test('instance lookup reuses a large declaration draft and script index when narrowing', async () => {
  const f = fixture(), n = 32087
  const lines = Array.from({length:4096},(_,i)=>`datawindow idw_${i}`); lines.push('datawindow idw_z')
  const draft = Text.of(lines); f.session.edits.patches.set('declare:instance',{doc:draft})
  let state = EditorState.create({doc:Text.of([...Array(n).fill('// ...'),'idw_z.geti'])})
  const query = () => f.source(new CompletionContext(state,state.doc.length,false))
  const orig = Text.prototype.iterLines; let script = 0, decl = 0
  Text.prototype.iterLines = function*(...args) {
    for (const line of orig.apply(this,args)) { if (this === draft) decl++; else script++; yield line }
  }
  try {
    assert.ok(labels(await query()).includes('getitemstring')); assert.equal(decl,draft.lines); assert.equal(script,n)
    script = decl = 0
    f.invalidate(state.doc.lines); state = state.update({changes:{from:state.doc.length,insert:'temstr'}}).state
    assert.deepEqual(labels(await query()),['getitemstring']); assert.equal(decl,0); assert.equal(script,0)
    console.log(`Instance lookup (script/draft lines): cold ${n}/${draft.lines}, warm ${script}/${decl}`)
  } finally { Text.prototype.iterLines = orig }
})
test('never prompt in quoted text, line comments or multiline comments, even explicitly', async () => {
  const f = fixture()
  for (const doc of ['// mess','string s = "x~"mess', "'mess", '/*\nmessage','/*\nthis.','// this.']) assert.equal(await ask(f,doc,true),null)
  assert.ok(labels(await ask(f,'/* hidden\n*/ Mess')).includes('MessageBox'))
})
test('large script: repeated queries on the typing line reuse its prefix; earlier edits invalidate it',async () => {
  const f = fixture(), n = 32087, lines = Array(n).fill('// no declarations'); lines[4] = 'string ls_early'; lines.push('ls_')
  const doc = Text.of(lines), state = EditorState.create({doc}), proto = Text.prototype, orig = proto.iterLines
  let linesVisited=0
  proto.iterLines = function*(...args) { for (const line of orig.apply(this,args)) { linesVisited++; yield line } }
  try {
    const query = state => f.source(new CompletionContext(state,state.doc.length,false))
    assert.deepEqual(labels(await query(state)), ['ls_early']); const cold = linesVisited
    f.invalidate(doc.lines); const next = state.update({changes:{from:doc.length,insert:'e'}}).state
    assert.deepEqual(labels(await query(next)), ['ls_early']); const warm = linesVisited - cold
    console.log('Script prefix index: previous lines visited (cold/warm):',cold,warm)
    assert.ok(cold>=n); assert.equal(warm,0, 'typing on the same line must reuse all previous lines')
    f.invalidate(5); const changed = next.update({changes:{from:doc.line(5).from,to:doc.line(5).to,insert:'string ls_else'}}).state
    assert.deepEqual(labels(await query(changed)),['ls_else'])
  } finally { proto.iterLines = orig }
})

test('local member lookup reuses prior lines in a large declaration-heavy script and invalidates edited types', async () => {
  const f = fixture('ref datawindow adw'), n = 32087, lines = Array.from({length:n},(_,i)=>`long ll_${i}`)
  lines[4]='window obj'; lines[129]='obj.arranges'; lines[140]='datawindow obj'; lines.push('obj.geti')
  let state = EditorState.create({doc:Text.of(lines)})
  const query = (pos=state.doc.length) => f.source(new CompletionContext(state,pos,false))
  const proto = Text.prototype, orig = proto.iterLines; let visited = 0
  proto.iterLines = function*(...args) { for (const line of orig.apply(this,args)) { visited++; yield line } }
  try {
    assert.ok(labels(await query()).includes('getitemstring')); const cold = visited
    f.invalidate(state.doc.lines); state=state.update({changes:{from:state.doc.length,insert:'temstr'}}).state
    assert.deepEqual(labels(await query()), ['getitemstring'])
    console.log('Typed receiver: previous lines visited (cold/warm):',cold,visited-cold)
    assert.equal(cold,n); assert.equal(visited-cold,0)
    // Switching to a parameter and narrowing its prefix must reuse the same script index.
    const last = state.doc.line(state.doc.lines), prevState = state
    f.invalidate(last.number); state=state.update({changes:{from:last.from,to:last.to,insert:'adw.geti'}}).state
    assert.ok(labels(await query()).includes('getitemstring'))
    f.invalidate(last.number); state=state.update({changes:{from:state.doc.length,insert:'temstr'}}).state
    assert.deepEqual(labels(await query()),['getitemstring']); assert.equal(visited-cold,0)
    console.log('Parameter lookup + narrowing: previous lines reread:',visited-cold)
    f.invalidate(last.number); state=prevState
    // Move before the redeclaration: a later indexed block must not leak backwards.
    assert.deepEqual(labels(await query(state.doc.line(130).to)), ['arrangesheets'])
    const changed=state.doc.line(141); f.invalidate(141)
    state=state.update({changes:{from:changed.from,to:changed.to,insert:'string obj'}}).state
    assert.equal(await query(),null)
  } finally { proto.iterLines = orig }
})

test('the cursor-prefix cache follows multiline comments, shadowing and edits in the current block',async () => {
  const f = fixture(), query = state => f.source(new CompletionContext(state,state.selection.main.head,true))
  const text = 'string ls_old\n/* note\nls_\n*/\ninteger ls_old; ls_'
  let state = EditorState.create({doc:text,selection:{anchor:text.length}})
  assert.equal((await query(state)).options.find(o=>o.label==='ls_old').detail,'局部变量 · integer')
  // Moving backwards may put the caret inside a comment. Never reuse the later lexical mode.
  assert.equal(await query(state.update({selection:{anchor:state.doc.line(3).to}}).state),null)
  f.invalidate(1)
  state = state.update({changes:{from:0,to:state.doc.line(1).to,insert:'long ls_new'}}).state
  assert.deepEqual(labels(await query(state)).sort(), ['ls_new','ls_old'])
  f.invalidate(5)
  state = state.update({changes:{from:state.doc.line(5).from,to:state.doc.length,insert:'ls_'}}).state
  assert.deepEqual(labels(await query(state)),['ls_new'])
})

test('a capped member list can narrow to a name outside the initial page, without walking other scripts',async () => {
  const f = fixture(), methods = Array.from({length:2400},(_,i) => ({kind:'function',name:`of_${String(i).padStart(4,'0')}`,signature:'()'}))
  f.session.model.root.scripts.push(...methods)
  const all = await ask(f,'this.of_'); assert.equal(all.options.length,64); assert.equal(all.validFor,undefined)
  assert.deepEqual(labels(await ask(f,'this.OF_239')),Array.from({length:10},(_,i) => `of_239${i}`))
})

test('control scripts see enclosing instance variables, functions and events; this and parent have distinct members', async () => {
  const source = `global type w_main from window
integer width = 800
event type long ue_declared (string arg)
end type
type variables
string is_window
datawindow idw_window
end variables
forward prototypes
public function boolean of_check (long value)
end prototypes
public function long of_run ();return 1
end function
type cb_ok from commandbutton within w_main
string text = "OK"
end type
event clicked;return
end event`
  const model=await new Promise(done=>parsePainter(source,'w_main.srw',done)), session={model,text:source,edits:{patches:new Map()}}
  const f=createScriptSource(session,model.objects.get('cb_ok').scripts[0])
  for(const [prefix, expected] of [['is_','is_window'],['of_c','of_check'],['ue_d','ue_declared'],['idw_window.rowc','rowcount'],['parent.of_r','of_run'],['w_main.ue_','ue_declared'],['cb_ok.setf','setfocus'],['this.dragd','dragdrop']]) {
    assert.ok(labels(await ask(f,prefix)).includes(expected), prefix)
  }
  assert.equal(await ask(f,'this.of_run',true),null); assert.equal(await ask(f,'this.is_window',true),null)
  session.edits.patches.set('declare:instance',{doc:Text.of(Array.from({length:100},(_,i)=>`string is_${i}`))})
  const broad=labels(await ask(f,'parent.')); assert.ok(broad.includes('of_check') && broad.includes('ue_declared') && broad.some(k=>k.startsWith('is_')))
})
test('a derived SRU suggests accessible ancestor functions, events and standard members', async () => {
  const source='global type u_child from u_base\nend type\npublic function long of_run ();return 1\nend function'
  const base='global type u_base from commandbutton\nevent ue_action ( )\nend type\nprotected function long of_base ();return 1\nend function\nprivate function long of_hidden ();return 1\nend function'
  const model=await new Promise(done=>parsePainter(source,'u_child.sru',done,async ()=>base)), f=createScriptSource({model,text:source,edits:{patches:new Map()}},model.root.scripts[0])
  for(const [prefix,key] of [['this.of_','of_base'],['this.ue_','ue_action'],['this.setf','setfocus']]) assert.ok(labels(await ask(f,prefix)).includes(key))
  assert.equal(await ask(f,'this.of_hidden',true),null)
})
test('bundled PB signatures match src/types without a workspace lookup at runtime', () => {
  for (const [name, api] of Object.entries(catalog)) {
    const source=JSON.parse(readFileSync(new URL(`../../../../src/types/${name}.json`,import.meta.url),'utf8'))
    for(const kind of ['properties','functions','events']) assert.deepEqual(api[kind],Object.fromEntries(Object.entries(source[kind]).map(([k,v])=>[k,v[0] || k])))
  }
})

test('member navigation resolves the clicked receiver in draft scope, without changing completion or using the caret', async () => {
  const f = fixture('readonly n_param fp', 'n_instance fp')
  async function resolve(f, source, word='FP_CaptuteImage') {
    f.invalidate(1)
    const state = EditorState.create({doc:source, extensions:EditorState.readOnly.of(true)})
    return f.resolveMember({state, pos:source.lastIndexOf(word) + 3}, word)
  }
  assert.deepEqual(await resolve(f,'fp.FP_CaptuteImage()'), {type:'n_param'})
  assert.deepEqual(await resolve(f,'N_LOCAL other, fp; FP . FP_CaptuteImage()'), {type:'n_local'})
  assert.equal(await resolve(f,'string fp[2]\nfp.FP_CaptuteImage()'),null) // array shadows the parameter
  for (const doc of ['// fp.FP_CaptuteImage()', '/*\nfp.FP_CaptuteImage()', 'x = "fp.FP_CaptuteImage()"'])
    assert.equal(await resolve(f,doc),null)
  const instance = fixture('', 'n_old fp'), call = 'fp.FP_CaptuteImage()'
  assert.deepEqual(await resolve(instance,call), {type:'n_old'})
  const {patches} = instance.session.edits
  patches.set('declare:instance',{doc:Text.of(['n_new fp'])})
  assert.deepEqual(await resolve(instance,call), {type:'n_new'})
  patches.set('declare:instance',{doc:Text.empty}); patches.set('declare:shared',{doc:Text.of(['n_shared fp'])})
  patches.set('declare:global',{doc:Text.of(['n_global fp'])})
  assert.deepEqual(await resolve(instance,call), {type:'n_shared'})
  patches.delete('declare:shared'); assert.deepEqual(await resolve(instance,call), {type:'n_global'})
})

test('member navigation reuses completion checkpoints in a 32K-line script', async () => {
  const f = fixture(''), rows = 32087, lines = Array(rows).fill('// no declarations')
  lines[0] = 'n_device fp'; lines.push('fp.FP_CaptuteImage()')
  const doc = Text.of(lines), state = EditorState.create({doc}), orig = Text.prototype.iterLines
  let read = 0
  Text.prototype.iterLines = function*(...args) { for (const line of orig.apply(this,args)) { if (this === doc) read++; yield line } }
  try {
    const pos = doc.line(doc.lines).from + 5
    await f.source(new CompletionContext(state,pos,true))
    assert.equal(read,rows); read = 0
    assert.deepEqual(await f.resolveMember({state,pos},'FP_CaptuteImage'), {type:'n_device'})
    assert.equal(read,0)
  } finally { Text.prototype.iterLines = orig }
})
