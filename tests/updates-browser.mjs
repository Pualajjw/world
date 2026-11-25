import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorldUpdates, WORLD_PACKAGE } from '../updates.js'

export async function checkUpdates(browser, bundleText, shotsDir) {
  const currentVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  for (const source of ['github', 'pbpkg']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    let installed = null, releaseInstall, failCheck = false, missingPackage = false, dropStatus = false, latestVersion = '9.0.0'
    const errors = [], calls = []
    const service = createWorldUpdates({ currentVersion, readVersion: async () => '0.2.2-rc.3',
      manager: { listBundles: async () => [
        { name: WORLD_PACKAGE, installed: true, version: installed || currentVersion },
        ...(source === 'pbpkg' ? [{ name: '@local/dsh-pbpkg', installed: true, enabled: true }] : []),
      ], inspect: async () => ({ status: 'accepted' }),
      installBundle: async (spec, options) => { calls.push({ spec, options }); return new Promise(resolve => {
        releaseInstall = () => { installed = options.expected.version; resolve({ application: 'restart-required', version: installed }) }
      }) } },
      verifyArtifact: async artifact => ({ manifest: { name: WORLD_PACKAGE, version: latestVersion }, spec: artifact.spec }),
      pbpkg: async operation => {
        if (failCheck) throw new Error('更新源暂时不可用')
        if (missingPackage && operation === 'prepare') throw new Error("ENOENT: no such file or directory, realpath 'E:/plugins/world/dist/world-9.0.0-universal.tgz'")
        return operation === 'list'
        ? { rows: [{ filename: `world-${latestVersion}-universal.tgz`, path: `world/world-${latestVersion}-universal.tgz`, sha256: 'abc', sourceId: 'team' }], activeSourceId: 'team', sources: [{ id: 'team', name: '团队插件源' }] }
        : { spec: `file:${fileURLToPath(import.meta.url)}`, sha256: 'abc', size: 10 } },
      fetchJson: async url => { if (failCheck) throw new Error('更新源暂时不可用'); return url.includes('/commits/')
        ? { sha: 'a'.repeat(40) } : { name: WORLD_PACKAGE, version: latestVersion, dsh: { bundle: { patch: './cordis.patch.yml' } } } },
    })
    // GitHub exercises upgrade/recovery; pbpkg exercises same-version reinstallation.
    try {
      page.on('pageerror', error => errors.push(error.message))
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldUpdateCall', async (_source, operation, payload) => {
        try {
          if (operation === 'status' && dropStatus) { dropStatus = false; throw new Error('连接中断，请重试以查询原安装结果。') }
          const value = await service.call(operation, payload)
          // Reproduce the reported screen: current version equals the old successful installation.
          if (operation === 'info' && !installed) value.job = {
            state: 'success', version: currentVersion, message: `world ${currentVersion} 已安装，请重启 DSH。`,
          }
          if (operation === 'info' && installed) value.currentVersion = value.installedVersion
          return { ok: true, value }
        } catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
      })
      await page.route('http://127.0.0.1/world-update-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
      await page.goto('http://127.0.0.1/world-update-fixture')
      await page.addStyleTag({ content: ':root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f9fd;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-border-l2:#e1e6ee}' })
      await page.addScriptTag({ content: bundleText })
      const version = page.locator('[data-world-version]')
      await page.waitForFunction(() => document.querySelector('[data-world-version]')?.textContent.includes('DSH v0.2.2-rc.3'))
      const original = await version.evaluate(node => {
        const lines = [...node.querySelectorAll('.world-version-numbers > span')].map(line => line.getBoundingClientRect())
        const button = node.querySelector('button').getBoundingClientRect(), numbers = node.querySelector('.world-version-numbers').getBoundingClientRect()
        return { font: getComputedStyle(node).fontSize, lineHeight: getComputedStyle(node).lineHeight,
          x: node.getBoundingClientRect().x, height: numbers.height, rows: lines.length,
          aligned: lines[0].x === lines[1].x && lines[1].top === lines[0].bottom,
          buttonCentered: button.x >= numbers.right && Math.abs((button.top + button.bottom) / 2 - (numbers.top + numbers.bottom) / 2) < 1 }
      })
      assert.deepEqual(original, { font: '11px', lineHeight: '14px', x: 16, height: 28, rows: 2, aligned: true, buttonCentered: true })
      await page.locator('[data-world-update-open]').click()
      const panel = page.locator('[data-world-update]'), dialog = panel.getByRole('dialog')
      await dialog.getByText('最新版本：v9.0.0', { exact: true }).waitFor({ timeout: 5000 })
      assert.equal(await dialog.getByRole('status').filter({ hasText: `${currentVersion} 已安装` }).count(), 0,
        'a completed install of the running version must not block checking or show a restart notice')
      const geometry = await dialog.evaluate(node => ({ width: node.getBoundingClientRect().width, padding: getComputedStyle(node).padding, radius: getComputedStyle(node).borderRadius,
        withinViewport: node.getBoundingClientRect().bottom <= innerHeight && node.getBoundingClientRect().top >= 40 }))
      assert.deepEqual(geometry, { width: 560, padding: '20px', radius: '8px', withinViewport: true })
      assert.match(await dialog.innerText(), source === 'github' ? /GitHub · Pualajjw\/world/u : /pbpkg · 团队插件源/u)
      assert.equal(calls.length, 0, 'checking updates never installs')
      if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.screenshot({ path: join(shotsDir, `updates-${source}.png`) }) }
      await dialog.getByRole('button', { name: '升级 world', exact: true }).click()
      await page.locator('[data-world-confirm] [data-role="cancel"]').click()
      assert.equal(calls.length, 0, 'cancelled confirmation never installs')
      if (source === 'github') {
        await dialog.getByRole('button', { name: '升级 world', exact: true }).click()
        await page.locator('[data-world-confirm] [data-role="confirm"]').click()
        while (!releaseInstall) await page.waitForTimeout(10)
        assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).isEnabled(), false)
        dropStatus = true
        await dialog.getByRole('alert').filter({ hasText: '连接中断' }).waitFor()
        assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).isEnabled(), false, 'unknown install cannot be submitted again')
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        releaseInstall()
        await page.locator('[data-world-update-open]').click()
        await dialog.getByRole('status').filter({ hasText: '已安装，请重启 DSH' }).waitFor()
        await dialog.getByText('最新版本：v9.0.0', { exact: true }).waitFor()
        assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).count(), 0,
          'the already installed target cannot be installed twice')
        assert.equal(calls.length, 1, 'closing and reopening recovers the original installation')
        latestVersion = '9.0.1'
        await dialog.getByRole('button', { name: '检查更新', exact: true }).click()
        await dialog.getByText('最新版本：v9.0.1', { exact: true }).waitFor()
        assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).isEnabled(), true,
          'a pending restart for the previous target cannot hide a newer available target')
        if (shotsDir) await page.screenshot({ path: join(shotsDir, 'updates-newer-after-install.png') })
      } else {
        failCheck = true
        await dialog.getByRole('button', { name: '检查更新', exact: true }).click()
        await dialog.getByRole('alert').filter({ hasText: '更新源暂时不可用' }).waitFor()
        failCheck = false
        await dialog.getByRole('button', { name: '重试', exact: true }).click()
        await dialog.getByText('最新版本：v9.0.0', { exact: true }).waitFor()
        missingPackage = true
        await dialog.getByRole('button', { name: '检查更新', exact: true }).click()
        const missing = dialog.getByRole('alert').filter({ hasText: '索引引用了不存在的安装包' })
        await missing.waitFor()
        assert.match(await missing.innerText(), /团队插件源.*world-9\.0\.0-universal\.tgz.*重新打包 world.*index\.json/u)
        assert.doesNotMatch(await dialog.innerText(), /ENOENT|realpath/u)
        assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).count(), 0)
        assert.equal(calls.length, 0, 'a missing package never triggers installation')
        assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth), false)
        if (shotsDir) await page.screenshot({ path: join(shotsDir, 'updates-missing-package.png') })
        missingPackage = false
        await dialog.getByRole('button', { name: '重试', exact: true }).click()
        await dialog.getByText('最新版本：v9.0.0', { exact: true }).waitFor()
        latestVersion = currentVersion
        await dialog.getByRole('button', { name: '检查更新', exact: true }).click()
        await dialog.getByRole('status').filter({ hasText: '当前已是最新版本。' }).waitFor()
        assert.equal(await dialog.getByRole('status').filter({ hasText: '请重启 DSH' }).count(), 0)
        const reinstall = dialog.getByRole('button', { name: '重装 world', exact: true })
        if (shotsDir) await page.screenshot({ path: join(shotsDir, 'updates-reinstall.png') })
        await reinstall.click()
        const prompt = page.getByRole('alertdialog', { name: '重装 world' })
        await prompt.getByRole('button', { name: '取消' }).click()
        assert.equal(calls.length, 0)
        await reinstall.click()
        await prompt.getByRole('button', { name: '确认重装' }).click()
        while (!releaseInstall) await page.waitForTimeout(10)
        assert.equal(await reinstall.isEnabled(), false)
        releaseInstall()
        await dialog.getByRole('status').filter({ hasText: '已安装，请重启 DSH' }).waitFor()
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].options.expected, { name: WORLD_PACKAGE, version: currentVersion })
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        await page.locator('[data-world-update-open]').click()
        await dialog.getByText(`最新版本：v${currentVersion}`, { exact: true }).waitFor()
        assert.equal(await reinstall.count(), 0)
        await dialog.getByRole('status').filter({ hasText: '已安装，请重启 DSH' }).waitFor()
        latestVersion = '9.0.1'
        await dialog.getByRole('button', { name: '检查更新', exact: true }).click()
        await dialog.getByText('最新版本：v9.0.1', { exact: true }).waitFor()
        assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).isEnabled(), true)
        await page.setViewportSize({ width: 360, height: 740 })
        assert.equal(await dialog.evaluate(node => node.getBoundingClientRect().width), 336)
        assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth), false)
        if (shotsDir) await page.screenshot({ path: join(shotsDir, 'updates-phone.png') })
      }
      await dialog.getByRole('button', { name: '关闭', exact: true }).focus()
      await page.keyboard.press('Escape')
      assert.equal(await panel.count(), 0)
      assert.deepEqual(errors, [])
      console.log(`Updates UI passed: ${source}; ${JSON.stringify(geometry)}; check-only, confirm/cancel, source errors, job recovery and version display.`)
    } finally { service.dispose(); await page.close() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
  const { build } = require('esbuild'), { chromium } = require('playwright-core')
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkUpdates(browser, bundle.outputFiles[0].text, process.env.WORLD_UPDATE_SHOTS_DIR) }
  finally { await browser.close() }
}
