import './browser-entry.js'
import { WorkflowPage } from '../../workflow-studio/editor.jsx'
import flowCss from '@xyflow/react/dist/style.css'
import stylesheet from '../../workflow-studio/styles.css'

const style = document.createElement('style')
style.textContent = flowCss + '\n' + stylesheet
document.head.append(style)

window.__worldTesting.renderPlugin('workflow-studio', WorkflowPage)
