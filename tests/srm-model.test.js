import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePainter } from '../srw-model.js'
import { sample } from './srm-fixture.js'
const parse = text => new Promise(resolve => parsePainter(text, 'm_test.SRM', resolve))

test('SRM static hierarchy honors array order, within fallback and On Create literals; script ranges remain editable', async () => {
  const text = sample.replace('this.item[2] = m_topic', 'this.item[1] = m_index\nthis.item[UpperBound(this.Item) + 1] = m_topic')
    .replace('MessageBox("Help", "Index")', 'text = "runtime" // must not appear in Layout').replaceAll('\n', '\r\n')
  const model = await parse(text), help = model.objects.get('m_help'), index = model.objects.get('m_index')
  assert.deepEqual(model.root.menuItems.map(o => o.id), ['m_file','m_edit','m_skin','m_help'])
  assert.deepEqual(help.menuItems.map(o => o.id), ['m_index','m_topic'])
  assert.equal(index.props.text, '&Index'); assert.equal(index.menuParent, 'm_help'); assert.equal(index.within, 'm_test')
  const clicked = index.scripts.find(s => s.name === 'clicked')
  assert.equal(text.slice(clicked.editStart, clicked.end), 'text = "runtime" // must not appear in Layout\r\n')
})

test('SRM project fragments use menu objects and ignore unrelated directives', async () => {
  const model = await parse('@other.srm.m_bad.event clicked;\n@end event\n@m_test.srm.m_file.event clicked;\n//:set_attribute:text="&File"\n@end event')
  assert.equal(model.root.base, 'menu'); assert.equal(model.root.menuItems[0].props.text, '&File')
  assert.equal(model.objects.size, 2); assert.equal(model.scripts[0].owner, 'm_file')
})

test('qualified inherited types retain their local menu hierarchy and Chinese item names', async () => {
  const explicit = sample.replaceAll('m_help','m_帮助').replace('type m_topic from menu','type m_topic from m_base`m_topic')
  const model = await parse(explicit.replace('this.item[2] = m_topic','// no explicit Item[] entry'))
  const help = model.objects.get('m_帮助'), topic = model.objects.get('m_topic')
  assert.equal(help.props.text, '&Help'); assert.equal(topic.menuParent, help.id)
  assert.equal(topic.base, 'm_base`m_topic'); assert.equal(model.root.menuItems.at(-1), help)
})
