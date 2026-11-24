/** Exercise multi-interface selection without changing the machine's network adapters. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'
const root = join(import.meta.dirname, '..')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const { build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {MobileConnect} from './mobile-connect.js';import css from './styles.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(React.createElement(MobileConnect,{rpc:{call:(_base,method,payload)=>window.mobileRpc(method,payload)},onClose:()=>root.render(null)}));window.mount();
` }, bundle: true, format: 'iife', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ ...browserLaunchOptions(), ...(process.env.WORLD_BROWSER ? { executablePath: process.env.WORLD_BROWSER, channel: undefined } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = [], calls = []
  page.on('pageerror', error => errors.push(error.message))
  let startupState = 'removed', selectedHost = '', configured = false, count = 2, token = 'a'.repeat(43)
  const hosts = [{ name: '以太网', address: '192.168.1.3' }, { name: 'Wi-Fi', address: '192.168.2.3' }]
  await page.exposeBinding('mobileRpc', (_source, method, payload) => {
    if (method.startsWith('world-startup/')) {
      assert.equal(payload.id,'mobile'); if (method === 'world-startup/set') startupState=payload.state
      return {ok:true,value:{state:startupState}}
    }
    calls.push({ method, payload })
    if (method === 'world-mobile/addresses') return { ok: true, value: { configured, selectedHost, addresses: hosts.slice(0, count) } }
    assert.ok(['world-mobile/open', 'world-mobile/reset'].includes(method))
    if (method === 'world-mobile/reset') token = 'b'.repeat(43)
    selectedHost = payload.host
    return { ok: true, value: { url: `http://${payload.host}:53319/#world-pair=${token}`, persistent: true } }
  })
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body data-world-theme="light" style="--world-desktop-top:0px;--world-taskbar-height:48px"><div id="root"></div></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  // Exercise both clipboard mechanisms and an explicit rejection without relying on OS clipboard permission.
  await page.evaluate(() => {
    window.copyMode = 'native'; window.copied = []; window.fallbackCopies = []; window.copyRelease = null
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
      if (window.copyMode !== 'native' && window.copyMode !== 'delayed') throw new Error('clipboard denied')
      if (window.copyMode === 'delayed') await new Promise(resolve => { window.copyRelease = resolve })
      window.copied.push(value)
    } } })
    document.execCommand = command => {
      if (command !== 'copy' || window.copyMode === 'failed') return false
      window.fallbackCopies.push(document.activeElement.value)
      return true
    }
  })
  const select = page.getByRole('combobox', { name: '手机连接网络地址' })
  await select.waitFor()
  assert.deepEqual(await select.locator('option').allTextContents(), ['请选择手机可访问的电脑 IP', '以太网 · 192.168.1.3', 'Wi-Fi · 192.168.2.3'])
  assert.equal(calls.filter(row => row.method === 'world-mobile/open').length, 0)
  assert.equal(await page.locator('.world-mobile-qr').count(), 0)
  assert.equal(await page.getByRole('button', { name: '复制地址', exact: true }).isDisabled(), true)
  await select.selectOption('192.168.2.3')
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(calls.at(-1).payload.host, '192.168.2.3')
  const width = Math.round((await page.locator('.world-mobile-qr').boundingBox()).width)
  assert.equal(width, 240)
  const desktopLayout = await page.locator('.world-wallpaper-foot').evaluate(node => ({
    buttonHeight: node.querySelector('.world-mobile-copy').getBoundingClientRect().height, gap: getComputedStyle(node).gap,
  }))
  assert.deepEqual(desktopLayout, { buttonHeight: 30, gap: '8px' })
  const auto = page.getByRole('checkbox',{name:'随 World 启动手机连接'})
  await select.focus(); await page.keyboard.press('Tab'); assert.ok(await auto.evaluate(n=>n===document.activeElement))
  await auto.check(); await page.waitForFunction(()=>document.querySelector('.world-mobile-network input')?.checked)
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: '重置链接' }).evaluate(node => node === document.activeElement), true)
  assert.equal(await page.getByText('二维码长期有效，重启 DSH 后仍可扫描。').count(), 1)
  assert.equal(await page.getByRole('button', { name: '重置链接' }).isDisabled(), false)
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: '复制地址', exact: true }).evaluate(node => node === document.activeElement), true)
  const copy = page.getByRole('button', { name: '复制地址', exact: true })
  await copy.click()
  await page.getByText('已复制', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.copied), [`http://192.168.2.3:53319/#world-pair=${token}`])
  assert.equal(await page.getByRole('button', { name: '复制地址' }).evaluate(node => node === document.activeElement), true)
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: '关闭', exact: true }).evaluate(node => node === document.activeElement), true)
  await select.selectOption('192.168.1.3')
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(calls.at(-1).payload.host, '192.168.1.3')
  await page.getByText('复制地址', { exact: true }).waitFor()
  await page.evaluate(() => { window.copyMode = 'fallback'; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }) })
  await copy.click()
  await page.getByText('已复制', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.fallbackCopies), [`http://192.168.1.3:53319/#world-pair=${token}`])
  assert.equal(await page.locator('textarea').count(), 0, 'the fallback removes its temporary input')
  assert.equal(await copy.evaluate(node => node === document.activeElement), true, 'fallback restores keyboard focus')
  await page.evaluate(() => { window.copyMode = 'failed' })
  await copy.click()
  await page.getByRole('alert').filter({ hasText: '复制失败' }).waitFor()
  assert.equal(await copy.isEnabled(), true)
  await page.evaluate(() => { window.copyMode = 'fallback' })
  await copy.click()
  await page.getByText('已复制', { exact: true }).waitFor()
  // Screenshots are diagnostics only; keep them out of the checked-in tree.
  const shots = process.env.WORLD_MOBILE_SHOTS_DIR || join(tmpdir(), 'world-mobile-check')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'network-choice.png') })
  await page.setViewportSize({ width: 280, height: 700 })
  await page.waitForFunction(() => document.querySelector('.world-mobile-qr').getBoundingClientRect().width < 240)
  const narrow = await page.locator('.world-mobile-qr').boundingBox()
  assert.equal(Math.round(narrow.width), Math.round(narrow.height))
  const layout = await page.locator('.world-wallpaper-foot').evaluate(node => ({
    buttonHeight: node.querySelector('.world-mobile-copy').getBoundingClientRect().height,
    gap: getComputedStyle(node).gap, overflow: node.scrollWidth > node.clientWidth,
  }))
  assert.equal(layout.buttonHeight, 40); assert.equal(layout.gap, '8px'); assert.equal(layout.overflow, false)
  await page.screenshot({ path: join(shots, 'network-choice-narrow.png') })
  await page.getByRole('button', { name: '关闭手机连接' }).click()
  await page.evaluate(() => window.mount())
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(await select.inputValue(), '192.168.1.3', 'reopening uses the Host selection')
  assert.equal(await auto.isChecked(),true); await auto.uncheck(); assert.equal(startupState,'disabled')
  await page.getByRole('button', { name: '关闭手机连接' }).click()
  configured = true; count = 1
  await page.evaluate(() => window.mount())
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(await select.count(), 0, 'configured hosts do not show a selector')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', multiAddressSelection: true, refresh: true, configuredHost: true,
    clipboard: ['native', 'LAN HTTP fallback', 'rejection/retry', 'changed host'], qrWidth: width, narrowQrWidth: Math.round(narrow.width), desktopLayout, layout }))
} finally { await browser.close() }
