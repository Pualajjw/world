import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('client registers one shell overlay and cleans up its stylesheet', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  let definition
  const slots = [], registrations = [], appended = [], cleanups = []
  const document = {
    createElement: tag => ({ tag, dataset: {}, textContent: '', remove() { this.removed = true } }),
    head: { append: element => appended.push(element) },
  }
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value } } }, document, console })
  const client = definition.factory(name => {
    if (name === 'react') return { createElement() {}, Component: class {} }
    if (name === 'react-dom') return { createPortal: children => children }
    assert.fail(`unexpected external module: ${name}`)
  })
  client.apply({
    effect(effect) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) },
    slots: {
      inject(name, resolve) { slots.push({ name, resolve }) },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  })
  assert.equal(Array.from(client.inject).join(','), 'slots,sessions,remote,remote.workspaceFiles,connection,layout')
  assert.equal(slots.length, 3)
  assert.equal(slots[0].name, 'shell.overlay')
  assert.equal(slots[1].name, 'world.assistant.conversation')
  assert.equal(slots[2].name, 'world.app.page')
  slots[0].resolve()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.id, 'world')
  assert.equal(registrations[0].options.children['world.app.page'].kind, 'keyed')
  assert.equal(registrations[0].options.children['world.app.page'].scope, 'root')
  assert.equal(registrations[0].options.children['world.assistant.conversation'].scope, 'session')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.plugin, 'dsh-world')
  assert.match(appended[0].textContent, /body\[data-world-window="max"\] #root/)
  assert.match(appended[0].textContent, /\.world-taskbar/)
  assert.match(appended[0].textContent, /\.world-start\.open/)
  cleanups.forEach(cleanup => cleanup())
  assert.equal(appended[0].removed, true)
})

test('package declares app services and universal host/client entries', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-world')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-workspace-files',
  ])
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('vscode-app.js'))
  assert.ok(manifest.files.includes('lan-chat-app.js'))
  assert.ok(manifest.files.includes('lan-chat'))
  assert.ok(manifest.files.includes('external-apps.js'))
  assert.ok(manifest.files.includes('app-format.js'))
  assert.ok(manifest.files.includes('app-packages'))
  assert.ok(manifest.files.includes('APP-FORMAT.md'))
  assert.ok(manifest.files.includes('plugin-apps.js'))
  assert.ok(manifest.files.includes('walker.js'))
  assert.ok(manifest.files.includes('source-editor.js'))
  assert.ok(manifest.files.includes('desktop-bridge.js'))
  assert.ok(manifest.files.includes('desktop-tools.js'))
  assert.ok(manifest.files.includes('desktop-client.js'))
  assert.ok(manifest.files.includes('desktop-control.js'))
  assert.ok(manifest.files.includes('desktop-brain.js'))
  assert.ok(manifest.files.includes('assistant-activity.js'))
  assert.ok(manifest.files.includes('session-transcript.js'))
  assert.ok(manifest.files.includes('workbench-profile.js'))
  assert.ok(manifest.files.includes('workbench.js'))
  assert.ok(manifest.files.includes('workbench-setup.js'))
  assert.ok(manifest.files.includes('git.js'))
  assert.ok(manifest.files.includes('highlight.js'))
  assert.ok(manifest.files.includes('vscode-search.js'))
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-fs'])
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-sandbox'])
})

test('plugin catalog mirrors whole-page panels into a world-owned keyed slot', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  let definition
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { append() {} },
  }
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value } } }, document, console })
  const client = definition.factory(name => {
    if (name === 'react') return { createElement() {}, Component: class {} }
    if (name === 'react-dom') return { createPortal: children => children }
    return {}
  })
  const MainPage = () => null
  const ChildPage = () => null
  const Icon = () => null
  const injectFace = () => ({ rpc: 1 })
  const mains = [
    { options: { key: 'conversation' }, component: () => null },
    { options: { key: 'workflow-studio' }, component: MainPage, inject: injectFace, locale: 'workflow-studio' },
    { options: { key: 'pbide' }, component: ChildPage, children: { 'pbide.chat': { kind: 'single', scope: 'session' } } },
  ]
  const sides = [
    { options: { id: 'workflow-studio', label: () => '工作流', order: 15 }, component: Icon },
    { options: { id: 'pbide', label: () => 'PBIDE', order: 20 }, component: Icon },
  ]
  const registrations = []
  const cleanups = []
  let overlay
  client.apply({
    connection: { rpc: {} },
    effect(effect) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); return cleanup },
    slots: {
      inject(name, resolve) {
        const value = resolve()
        if (name === 'shell.overlay') overlay = value
        if (typeof value === 'function') cleanups.push(value)
        return value
      },
      register(options, component) {
        registrations.push({ options, component })
        const dispose = () => {}
        dispose.options = options
        dispose.component = component
        return dispose
      },
      subscribe() { return () => {} },
      entriesOfSlot(name) { return name === 'main' ? mains : name === 'sidebar.panellist' ? sides : [] },
    },
  })
  const mirrors = registrations.filter(entry => entry.options.name === 'world.app.page')
  assert.equal(mirrors.length, 1)
  assert.equal(mirrors[0].options.key, 'workflow-studio')
  assert.equal(mirrors[0].component, MainPage)
  assert.equal(mirrors[0].options.locale, 'workflow-studio')
  assert.equal(mirrors[0].options.inject, injectFace)
  assert.equal(mirrors[0].options.children, undefined)
  const face = overlay.options.inject()
  assert.equal(typeof face.openSettings, 'function')
  assert.equal(face.openSettings(), false)
  const catalog = face.catalog
  assert.equal(catalog.getSnapshot().length, 1)
  assert.equal(catalog.getSnapshot()[0].key, 'workflow-studio')
  cleanups.forEach(cleanup => cleanup())
})

test('built-in application host owns a guarded source editor and git service', async () => {
  const host = await readFile(join(root, 'index.js'), 'utf8')
  assert.match(host, /path: `\/api\/\$\{serviceName\}\/\$\{operation\}`/)
  assert.match(host, /createVscodeSourceEditor\(ctx/)
  assert.match(host, /serve\(ctx, 'world-vscode-source'/)
  assert.match(host, /createVscodeGit\(ctx/)
  assert.match(host, /ctx\.inject\(\['subprocess'\]/)
  assert.match(host, /serve\(scope, 'world-vscode-git'/)
  assert.match(host, /request\.signal/)
  const editor = await readFile(join(root, 'source-editor.js'), 'utf8')
  assert.match(editor, /ctx\.sandboxPolicy\.resolve\(\{ session \}\)/)
  assert.match(editor, /replaceIfVersion/)
  assert.match(editor, /ctx\.fs\.contains\(root, target\)/)
  const git = await readFile(join(root, 'git.js'), 'utf8')
  assert.match(git, /ctx\.sandboxPolicy\.resolve\(\{ session \}\)/)
  assert.match(git, /normalizePaths/)
  assert.match(git, /show-prefix/)
})
