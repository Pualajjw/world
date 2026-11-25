import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ChangeSet, Text } from '@codemirror/state'
import { declarationBounds } from '../srw-declarations.js'
import { findPainterMember, findMemberDefinition, scanSrw, parsePainter, pbX, pbY } from '../srw-model.js'
import { createEdits, editBounds, openBody, setBody, designChanges, designText, acknowledgeEdits, editsDirty } from '../srw-edits.js'
import { card } from './srw-fixture.js'
function edit(session, bounds, text) {
  setBody(session, bounds, Text.of(text.split('\n')), openBody(session, bounds).original)
}
function parse(text, path) { const p = scanSrw(text, path); let r; do r = p.next(); while (!r.done); return r.value }
test('forward declarations, encoded literals, scoped script offsets and nonvisual references', () => {
  const text = card.replaceAll('\n', '\r\n'), m = parse(text, 'W_DK.SRW')
  assert.equal(m.root.props.title, '请选择读卡内容'); assert.equal(m.objects.size, 11)
  assert.equal(m.objects.get('ids').nonvisual, true)
  assert.equal(m.objects.get('cb_9').props.text, 'none'); assert.equal(m.root.props.visible, undefined)
  assert.deepEqual(m.root.scripts.map(s => s.name), ['open','wf_count'])
  const clicked = m.objects.get('cb_1').scripts[0]
  assert.equal(text.slice(clicked.start, clicked.end).trim(), 'event clicked;MessageBox("读卡", "卡 1")')
  assert.match(text.slice(m.variables[0].start, m.variables[0].end), /ibts\[\]/)
  assert.deepEqual([pbX(457), pbY(92)], [100, 23])
})
test('SRA exports keep application events, declarations and nonvisual globals without a canvas', () => {
  const text = readFileSync(new URL('../../../../pypower/tests/src/test_import_src.pbl/test_import_src.sra', import.meta.url), 'utf8')
  const m = parse(text, 'TEST_IMPORT_SRC.SRA')
  assert.equal(m.hasLayout, false); assert.equal(m.root.base, 'application')
  assert.equal(m.root.props.appname, 'test_import_src'); assert.equal(m.objects.get('sqlca').nonvisual, true)
  assert.deepEqual(m.root.scripts.map(s => s.name), ['create', 'destroy', 'open'])
  assert.equal(m.declares.global.length, 1)
  const session = { text, edits: createEdits(false) }, body = editBounds(m.root.scripts.at(-1), text)
  edit(session, body, 'open(w_home)'); assert.equal(designText(session), text.replace('gf_msg()', 'open(w_home)'))
})
test('SRA directives isolate the selected application and preserve inline declarations when editing open', () => {
  const text = '@other.sra.event open;\nreturn\n@end event\n@demo.sra.event open;\n//:global_variables:string gs_title\nopen(w_test)\n@end event'
  const m = parse(text, 'demo.sra'), session = { text, edits: createEdits(false) }
  assert.equal(m.root.base, 'application'); assert.equal(m.hasLayout, false); assert.equal(m.scripts.length, 1)
  assert.equal(declarationBounds(m, 'global', text).original.toString(), 'string gs_title')
  edit(session, editBounds(m.scripts[0], text), 'open(w_main)')
  assert.equal(designText(session), text.replace('open(w_test)', 'open(w_main)'))
})
test('static declaration reader ignores commented-out code and preserves quoted comment markers', () => {
  const m = parse('global type w from window\nstring title = "http://a;~"quoted~"" // note\nend type\nevent open;\n/*\nend event\ntype bad from window\n*/\nstring s = "end event"\nend event', 'w.srw')
  assert.equal(m.root.props.title, 'http://a;"quoted"'); assert.equal(m.objects.size, 1); assert.equal(m.scripts.length, 1)
})
test('project directives isolate the selected SRW and never execute expressions', () => {
  const m = parse('@other.srw.event open;\n//:set_win_attribute:title="other"\n@end event\n@w.srw.cb_1.event clicked;\n//:set_attribute:text="a;b";x=10+2\n@end event\n@u.sru.event constructor;\n@end event', 'w.srw')
  assert.equal(m.partial, true); assert.equal(m.objects.size, 2); assert.equal(m.root.props.title, undefined)
  assert.equal(m.objects.get('cb_1').props.text, 'a;b'); assert.equal(m.objects.get('cb_1').props.x, '10+2')
})
test('actual PB9 export, decoded as GBK, handles inherited controls and overload bodies', t => {
  const fixture = new URL('../../../../pypower/tests/res/pbcode_test.pbl/w_zyyw.srw', import.meta.url)
  if (!existsSync(fixture)) return t.skip('pbhelp integration fixture not installed')
  const text = new TextDecoder('gbk').decode(readFileSync(fixture))
  const m = parse(text, 'w_zyyw.srw'); assert.equal(m.root.name,'w_zyyw'); assert.equal(m.objects.get('cb_30').props.text,'读身份证'); assert.equal(m.objects.get('cb_30').base,'uo_xpbutton'); assert.equal(m.objects.get('cb_30').scripts[0].name,'clicked'); assert.ok(m.scripts.some(s => s.name === 'wf_js_fyqd'))
})

