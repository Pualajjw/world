import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePainter } from '../srw-model.js'

const parse = (source, path = 'folder/d_test.SRD') => new Promise(done => parsePainter(source, path, done))
test('GBK repository export: table columns are bindings, not controls', async () => {
  const source = new TextDecoder('gbk').decode(readFileSync(new URL('../../../../src/templates/uo_datawindow.srd', import.meta.url)))
  const model = await parse(source)
  assert.deepEqual(model.bands.map(b => [b.name, b.height, b.children.length]), [['header',0,0], ['detail',892,20], ['summary',0,0], ['footer',0,0]])
  const obj = model.objects.get('band:detail/a4')
  assert.equal(obj.props['font.face'], '宋体'); assert.match(obj.column.values, /下拉/); assert.equal(obj.column.type, 'char(255)')
  assert.equal(model.objects.get('band:detail/compute_1').props.border, '0') // no whitespace after expression
})
test('preserves expressions, escaped delimiters, groups, foreground and missing band heights', async () => {
  const model = await parse(`$PBExportHeader$d_test.srd\r\nrelease 9; DATAWINDOW(units = 1) header(height=0)\n` +
    `table(column=(type=decimal(2) name=total) retrieve="select '~")~"'\ntext(band=detail name=fake)")\n` +
    `group(level=2 header.height=50 trailer.height=10 by=("dept")) group(level=1 header.height=60 trailer.height=20)\n` +
    `compute(band=header[2] name=total expression="sum(if(a = ~"(~", 1, 0))" font=(height=-9 face="宋体"))\n` +
    `line(x1=120 x2=5 y1=8 y2=48) text(band=foreground x=1 y=3 width="9~tif(a,5,2)" name=top)\nfooter(height=0)`)
  assert.deepEqual(model.bands.map(b => b.name), ['header','header.1','header.2','detail','trailer.2','trailer.1','footer'])
  const group = model.bands[2]; assert.equal(group.props.by, '("dept")'); assert.equal(group.height, 50)
  const compute = group.children[0]; assert.equal(compute.props.expression, 'sum(if(a = "(", 1, 0))'); assert.equal(compute.props['font.face'], '宋体')
  assert.deepEqual(model.bands[3].children[0].box, {x:5, y:8, width:115, height:40}); assert.equal(model.bands[3].height, 48)
  const top = model.foreground.children[0]; assert.equal(top.props.width, '9\tif(a,5,2)'); assert.equal(top.box.width, 9)
})
test('unsupported source stays available as source and an abandoned scan never publishes', async () => {
  assert.equal((await parse('release 9;')).root, null)
  let calls = 0; parsePainter('datawindow()', 'x.srd', () => calls++)()
  await new Promise(r => setTimeout(r, 10)); assert.equal(calls, 0)
})
