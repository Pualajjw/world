import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WINDOW_Z_BASE, dropWindows, orderByPin, raiseWindow, topWindow, zIndexFor } from '../window-stack.js'

test('点谁谁到栈顶，重复点不搬家', () => {
  let stack = ['dsh']
  stack = raiseWindow(stack, 'vscode:1')
  stack = raiseWindow(stack, 'terminal')
  assert.deepEqual(stack, ['dsh', 'vscode:1', 'terminal'])
  assert.equal(raiseWindow(stack, 'terminal'), stack)
  stack = raiseWindow(stack, 'dsh')
  assert.deepEqual(stack, ['vscode:1', 'terminal', 'dsh'])
})

test('钉住的永远压在未钉住上面，钉住之间按最近激活排序', () => {
  const stack = ['dsh', 'vscode:1', 'terminal']
  const pinned = new Set(['dsh'])
  assert.deepEqual(orderByPin(stack, pinned), ['vscode:1', 'terminal', 'dsh'])
  const both = new Set(['dsh', 'vscode:1'])
  assert.deepEqual(orderByPin(stack, both), ['terminal', 'dsh', 'vscode:1'])
  assert.ok(zIndexFor(stack, both, 'dsh') > zIndexFor(stack, both, 'terminal'))
  assert.ok(zIndexFor(stack, both, 'vscode:1') > zIndexFor(stack, both, 'dsh'))
  assert.equal(zIndexFor(stack, both, 'vscode:1'), WINDOW_Z_BASE + 2)
})

test('关闭 / 最小化后由栈里剩下的最上面一个接替，空了回桌面', () => {
  const stack = ['dsh', 'vscode:1', 'terminal']
  assert.deepEqual(dropWindows(stack, 'terminal'), ['dsh', 'vscode:1'])
  assert.equal(topWindow(dropWindows(stack, 'terminal')), 'vscode:1')
  assert.equal(topWindow(dropWindows(stack, ['dsh', 'vscode:1', 'terminal'])), 'desktop')
  assert.deepEqual(dropWindows(stack, ['dsh', 'terminal']), ['vscode:1'])
})