test('empty script, missing instance declaration and inline directive edits preserve wrappers', () => {
  const text = 'global type w from window\nend type\nglobal w w\nevent open;\nend event\nevent close;return 7\nend event\n'
  const m = parse(text,'w.srw'), doc = {text,edits:createEdits()}
  const [open,close] = m.scripts.map(r=>editBounds(r,text))
  edit(doc, open, 'return 1'); edit(doc, close, 'return 9')
  const vars = editBounds({start:m.variableInsertion,end:m.variableInsertion,complete:true,insert:true},text)
  edit(doc,vars,'string title'); const after = designText(doc), sent = new Map(doc.edits.patches)
  assert.match(after,/global w w\ntype variables\nstring title\nend variables\nevent open;\nreturn 1\nend event/)
  acknowledgeEdits(doc.edits,sent); assert.equal(editsDirty(doc.edits),false)
  edit(doc,vars,''); edit(doc,close,'return 33'); let assembled='', pos=0; const final=designText(doc)
  for(const [a,b,c,d] of designChanges(doc.edits)){assembled+=after.slice(pos,a)+final.slice(c,d);pos=b}
  assert.equal(assembled+after.slice(pos),final)
  const custom='@w.srw.cb_1.event clicked;\n//:set_attribute:text="test"\n//:type_variables:long a\nMessageBox("a","b")\n@end event'
  const mm=parse(custom,'w.srw'), cd={text:custom,edits:createEdits()}
  edit(cd,editBounds(mm.variables[0],custom),'long b'); edit(cd,editBounds(mm.scripts[0],custom),'return')
  assert.equal(designText(cd),custom.replace('long a','long b').replace('MessageBox("a","b")','return'))
})

test('large script edits, reopen and save acknowledgement share snapshots until serialization', t => {
  const text = 'MessageBox("title", "value")\n'.repeat(25000) + 'return 1'
  const session = { text, edits: createEdits() }, bounds = editBounds({ start: 0, end: text.length, complete: true }, text)
  const { original } = openBody(session, bounds)
  const flat = t.mock.method(Text.prototype, 'toString')
  const append = Text.of(['x'])
  let doc = original
  for (let i = 0; i < 100; i++) {
    doc = doc.replace(doc.length, doc.length, append)
    setBody(session, bounds, doc, original)
  }
  assert.equal(openBody(session, bounds).doc, doc, 'switching views reuses the pending body')
  assert.deepEqual(designChanges(session.edits), [[0, text.length, 0, doc.length]])
  const sent = new Map(session.edits.patches)
  const changed = doc.replace(doc.length - 1, doc.length, Text.of(['y']))
  setBody(session, bounds, changed, original)
  acknowledgeEdits(session.edits, sent)
  assert.equal(editsDirty(session.edits), true, 'a same-length edit during save remains dirty')
  setBody(session, bounds, changed.replace(doc.length - 1, doc.length, append), original)
  assert.equal(editsDirty(session.edits), false, 'equal text, not snapshot identity, marks the saved version clean')
  assert.deepEqual(designChanges(session.edits), [])
  assert.equal(flat.mock.callCount(), 0)
  assert.equal(designText(session, sent), text + 'x'.repeat(100))
  assert.equal(flat.mock.callCount(), 1)
  setBody(session, bounds, doc.slice(0, original.length), original)
  assert.equal(session.edits.patches.size, 0)
  assert.equal(editsDirty(session.edits), true, 'reverting to the original is a change relative to the saved version')
  assert.equal(designText(session), text)
})

