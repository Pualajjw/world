// A binding grants one registered DSH capability to one installed application. Unknown tools
// default to unbound, not to a catch-all shell. Empty strings are explicit unbindings.
export const DEFAULT_BINDINGS = Object.freeze({
  read: 'vscode', write: 'vscode', edit: 'vscode', grep: 'vscode', glob: 'vscode', apply_patch: 'vscode',
  pwsh: 'terminal', bash: 'terminal', run_code: 'terminal',
  world_diary: 'plugin:world-diary', world_tasks: 'plugin:world-tasks',
  world_memory: 'plugin:world-diary', world_self: 'plugin:world-diary',
  lan_chat_history: 'lanchat', lan_chat_conversations: 'lanchat',
})
export const bindable = name => typeof name === 'string' && name.length > 0 && name.length <= 256 && !name.startsWith('world_desktop_')
export function bindingFor(name, overrides) {
  if (!bindable(name)) return ''
  const value = Object.hasOwn(overrides || {}, name) ? overrides[name] : Object.hasOwn(DEFAULT_BINDINGS, name) ? DEFAULT_BINDINGS[name] : ''
  return typeof value === 'string' ? value : ''
}
export function installedOwner(name, state) {
  const id = bindingFor(name, state?.toolBindings)
  return id && state?.apps?.some(app => app.installed && app.id === id) ? id : ''
}
