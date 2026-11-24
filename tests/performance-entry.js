import './browser-entry.js'
import React from 'react'

// Stateful, observable stand-ins for the host's two registered whole-page plugins.
window.__pluginRenders = {}
for (const key of ['workflow-studio', 'assessment']) {
  window.__pluginRenders[key] = 0
  window.__worldTesting.renderPlugin(key, function ProbePage() {
    window.__pluginRenders[key]++
    const [count, setCount] = React.useState(0)
    return React.createElement('button', { 'data-probe-page': key, onClick: () => setCount(n => n + 1) }, count)
  })
}