test('Declare 面板的五类声明各成一段，外部函数按 global 关键字拆开', () => {
  const text = `global type w from window
end type
global w w
global variables
integer gi_count
end variables
shared variables
integer si_count
end variables
type variables
integer ii_count
end variables
type prototypes
function long GetTickCount() library "kernel32.dll"
global function ulong GlobalFn() library "user32.dll"
public function boolean LocalFn() library "user32.dll"
end prototypes
forward prototypes
public function integer of_test ()
end prototypes
event open;
return 1
end event`
  const m = parse(text, 'w.srw')
  const slice = r => text.slice(r.start, r.end).trim()
  assert.deepEqual(m.declares.global.map(slice), ['integer gi_count'])
  assert.deepEqual(m.declares.shared.map(slice), ['integer si_count'])
  assert.deepEqual(m.declares.instance.map(slice), ['integer ii_count'])
  assert.deepEqual(m.declares.globalExternal.map(slice), ['global function ulong GlobalFn() library "user32.dll"'])
  assert.deepEqual(m.declares.localExternal.map(slice), [
    'function long GetTickCount() library "kernel32.dll"',
    'public function boolean LocalFn() library "user32.dll"',
  ])
  assert.equal(m.variables, m.declares.instance, '实例变量仍从 variables 读')
})

function declarations(text, path = 'w.srw') {
  const m = parse(text, path), s = { text, edits: createEdits() }
  const bounds = kind => declarationBounds(m, kind, text)
  const doc = kind => openBody(s, bounds(kind)).doc
  function change(kind, spec) {
    const b = bounds(kind), { original, doc } = openBody(s, b)
    const tr = ChangeSet.of(typeof spec === 'string' ? { from: 0, to: doc.length, insert: spec } : spec, doc.length)
    setBody(s, b, tr.apply(doc), original, tr)
  }
  let last = text
  function save() {
    const next = designText(s); let a = 0, b = 0
    for (const [i,j,k,l] of designChanges(s.edits)) {
      assert.ok(i >= a && k >= b); assert.equal(last.slice(a, i), next.slice(b, k)); a = j; b = l
    }
    assert.equal(last.slice(a), next.slice(b)); last = next
    acknowledgeEdits(s.edits, new Map(s.edits.patches)); return next
  }
  return { bounds, doc, change, save }
}

test('application prototypes belong to Global External without rewriting signatures', () => {
  const head = 'global type app from application\nend type\n', vars = 'global variables\nlong gl_count\nend variables\n'
  const body = '// alias and continuation\nfunction long Tick(&\n long arg) library "a"\npublic subroutine Reset() library "b"'
  const text = head + vars + `type prototypes\n${body}\nend prototypes\nforward prototypes\npublic subroutine of_internal()\nend prototypes`
  const { doc, bounds, change, save } = declarations(text, 'APP.SRA')
  assert.equal(doc('global').toString(), 'long gl_count')
  assert.equal(doc('globalExternal').toString(), body)
  assert.equal(bounds('localExternal'), null)
  change('globalExternal', body.replace('Tick','Ticks'))
  assert.equal(save(), text.replace('Tick','Ticks'))
  const empty = declarations(head, 'app.sra')
  empty.change('globalExternal', 'subroutine Reset() library "b"')
  assert.equal(empty.save(), head + 'type prototypes\nsubroutine Reset() library "b"\nend prototypes\n')
})

test('adding a line to an SRA global_variables directive keeps it global on reload', () => {
  const text = '@app.sra.event open;\n//:global_variables:long gl_count\n@end event'
  const s = declarations(text, 'app.sra')
  s.change('global', 'long gl_count\nstring gs_title')
  const after = s.save()
  assert.equal(after, text.replace('gl_count', 'gl_count\n//:global_variables:string gs_title'))
  assert.equal(declarations(after, 'app.sra').doc('global').toString(), 'long gl_count\nstring gs_title')
})

