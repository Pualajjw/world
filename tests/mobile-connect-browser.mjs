/** Exercise multi-interface selection without changing the machine's network adapters. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const { build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {MobileConnect} from './mobile-connect.js';import css from './styles.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(React.createElement(MobileConnect,{rpc:{call:(_base,method,payload)=>window.mobileRpc(method,payload)},onClose:()=>root.render(null)}));window.mount();
` }, bundle: true, format: 'iife', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = [], calls = []
  page.on('pageerror', error => errors.push(error.message))
  let selectedHost = '', configured = false, count = 2
  const hosts = [{ name: '以太网', address: '192.168.1.3' }, { name: 'Wi-Fi', address: '192.168.2.3' }]
  await page.exposeBinding('mobileRpc', (_source, method, payload) => {
    calls.push({ method, payload })
    if (method === 'world-mobile/addresses') return { ok: true, value: { configured, selectedHost, addresses: hosts.slice(0, count) } }
    assert.equal(method, 'world-mobile/open')
    selectedHost = payload.host
    return { ok: true, value: { url: `http://${payload.host}:53319/#world-pair=${'a'.repeat(43)}`, expiresAt: Date.now() + 300000 } }
  })
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body data-world-theme="light" style="--world-desktop-top:0px;--world-taskbar-height:48px"><div id="root"></div></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const select = page.getByRole('combobox', { name: '手机连接网络地址' })
  await select.waitFor()
  assert.deepEqual(await select.locator('option').allTextContents(), ['请选择手机可访问的电脑 IP', '以太网 · 192.168.1.3', 'Wi-Fi · 192.168.2.3'])
  assert.equal(calls.filter(row => row.method === 'world-mobile/open').length, 0)
  assert.equal(await page.locator('.world-mobile-qr').count(), 0)
  await select.selectOption('192.168.2.3')
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(calls.at(-1).payload.host, '192.168.2.3')
  const width = Math.round((await page.locator('.world-mobile-qr').boundingBox()).width)
  assert.equal(width, 240)
  await select.focus(); await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: '刷新二维码' }).evaluate(node => node === document.activeElement), true)
  await page.getByRole('button', { name: '刷新二维码' }).click()
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(calls.at(-1).payload.host, '192.168.2.3')
  await select.selectOption('192.168.1.3')
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(calls.at(-1).payload.host, '192.168.1.3')
  const shots = join(root, 'tmp/mobile-check')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'network-choice.png') })
  await page.setViewportSize({ width: 280, height: 700 })
  await page.waitForFunction(() => document.querySelector('.world-mobile-qr').getBoundingClientRect().width < 240)
  const narrow = await page.locator('.world-mobile-qr').boundingBox()
  assert.equal(Math.round(narrow.width), Math.round(narrow.height))
  await page.getByRole('button', { name: '关闭手机连接' }).click()
  await page.evaluate(() => window.mount())
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(await select.inputValue(), '192.168.1.3', 'reopening uses the Host selection')
  await page.getByRole('button', { name: '关闭手机连接' }).click()
  configured = true; count = 1
  await page.evaluate(() => window.mount())
  await page.locator('.world-mobile-qr svg').waitFor()
  assert.equal(await select.count(), 0, 'configured hosts do not show a selector')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', multiAddressSelection: true, refresh: true, configuredHost: true, qrWidth: width, narrowQrWidth: Math.round(narrow.width) }))
} finally { await browser.close() }
