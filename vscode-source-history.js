import { EditorState, StateEffect, Text, Transaction } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'

// A small edited tab owns CM's bounded, change-based history, never a view or DOM.
// Both surfaces use the same history field. Reconfigure the immutable state instead
// of replaying string snapshots or relying on a detached textarea's browser history.
const onlyHistory = history()
export const compactHistory = state => state.update({effects: StateEffect.reconfigure.of(onlyHistory)}).state
export const historyFor = tab => tab.editHistory && tab.editHistory.text === tab.draft ? tab.editHistory.state : null
export const configureHistory = (state, extensions, selection) => state.update({effects: StateEffect.reconfigure.of(extensions), selection}).state
const pending = new WeakMap()
export function nativeInput(event) {
  const node = event.currentTarget, previous = pending.get(node); pending.delete(node)
  return { value: node.value, caret: node.selectionEnd, type: event.nativeEvent.inputType, previous }
}
export function applyNativeEdit(tab, {value, caret, type, previous}) {
  const old = tab.draft
  if (value === old) return tab
  let state = previous?.restored
  if (!state) {
    state = historyFor(tab) || EditorState.create({doc: Text.of(old.split('\n')), extensions: onlyHistory})
    // Beforeinput supplies the old selection, including the direction of replacements.
    // Backspace/delete can extend beyond it. Anchor the common suffix at the new caret
    // so adjacent identical characters don't move the change to the end of a run.
    let end = value.length, to = old.length
    if (old.endsWith(value.slice(caret))) { to -= end - caret; end = caret }
    else while (end > caret && to && value.charCodeAt(end-1) === old.charCodeAt(to-1)) { end--; to-- }
    let from = 0, limit = Math.min(end, to, previous?.from ?? caret)
    if (value.startsWith(old.slice(0, limit))) from = limit
    else while (from < limit && value.charCodeAt(from) === old.charCodeAt(from)) from++
    const start = previous?.anchor ?? (type === 'deleteContentBackward' ? to : from)
    const head = previous?.head ?? start
    state = state.update({selection: {anchor: start, head}}).state.update({
      changes: {from, to, insert: value.slice(from, end)}, selection: {anchor: caret},
      annotations: Transaction.userEvent.of(type === 'deleteContentBackward' ? 'delete.backward' : type === 'deleteContentForward' ? 'delete.forward' : type === 'insertText' ? 'input.type' : type === 'insertCompositionText' ? 'input.type.compose' : 'input'),
    }).state
  }
  return { ...tab, draft: value, pinned: true, editHistory: {text: value, state} }
}

export function bindSourceHistory(shell, tabFor) {
  const handler = e => {
    const node = e.target
    if (!node.matches?.('textarea[data-source-tab]') || node.readOnly || e.isComposing) return
    const key = e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase()
    const command = key === 'z' ? (e.shiftKey ? redo : undo) : key === 'y' ? redo
      : e.inputType === 'historyUndo' ? undo : e.inputType === 'historyRedo' ? redo : null
    if (command) {
      const tab = tabFor(node.dataset.sourceTab), state = tab && historyFor(tab)
      if (!state) return
      e.preventDefault(); e.stopPropagation()
      command({state, dispatch(tr) {
        pending.set(node, {restored: tr.state})
        // Use the native setter so React receives exactly one normal change event.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, tr.state.doc.toString())
        const s = tr.state.selection.main
        node.setSelectionRange(s.from, s.to, s.anchor > s.head ? 'backward' : 'forward')
        node.dispatchEvent(new Event('input', {bubbles: true}))
      }})
    } else if (e.type === 'beforeinput') {
      const from = node.selectionStart, to = node.selectionEnd, back = node.selectionDirection === 'backward'
      pending.set(node, {from, anchor: back ? to : from, head: back ? from : to})
    }
  }
  shell.addEventListener('beforeinput', handler, true); shell.addEventListener('keydown', handler, true)
  return () => { shell.removeEventListener('beforeinput', handler, true); shell.removeEventListener('keydown', handler, true) }
}