test('one projected declaration body preserves interleaved scopes, continuations, comments and save spans', () => {
  const G = 'global function long G(&\n long arg) library "test.dll"', L = 'localExternal', prefix = '// preserved\n  ',
    A = 'function long A() library "a.dll"', B = 'function long B() library "b.dll"', C = 'function long C() library "c.dll"'
  const text = `global type w from window\nend type\ntype prototypes\n${prefix}${A}\n${G}\n${B}\n${C}\nend prototypes\nforward prototypes\n${B}\nend prototypes`
  const { doc, change, save } = declarations(text)
  assert.equal(doc(L).toString(), `${prefix}${A}\n${B}\n${C}`)
  assert.equal(doc('globalExternal').toString(), G)
  change(L, {from: doc(L).line(2).to, insert: '\n' + C}); assert.equal(save(), text.replace(A, A+'\n'+C))
  change('globalExternal', G.replace('long arg','long value'))
  change(L, `${prefix}${A}\n${B}\n${C}`); assert.equal(save(), text.replace('long arg','long value'))
  change('globalExternal', G)
  change(L, `${prefix}${C}\n${C}\n${A}`); assert.equal(save(), text.replace(`${A}\n${G}\n${B}\n${C}`, `${C}\n${G}\n${C}\n${A}`))
  change(L, ''); assert.equal(save(), text.replace(prefix+A+'\n', '').replace(B+'\n'+C+'\n', ''))
  change(L, `${prefix}${A}\n${B}\n${C}`); assert.equal(save(), text)
})

test('all empty pages can be filled in any order and share a single missing prototypes wrapper', () => {
  const kinds = ['localExternal', 'instance', 'shared', 'globalExternal', 'global']
  const values = ['function long L() library "x"', 'long i', 'long s', 'global function long G() library "y"', 'long g']
  for (const base of ['', 'type prototypes\nend prototypes\n']) {
    const text = `global type u from nonvisualobject\nend type\n${base}on u.create\nend on\n`
    const { doc, change, save } = declarations(text, 'u.sru')
    for (const [i, kind] of kinds.entries()) { assert.equal(doc(kind).length, 0); change(kind, values[i]); save() }
    const after = save(), m = parse(after, 'u.sru')
    assert.equal(after.match(/^type prototypes$/gm).length, 1)
    for (const [i, kind] of kinds.entries()) assert.equal(declarationBounds(m,kind,after).original.toString(), values[i])
    for (const kind of kinds.toReversed()) { change(kind, ''); save() }
    assert.equal(save(), text)
  }
})

test('multi-block instance edits do not overwrite intervening source or expose directive payloads as script', () => {
  const text = '@w.srw.event open;\n//:type_variables:long a\nreturn 1\n@end event\n@w.srw.event close;\n//:type_variables:long b\n@end event'
  const {doc, change, save} = declarations(text)
  assert.equal(doc('instance').toString(), 'long a\nlong b')
  change('instance', {from: 6, insert:'\nlong c'})
  assert.equal(save(), text.replace('long a', 'long a\n//:type_variables:long c'))
  const broken = declarations('global type w from window\nend type\ntype prototypes\nfunction long A()')
  assert.equal(broken.bounds('localExternal').readOnly, true); assert.equal(broken.bounds('globalExternal'), null)
})

test('SRU layout follows the root, not names, script contents or nonvisual fields named width', async () => {
  const read = (text, readBase) => new Promise(done => parsePainter(text, 'thing.SRU', done, readBase))
  const child = 'global type thing from u_parent\nend type'
  for (const base of ['userobject', 'datawindow', 'listview', 'olecustomcontrol']) {
    const m = await read(child, () => `global type u_parent from ${base}\nend type`)
    assert.equal(m.hasLayout, true); assert.equal(m.root.name, 'thing')
  }
  const plain = 'global type thing from datastore autoinstantiate\nend type\ntype variables\ninteger width\nprivate:\nlong secret\nend variables'
  const m = await read(plain); assert.equal(m.hasLayout, false); assert.equal(m.root.autoInstantiate, true)
  assert.deepEqual({...m.root.instanceProps}, {width: '0'})
  assert.equal((await read(child, () => { throw Error('missing ancestor') })).hasLayout, false)
  assert.equal((await read(`${child}\ntype label from statictext within thing\nend type`)).hasLayout, true)
  const fragment = '@other.srw.event open;\n//:set_attribute:width=100\n@end event\n@thing.sru.event constructor;\nreturn\n@end event'
  const f = await read(fragment); assert.equal(f.partial, true); assert.equal(f.hasLayout, false); assert.deepEqual(f.scripts.map(s => s.name), ['constructor'])
})

