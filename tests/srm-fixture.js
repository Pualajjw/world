// Declaration order deliberately differs from Item[]; m_index also has a different lexical owner.
const items = [
  ['m_help','m_test','&Help'], ['m_file','m_test','&File'], ['m_edit','m_test','&Edit'], ['m_skin','m_test','指定菜单皮肤(&S)'],
  ['m_open','m_file','Open'], ['m_cut','m_edit','Cut'], ['m_paste','m_edit','Paste'], ['m_copy','m_edit','Copy'],
  ['m_sep','m_edit','-'], ['m_color','m_edit','Color'], ['m_blue','m_color','Blue && Green'],
  ['m_index','m_test','&Index'], ['m_topic','m_help','Topic'],
]
export const sample = `forward
global type m_test from menu
end type
end forward

global type m_test from menu
end type
global m_test m_test

on m_test.create
this.Item = {this.m_file, this.m_edit, &
             this.m_skin, this.m_help}
end on

${items.map(([name,parent,text]) => `type ${name} from menu within ${parent}
end type
on ${name}.create
call super::create
this.Text = "${text}"
${name === 'm_help' ? 'this.item[2] = m_topic\nthis.item[1] = m_index' : ''}
end on
${name === 'm_index' ? 'event clicked;\nMessageBox("Help", "Index")\nend event' : ''}`).join('\n')}
`
