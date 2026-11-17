import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const host = process.env.WORLD_DSH_SOURCE || 'E:/deepseek-harness'
const require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
const { chromium } = require('playwright-core')
let build
try { ({ build } = await import('esbuild')) }
catch { ({ build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')) }
const react = join(root, '../workflow-studio/node_modules/react'), reactDom = join(root, '../workflow-studio/node_modules/react-dom')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/native-document-entry.jsx'], bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', write: false, outdir: 'tmp/native-document-browser',
  tsconfig: join(host, 'tsconfig.base.json'), logLevel: 'silent',
  loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  alias: { react, 'react-dom': reactDom,
    '@deepseek-ai/dsh-client-ui-primitives': join(host, 'packages/client/ui-primitives/lib/index.js'),
    '@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx': join(host, 'packages/client/ui-renderer/src/client/scoped-slots.tsx') },
  plugins: [{ name: 'world-styles', setup(builder) {
    builder.onLoad({ filter: /world[\\/]styles\.css$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8'), loader: 'text' }))
  } }],
})
const previewRoot = join(host, 'packages/client/ui-sidebar-documentpreview')
const fixture = await build({ entryPoints: [join(previewRoot, 'tests/pdf-fixture.ts')], bundle: true, platform: 'node', format: 'esm', write: false })
const { pdfFixture } = await import('data:text/javascript;base64,' + Buffer.from(fixture.outputFiles[0].contents).toString('base64'))
const pdf = pdfFixture()
const xlsx = createRequire(join(previewRoot, 'package.json'))('xlsx')
const ExcelJS = createRequire(join(previewRoot, 'package.json'))('exceljs')
const workbook = xlsx.utils.book_new()
xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['中文表格', '金额'], ['研发', 1234.5]]), '预算')
xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['第二张工作表']]), '明细')
const modern = new ExcelJS.Workbook()
for (const [name, rows] of [['预算', [['中文表格', '金额'], ['研发', 1234.5]]], ['明细', [['第二张工作表']]]]) {
  const sheet = modern.addWorksheet(name)
  sheet.addRows(rows)
  sheet.columns.forEach(column => { column.width = 18 })
}
const files = new Map([['a.pdf', pdf], ['b.pdf', pdf], ['budget.xls', xlsx.write(workbook, { type: 'buffer', bookType: 'xls' })],
  ['budget.xlsx', new Uint8Array(await modern.xlsx.writeBuffer())], ['broken.pdf', new TextEncoder().encode('broken PDF')]])