test('member definition lookup prefers the real implementation and ignores comments, other owners and calls', async () => {
  const rows = ['forward','global type n_fp from nonvisualobject','end type','end forward',
    'global type n_fp from nonvisualobject','end type','type prototypes',
    'function long ExternalCall() library "driver.dll"','end prototypes','forward prototypes',
    'public function long fp_captuteimage()','end prototypes','event constructor;',
    'this.FP_CaptuteImage()', '/*','end event','public function long FP_CaptuteImage();','*/','end event',
    'type variables','n_device other, device','end variables','public function long FP_CaptuteImage();return 1','end function',
    'type nested from n_other within n_fp','end type','public function long other_fn();return 0','end function']
  for (const text of [rows.join('\r\n'), Text.of(rows)]) {
    for (const [name,line] of [['FP_CaptuteImage',23],['externalcall',8],['DEVICE',21],['nested',25]])
      assert.deepEqual(await findMemberDefinition(text,'N_FP',name), {line,member:true})
    assert.deepEqual(await findMemberDefinition(text,'n_fp','other_fn'), {line:5,member:false})
  }
})

test('one-member target scan stops at the implementation and honours cancellation', async () => {
  let visited = 0
  const virtual = { *iterLines() {
    yield 'global type n_fp from nonvisualobject'; yield 'end type'
    yield 'public subroutine capture();'; visited++; yield 'end subroutine'
  } }
  assert.deepEqual(await findMemberDefinition(virtual,'n_fp','capture'), {line:3,member:true})
  assert.equal(visited,0)
  await assert.rejects(findMemberDefinition(virtual,'n_fp','capture',AbortSignal.abort()), {name:'AbortError'})
})

test('painter jump selects a script or embedded object from the parsed model without reading source', async () => {
  const model = parse(card,'w_dk.srw'), session = {model, hasLayout:true, get text() { throw Error('unexpected source scan') }}
  const signal = new AbortController().signal, clicked = model.objects.get('cb_1').scripts.find(s => s.name === 'clicked')
  assert.deepEqual(await findPainterMember(session,'CB_1','Clicked',signal),
    {view:'script',object:'cb_1',script:clicked.id,key:clicked.id,line:1})
  assert.deepEqual(await findPainterMember(session,model.root.id,'CB_9',signal), {view:'layout',object:'cb_9'})
  assert.deepEqual(await findPainterMember(session,model.root.id,'ids',signal), {view:'properties',object:'ids'})
  await assert.rejects(findPainterMember(session,'cb_9','clicked',AbortSignal.abort()), {name:'AbortError'})
})

test('painter declaration rows match the joined pane, not physical file line numbers', async () => {
  const text = ['global type n_fp from nonvisualobject','end type','type prototypes','function long one()',
    'global function long skipped()', '// skipped in Global External', 'function long two()', '',
    '/* function long wrong() */','function long Capture() library "fp.dll"','end prototypes',
    'type variables','n_device dev, other','end variables'].join('\r\n')
  const session = {text,model:parse(text,'n_fp.sru'),edits:createEdits()}, signal = new AbortController().signal
  const resolve = member => findPainterMember(session,'n_fp',member,signal)
  const hit = await resolve('capture'), bounds = declarationBounds(session.model,'localExternal',text)
  assert.equal(hit.view,'variables'); assert.equal(hit.declare,'localExternal'); assert.equal(hit.line,5)
  assert.match(bounds.original.line(hit.line).text,/Capture/)
  assert.equal(await resolve('wrong'),null); assert.equal(await resolve('skipped'),null) // that pane would show the SRA
  assert.equal((await resolve('OTHER')).declare,'instance')
  const tr = ChangeSet.of({from:0,to:bounds.original.length,insert:'// changed draft\nfunction long renamed()'},bounds.original.length)
  setBody(session,bounds,tr.apply(bounds.original),bounds.original,tr)
  assert.equal((await resolve('renamed')).line,2); assert.equal(await resolve('Capture'),null)
})
