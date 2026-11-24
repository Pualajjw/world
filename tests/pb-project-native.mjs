import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createPbActions } from '../pb-actions.js'

const harness = process.env.DSH_SOURCE ?? 'E:/deepseek-harness'
const load = path => import(pathToFileURL(join(harness, path)))
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: LocalSubprocessRuntime } = await load('packages/subprocess/subprocess-local/lib/index.js')
const host = new Context()
await host.plugin(LocalSubprocessRuntime)

// PB8 opt-in exercises the native IDE; launch on a non-input desktop for unattended tests.
const version = Number(process.env.WORLD_PB_TEST_VERSION || 90)
assert.ok([80, 90].includes(version))
// The PB9 fixture checks its first real window, not just whether application.open ran.
const temp = await mkdtemp(join(tmpdir(), 'world pb~test-'))
const python = resolve(import.meta.dirname, '../../pbnpm-pbd/python34_full/python.exe')
// Only project registration and session permissions are fixtures; spawning uses DSH's real contract.
const projects = new Map()
const actions = createPbActions({ get: name => host.get(name), sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } }, {
  roots: { project: async root => projects.get(root) }, sessionOf: async () => ({}), python: () => python,
})
async function action(op, target, options = {}) {
  const root = target + '.workspace'
  projects.set(root, { pbtPath: target, pbVersion: version, kind: target.endsWith('.exe') ? 'exe' : 'pbt' })
  const payload = { sessionId: 'pb-smoke', root, ...options }
  let job = await actions.call(op, payload)
  const deadline = AbortSignal.timeout(60000)
  while (job.running) {
    await delay(50, undefined, { signal: deadline })
    job = await actions.call('status', payload)
  }
  assert.ok(['system','private'].includes(job.diagnostics.temp), 'missing real PB worker temp preamble')
  assert.equal(job.diagnostics.exitCode, 0)
  assert.equal(job.error, '', `${op} ${target}: ${job.error}`)
}
const execute = (...args) => promisify(execFile)(python, ['-I','-B', ...args], { cwd: temp, windowsHide: true, timeout: 60000 })
try {
  const libDir = join(temp, 'lib')
  await mkdir(libDir)
  await mkdir(join(temp,'shared'))
  const window = `forward
global type w_probe from window
end type
end forward

global type w_probe from window
boolean titlebar = true
string title = "PB window visibility test"
end type
global w_probe w_probe
`
  const app = `forward
global type demo from application
end type
end forward

global type demo from application
string appname = "demo"
end type
global demo demo

type prototypes
subroutine ExitProcess(ulong code) library "kernel32.dll"
function long IsWindowVisible(long hwnd) library "user32.dll"
end prototypes

event open;integer f
string setting
${version === 90 ? `Open(w_probe)
if IsWindowVisible(Handle(w_probe)) = 0 then ExitProcess(42)` : ''}
f = FileOpen("${join(temp, 'cwd.txt').replaceAll('~','~~')}", LineMode!, Write!, LockWrite!, Replace!)
FileWrite(f, GetCurrentDirectory())
FileClose(f)
f = FileOpen("startup.txt", LineMode!, Read!)
if f < 0 then ExitProcess(43)
FileRead(f, setting)
FileClose(f)
f = FileOpen("opened.txt", LineMode!, Write!, LockWrite!, Replace!)
FileWrite(f, gf_probe(setting))
FileClose(f)
ExitProcess(0)
end event
`
  const dependency = `global type gf_probe from function_object
end type
forward prototypes
global function string gf_probe (string value)
end prototypes

global function string gf_probe (string value);
return value
end function
`
  await execute('-c', `import os,sys
from pypower import cfg,pyorca
cfg.PBVM_VERSION=${version}
with pyorca.pb_pyorca(${version}) as o:
 lib=os.path.abspath('lib/demo.pbl')
 dep=os.path.abspath('shared/probe.pbl')
 o.create_library(lib,'World smoke')
 o.create_library(dep,'Dependency in another directory')
 o.set_library_list([lib,dep])
 o.set_current_application(lib,'demo')
 errors=o.import_and_compile_object(dep,'gf_probe',pyorca.PBORCA_FUNCTION,sys.argv[3])
 assert not errors,errors
 if ${version} == 90:
  errors=o.import_and_compile_object(lib,'w_probe',pyorca.PBORCA_WINDOW,sys.argv[2])
  assert not errors,errors
 errors=o.import_and_compile_object(lib,'demo',pyorca.PBORCA_APPLICATION,sys.argv[1])
 assert not errors,errors`, app, window, dependency)
  const target = join(temp,'demo.pbt')
  const pbt = (library, dep) => `Save Format v3.0(19990112)\n@begin Projects\n@end;\nappname "demo";\napplib "${library}";\nLibList "${dep};${library}";\ntype "pb";\n`
  await writeFile(target, pbt('lib\\\\demo.pbl','shared\\\\probe.pbl'))
  assert.ok(!(await readdir(temp)).some(p => /\.exe$/i.test(p)))
  async function checkRun(pbtPath, expectedCwd) {
    await writeFile(join(expectedCwd,'startup.txt'), 'saved-pbl\r\n')
    await rm(join(temp,'cwd.txt'), { force:true })
    const targetBytes = await readFile(pbtPath)
    await action('run', pbtPath)
    assert.deepEqual(await readFile(pbtPath),targetBytes)
    assert.ok(!(await readdir(expectedCwd)).some(name => name.startsWith('WorldPB8_')), 'temporary run files were not removed')
    const appCwd = new TextDecoder('gbk').decode(await readFile(join(temp,'cwd.txt'))).trim()
    console.log(`PB${version} PBT: ${pbtPath}; application.open cwd: ${appCwd}`)
    assert.equal((await realpath(appCwd)).toLowerCase(), (await realpath(expectedCwd)).toLowerCase())
    assert.match(await readFile(join(expectedCwd,'opened.txt'),'utf8'), /saved-pbl/)
  }
  // Only the PBT directory has the startup file (not the IDE, PBW or nested application library).
  if (version === 80) {
    const worker = resolve(import.meta.dirname, '../pb-project.py')
    await assert.rejects(execute(worker, 'run', target, '80'), /可写范围/)
    assert.ok(!(await readdir(temp)).some(name => name.startsWith('WorldPB8_')))
  }
  const beforeSplitRun = await readFile(join(libDir,'demo.pbl'))
  await checkRun(target, temp)
  assert.deepEqual(await readFile(join(libDir,'demo.pbl')),beforeSplitRun)
  if (version === 80) {
    const colocated = join(libDir,'demo.pbt')
    await writeFile(colocated, pbt('demo.pbl','..\\\\shared\\\\probe.pbl'))
    await checkRun(colocated, libDir)
  }
  await writeFile(join(libDir,'demo.pbd'),'do-not-overwrite')
  const original = await readFile(join(libDir,'demo.pbl'))
  for (const mode of ['embedded','external']) {
    const out = join(temp,mode), exe = join(out,'demo.exe')
    await action('build', target, { directory: out, mode })
    assert.equal((await readFile(exe)).toString('ascii',0,2),'MZ')
    if (mode === 'external') assert.ok((await stat(join(out,'demo.pbd'))).size > 0)
    await writeFile(join(out,'startup.txt'), 'saved-pbl\r\n')
    await action('run', exe)
    assert.match(await readFile(join(out,'opened.txt'),'utf8'), /saved-pbl/)
  }
  assert.deepEqual(await readFile(join(libDir,'demo.pbl')),original)
  assert.equal(await readFile(join(libDir,'demo.pbd'),'utf8'),'do-not-overwrite')
  console.log(`PB${version} native: ran saved PBL without EXE; built and ran embedded/external EXEs; inputs unchanged.`)
} finally { await actions.dispose(); await host.fiber.dispose(); await rm(temp,{recursive:true,force:true}) }