const officePdfs = new Map()
if (process.env.WORLD_DOCUMENT_REAL_OFFICE === '1') {
  const kitRequire = createRequire(join(host, 'packages/document/office-to-pdf/package.json'))
  const { createConverter } = await import(pathToFileURL(kitRequire.resolve('@deepseek-ai/libreoffice-kit')))
  const temporaryRoot = join(root, 'tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'native-office-'))
  const converter = await createConverter({ timeoutMs: 45000, fontMetadataCacheDirectory: false })
  try {
    for (const [name, sample] of [
      ['报告 #1.doc', 'apps/web/tests/fixtures/office/preview.doc'],
      ['报告.docx', 'scripts/fixtures/office-render/color-blocks.docx'],
      ['slides.ppt', 'apps/web/tests/fixtures/office/preview.ppt'],
      ['slides.pptx', 'scripts/fixtures/office-render/color-blocks.pptx'],
    ]) {
      const inputPath = join(directory, name), outputPath = inputPath + '.pdf'
      const bytes = await readFile(join(host, sample)); files.set(name, bytes)
      await writeFile(inputPath, bytes)
      await converter.render({ inputPath, outputPath }, AbortSignal.timeout(50000))
      officePdfs.set(name, await readFile(outputPath))
      console.log('Native Office conversion passed:', name, officePdfs.get(name).length, 'PDF bytes')
    }
  } finally {
    await converter.dispose()
    assert.equal(dirname(directory), temporaryRoot)
    await rm(directory, { recursive: true, force: true })
  }
}
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const shots = process.env.WORLD_DOCUMENT_SHOTS_DIR || join(root, '../../../.tmp/world-documents')
await mkdir(shots, { recursive: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
page.setDefaultTimeout(15000)
const errors = [], calls = []
let holdBytes = false, releaseBytes
page.on('pageerror', error => { errors.push(error.message); console.log('Page error:', error.message) })
page.on('console', msg => { if (msg.type() === 'error') console.log('Browser console:', msg.text().slice(0, 1200)) })
try {
  await page.exposeBinding('__worldDocumentRead', async (_source, method, args) => {
    calls.push({ method, args })
    const name = (args[1] || '').split('/').at(-1)
    const data = files.get(name) || new Uint8Array([1, 2, 3])
    const value = { absolutePath: args[1], version: 'v1', bytes: data.length }
    if (method === 'stat') return { ok: true, value }
    if (method === 'bytes') {
      if (holdBytes && name === 'b.pdf') await new Promise(resolve => { releaseBytes = resolve })
      return { ok: true, value: { ...value, data: [...data] } }
    }
    if (method === 'office') return { ok: true, value: { ...value, data: [...(officePdfs.get(name) || pdf)], missingFonts: [], generation: 'fixture-generation' } }
    throw new Error(`Unexpected native text read: ${name}`)
  })
  await page.route('http://world.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#root{width:100vw;height:100vh}</style></head><body><div id="root"></div></body></html>' }))
  await page.goto('http://world.test/')
  await page.addStyleTag({ content: await readFile(join(host, 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8') })
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text })
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text })
  for (const file of ['client.js', 'client.pdf.js', 'client.excel.js']) await page.addScriptTag({ content: await readFile(join(previewRoot, 'lib', file), 'utf8') })
  await page.evaluate(() => window.__worldNativeDocuments.boot())
  const file = name => page.getByRole('button', { name, exact: true })
  const preview = () => page.locator('.world-vscode-document:visible')
  const painted = () => page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-document canvas')].some(node => {
    if (!node.width || !node.height || !node.getClientRects().length) return false
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height).data
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] && (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220)) return true
    return false
  }))
  await file('a.pdf').dblclick()
  await preview().locator('canvas').first().waitFor()
  await painted()
  const pdfGeometry = await preview().evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
  await page.screenshot({ path: join(shots, 'pdf.png') })
  await file('notes.js').click()
  await page.locator('.world-vscode-textarea').waitFor()
  await page.getByRole('tab', { name: /a\.pdf/u }).click()
  assert.equal(calls.filter(call => call.method === 'bytes' && call.args[1] === '/workspace/a.pdf').length, 1, 'switching tabs retains the PDF buffer')
  for (const name of ['报告 #1.doc', '报告.docx', 'slides.ppt', 'slides.pptx']) {
    await file(name).click()
    await preview().locator('canvas').first().waitFor()
    await painted()
    assert.ok(calls.some(call => call.method === 'office' && call.args[1] === '/workspace/' + name), `${name} uses the native Office service`)
    assert.equal(await preview().locator('[data-slot-error]').count(), 0)
  }
  await page.screenshot({ path: join(shots, 'office.png') })
  for (const name of ['budget.xls', 'budget.xlsx']) {
    await file(name).click()
    await preview().locator('.fortune-sheet-container').waitFor()
    await preview().getByText('预算', { exact: true }).first().waitFor()
    await preview().getByText('明细', { exact: true }).first().waitFor()
    await preview().getByText('中文表格', { exact: true }).first().waitFor()
    await preview().getByText('明细', { exact: true }).first().click()
    await preview().getByText('第二张工作表', { exact: true }).first().waitFor()
    await preview().getByText('预算', { exact: true }).first().click()
    await preview().getByText('中文表格', { exact: true }).first().waitFor()
  }
  await page.screenshot({ path: join(shots, 'excel.png') })
  await page.setViewportSize({ width: 360, height: 740 })
  await page.evaluate(() => { document.body.dataset.worldLayout = 'phone' })
  const phoneGeometry = await preview().evaluate(node => ({ width: node.getBoundingClientRect().width,
    height: node.getBoundingClientRect().height, x: node.getBoundingClientRect().x }))
  assert.equal(phoneGeometry.width, await page.locator('.world-vscode-editor').evaluate(node => node.clientWidth), 'the preview fills the existing editor width')
  assert.ok(phoneGeometry.width <= 360)
  assert.ok(phoneGeometry.x + phoneGeometry.width <= 360, 'the complete preview stays inside the phone viewport')
  await page.screenshot({ path: join(shots, 'excel-phone.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => { document.body.dataset.worldLayout = 'desktop' })
  await file('broken.pdf').click()
  await preview().getByRole('alert').waitFor()
  assert.equal(await page.locator('.world-vscode-textarea:visible').count(), 0)
  holdBytes = true
  await file('b.pdf').click()
  await page.waitForFunction(() => window.__worldNativeDocuments.calls.some(call => call.method === 'bytes' && call.args[1] === '/workspace/b.pdf'))
  assert.equal(typeof releaseBytes, 'function')
  await file('notes.js').click()
  await page.locator('.world-vscode-textarea').waitFor()
  releaseBytes(); holdBytes = false
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.locator('.world-vscode-textarea').inputValue(), 'const value = 1\n', 'a late document read cannot overwrite the selected source tab')
  await file('b.pdf').click()
  await preview().locator('canvas').first().waitFor()
  await page.getByRole('button', { name: '关闭标签 b.pdf', exact: true }).click()
  await page.getByRole('button', { name: '关闭标签 a.pdf', exact: true }).click()
  await page.waitForFunction(() => window.__worldNativeDocuments.references() === 0)
  await page.evaluate(() => window.__worldNativeDocuments.suspend())
  await file('b.pdf').click()
  await preview().getByRole('alert').filter({ hasText: '当前 DSH 未提供原生文档预览组件' }).waitFor()
  await page.evaluate(() => window.__worldNativeDocuments.resume())
  await preview().locator('canvas').first().waitFor()
  await page.getByRole('button', { name: '关闭标签 b.pdf', exact: true }).click()
  await page.waitForFunction(() => window.__worldNativeDocuments.references() === 0)
  assert.equal(calls.some(call => call.method === 'text'), false, 'binary documents never enter the native text reader')
  assert.equal(await page.evaluate(() => window.__worldNativeDocuments.calls.some(call => call.method === 'world-vscode-source/open' && /\.(pdf|docx?|xlsx?|pptx?)$/u.test(call.payload.path))), false)
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.__worldNativeDocuments.dispose())
  console.log('Native document browser passed:', JSON.stringify({ pdfGeometry, phoneGeometry, nativeReads: calls.map(call => [call.method, call.args[1]]), shots }))
} finally { await browser.close() }
