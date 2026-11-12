/**
 * 别的插件留在磁盘上的「可以直接打开的文件夹」。
 *
 * 两个来源：
 *  - IMA：知识库 / 笔记是一套云端虚拟目录，挂载点由 ima 插件注册（或默认在
 *    `$DSH_HOME/ima/knowledge.workspace`）。宿主 fs 已经被它的 overlay 接管，所以这里
 *    只要把路径交出去，打开后 listDir / 读取都由 ima 自己回答。
 *  - PowerBuilder：pbnpm / pbnpm-pbd 会把打开的 .pbt / .exe 解析成同级
 *    `<名字>.workspace` 目录，登记文件里记着每一个。工程目录里是虚拟库映射，
 *    同样靠它们的 overlay 提供内容。
 *
 * 这里不复制任何实现，只回答「有什么可以打开」和「pbnpm 在哪」。
 */
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'

/** 登记文件里最多读这么多工程：侧栏是给人点的，不是给脚本翻的。 */
const MAX_PROJECTS = 40
/** 安装后插件在同一个 `@local/` 下；开发目录是相邻的插件目录。两种布局都认。 */
const TOOL_LAYOUTS = [
  ['..', 'dsh-pbnpm', 'bin'],
  ['..', 'pbnpm', 'bin'],
  ['..', 'dsh-pbnpm-pbd', 'bin'],
  ['..', 'pbnpm-pbd', 'bin'],
]
const REGISTRIES = [
  { plugin: 'pbnpm-pbd', parts: ['pbnpm-pbd', 'projects.json'] },
  { plugin: 'pbnpm', parts: ['pbnpm', 'projects.json'] },
]

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * pbnpm 带一个 CLI（`bin/pbnpm.exe`），终端会把所在目录放到 PATH 前面。
 * 按安装布局找出真实存在的目录；找不到就返回空数组，PATH 保持原样。
 */
export function discoverToolDirs(baseDir) {
  const found = []
  for (const parts of TOOL_LAYOUTS) {
    const dir = resolve(baseDir, ...parts)
    let usable = false
    try {
      usable = statSync(dir).isDirectory()
        && (existsSync(join(dir, 'pbnpm.exe')) || existsSync(join(dir, 'pbnpm')))
    } catch { usable = false }
    if (usable && !found.includes(dir)) found.push(dir)
  }
  return found
}

/** IMA 的挂载点：优先问 project-tree 登记的虚拟根，它才是带用户配置的那一份。 */
function imaLocation(ctx) {
  let registered = []
  try { registered = ctx.get?.('projectTreeRoots')?.list?.() ?? [] } catch { registered = [] }
  const hit = registered.find(root => root?.id === 'ima' && typeof root.path === 'string' && root.path)
  if (hit) return { path: hit.path, label: hit.label || 'IMA', registered: true }
  return { path: join(dshHome(), 'ima', 'knowledge.workspace'), label: 'IMA', registered: false }
}

/** 登记文件是别的插件的私有格式，读不懂就当没有，不因为一行坏数据拦住整个列表。 */
async function readProjects(ctx, { plugin, parts }, signal) {
  let raw
  try { raw = await readFile(join(dshHome(), ...parts), 'utf8') }
  catch { return [] }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch { return [] }
  const list = Array.isArray(parsed?.projects) ? parsed.projects : []
  const out = []
  for (const item of list) {
    signal?.throwIfAborted()
    if (!item || typeof item.root !== 'string' || !item.root) continue
    if (typeof item.pbtPath !== 'string' || !item.pbtPath) continue
    const info = await stat(ctx, item.root, signal)
    if (!info || info.type !== 'directory') continue
    const extension = extname(item.pbtPath).toLowerCase()
    out.push({
      id: `${plugin}:${item.pbtPath}`,
      plugin,
      kind: extension === '.exe' ? 'exe' : 'pbt',
      name: item.pbtPath.split(/[\\/]/u).at(-1) || item.pbtPath,
      root: item.root,
      pbtPath: item.pbtPath,
      pbVersion: Number.isInteger(item.pbVersion) ? item.pbVersion : null,
      libraries: Array.isArray(item.libraries) ? item.libraries.length : 0,
    })
  }
  return out
}

/** 宿主 fs.stat 对虚拟根也会作答；不存在的路径返回 undefined。 */
async function stat(ctx, path, signal) {
  try { return await ctx.fs.stat(await ctx.fs.resolve(path, { signal }), signal) }
  catch { return undefined }
}

/**
 * @param ctx Host context: `fs` answers for both the disk and the plugin overlays.
 * @param config `FsError` for the RPC vocabulary and the tool folders found at load time.
 */
export function createWorkspaceRoots(ctx, { FsError, toolDirs }) {
  const fail = (message, code) => { throw new FsError(message, code) }

  return {
    /** One scan answers everything the explorer needs; nothing here is a file write. */
    async call(operation, payload, signal) {
      if (operation !== 'scan') fail('不支持的目录探测操作。', 'WORLD_ROOTS_OP')
      const active = signal ?? AbortSignal.timeout(5000)
      const location = imaLocation(ctx)
      // 交出去的路径用宿主规范化过的形态：客户端拿它和窗口根比对，斜杠不一致就认不出来
      let imaPath = location.path
      try { imaPath = ctx.fs.processPath(await ctx.fs.resolve(location.path, { signal: active })) } catch { imaPath = location.path }
      let ima = { available: false, path: imaPath, label: location.label, error: '' }
      const info = await stat(ctx, location.path, active)
      if (info?.type === 'directory') {
        ima = { available: true, path: imaPath, label: location.label, error: '' }
      } else {
        // 挂载点没有内容最常见的原因是没授权，把「去设置里填」写在错误里，别只说不可用。
        ima.error = location.registered
          ? 'IMA 已挂载但读不出目录，检查 IMA 授权后刷新。'
          : '没有找到 IMA 工作区。启用 ima 插件并完成授权后刷新。'
      }

      const seen = new Set()
      const projects = []
      for (const registry of REGISTRIES) {
        for (const project of await readProjects(ctx, registry, active)) {
          if (seen.has(project.root)) continue
          seen.add(project.root)
          projects.push(project)
        }
      }
      projects.sort((left, right) => left.name.localeCompare(right.name))
      const tools = toolDirs().map(dir => ({
        name: 'pbnpm',
        dir,
        exe: join(dir, 'pbnpm.exe'),
      }))
      return { ima, projects: projects.slice(0, MAX_PROJECTS), truncated: projects.length > MAX_PROJECTS, tools }
    },
  }
}
