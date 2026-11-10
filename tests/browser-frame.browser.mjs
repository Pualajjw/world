/**
 * 内置浏览器窗口的 Playwright 自检：真实 DOM / 实测像素 / 自检 PNG。
 *
 * 这里没有 Electron，于是把主进程的租约桥与 <webview> 元素都换成可断言的桩：
 *   · dshDesktop.browser 记录 acquire / release / onOpenRequested
 *   · document.createElement('webview') 返回一个带 loadURL/getURL/... 的假 guest
 * 这样 lease 生命周期、切标签不重建 DOM、关闭释放都能在无宿主环境里验证。
 * 真实 Electron 的网页尺寸、滚动和租约检查见 browser-native.mjs；其余 P0 探针见 BROWSER-DESIGN.md §16。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const HOST_HTML = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>'
  + '#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}'
  + '#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}'
  + '[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}'
  + '</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

/** 在页面上下文执行：不得引用模块作用域里的任何变量。 */
export function installBrowserProbe() {
  const acquired = []
  const released = []
  const opened = []
  const listeners = new Map()
  window.__worldBrowserProbe = { acquired, released, opened, listeners }
  window.dshDesktop = {
    protocolVersion: 1,
    browser: {
      async acquire(workspace) {
        const lease = `lease-${acquired.length + 1}`
        acquired.push({ lease, workspace })
        return { lease, partition: `persist:world-test-${lease}` }
      },
      async release(lease) { released.push(lease) },
      onOpenRequested(lease, listener) {
        listeners.set(lease, listener)
        return () => listeners.delete(lease)
      },
    },
  }
  window.open = url => { opened.push(String(url)); return null }

  const originalCreate = document.createElement.bind(document)
  document.createElement = function createElement(tagName, options) {
    if (String(tagName).toLowerCase() !== 'webview') return originalCreate(tagName, options)
    const element = originalCreate('div')
    element.setAttribute('data-world-fake-webview', '')
    element.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#eaf3ff;color:#1b4f80;font:14px sans-serif'
    element.textContent = '模拟 guest · 等待导航'
    element.getURL = () => element.dataset.loadUrl || 'about:blank'
    element.getTitle = () => 'Example Domain'
    element.canGoBack = () => false
    element.canGoForward = () => false
    element.isLoading = () => false
    element.clearHistory = () => {}
    element.goBack = () => {}
    element.goForward = () => {}
    element.reload = () => element.loadURL(element.getURL())
    element.loadURL = async url => {
      element.dataset.loadUrl = url
      element.textContent = `模拟 guest · ${url}`
      element.dispatchEvent(new Event('did-navigate'))
      element.dispatchEvent(new Event('did-stop-loading'))
    }
    setTimeout(() => element.dispatchEvent(new Event('dom-ready')), 0)
    return element
  }
}

export async function checkBrowserWindow(browser, root, bundleText) {
  // 截图按需：不给 WORLD_BROWSER_SHOTS_DIR 就只做几何断言，免得每次跑全量都往仓库里堆图
  const shots = process.env.WORLD_BROWSER_SHOTS_DIR
  if (shots) await mkdir(shots, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.setContent(HOST_HTML)
    await page.addStyleTag({ content: `
      :root { --dsw-alias-bg-base: rgb(255, 255, 255); --dsw-alias-bg-layer-1: rgb(247, 249, 253);
        --dsw-alias-bg-layer-2: rgb(241, 243, 245); --dsw-alias-bg-layer-3: rgb(230, 234, 240);
        --dsw-alias-label-primary: rgb(23, 35, 60); --dsw-alias-label-secondary: rgb(100, 110, 130);
        --dsw-alias-label-tertiary: rgb(145, 155, 175); --dsw-alias-border-l2: rgb(225, 230, 238);
        --dsw-alias-interactive-bg-hover: rgb(235, 240, 250); --dsw-alias-interactive-bg-active: rgb(225, 233, 250);
        --dsw-alias-state-business-primary: rgb(59, 110, 246); }
      body[data-ds-dark-theme] { --dsw-alias-bg-base: rgb(21, 21, 23); --dsw-alias-bg-layer-1: rgb(30, 32, 36);
        --dsw-alias-bg-layer-2: rgb(39, 42, 48); --dsw-alias-bg-layer-3: rgb(48, 52, 60);
        --dsw-alias-label-primary: rgb(249, 250, 251); --dsw-alias-label-secondary: rgb(190, 196, 205);
        --dsw-alias-label-tertiary: rgb(140, 148, 160); --dsw-alias-border-l2: rgb(65, 70, 80);
        --dsw-alias-interactive-bg-hover: rgb(50, 55, 65); --dsw-alias-interactive-bg-active: rgb(60, 65, 75);
        --dsw-alias-state-business-primary: rgb(90, 130, 255); }
    ` })
    await page.evaluate(installBrowserProbe)
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    // 默认已安装：桌面图标与开始菜单卡片都在，不需要先「安装」
    assert.equal(await page.locator('[data-world-browser-icon]').count(), 1)
    assert.equal(await page.locator('[data-world-app-card="browser"]').count(), 1)
    await page.locator('[data-world-browser-icon]').dblclick()
    await page.waitForSelector('.world-browser-window')
    assert.equal(await page.locator('.world-browser-window').getAttribute('data-world-browser-mode'), 'webview')
    assert.equal(await page.locator('[data-world-taskbar="browser"] .world-taskbar-app-name').innerText(), '浏览器',
      '任务栏不暴露页面标题/URL，避免带进模型上下文')

    const box = await page.locator('.world-browser-window').boundingBox()
    assert.deepEqual(
      { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      { x: 128, y: 76, width: 1024, height: 640 }, '默认 80vw×80vh / 最小 720×480',
    )
    const metrics = await page.evaluate(() => {
      const pixels = value => Math.round(value * 10) / 10
      const query = selector => document.querySelector(selector)
      const height = selector => pixels(query(selector).getBoundingClientRect().height)
      const address = query('.world-browser-address')
      const addressStyle = getComputedStyle(address)
      const windowStyle = getComputedStyle(query('.world-browser-window'))
      const activeTabStyle = getComputedStyle(query('.world-browser-tab.on'))
      return {
        titlebar: height('.world-vscode-titlebar'),
        tabs: height('.world-browser-tabs'),
        toolbar: height('.world-browser-toolbar'),
        address: pixels(address.getBoundingClientRect().height),
        addressRadius: addressStyle.borderRadius,
        addressFont: addressStyle.fontSize,
        addressBackground: addressStyle.backgroundColor,
        tabTopBorder: `${activeTabStyle.borderTopWidth} ${activeTabStyle.borderTopColor}`,
        windowRadius: windowStyle.borderRadius,
        windowBorder: windowStyle.borderTopColor,
      }
    })
    assert.deepEqual(metrics, {
      titlebar: 32, tabs: 36, toolbar: 40, address: 26,
      addressRadius: '13px', addressFont: '12px', addressBackground: 'rgb(241, 243, 245)',
      tabTopBorder: '2px rgb(59, 110, 246)', windowRadius: '8px', windowBorder: 'rgb(225, 230, 238)',
    })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
    const darkChrome = await page.evaluate(() => ({
      address: getComputedStyle(document.querySelector('.world-browser-address')).backgroundColor,
      accent: getComputedStyle(document.querySelector('.world-browser-tab.on')).borderTopColor,
      border: getComputedStyle(document.querySelector('.world-browser-window')).borderTopColor,
    }))
    assert.deepEqual(darkChrome, { address: 'rgb(39, 42, 48)', accent: 'rgb(90, 130, 255)', border: 'rgb(65, 70, 80)' })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'light')
    assert.equal(await page.locator('[data-world-browser-home]').count(), 1)
    if (shots) await page.screenshot({ path: join(shots, 'browser-home.png'), animations: 'disabled' })

    // 地址栏补 https、创建一个 lease、guest 属性逐字节对齐主进程校验
    const addressInput = page.locator('[data-world-browser-address]')
    await addressInput.fill('example.com')
    await addressInput.press('Enter')
    await page.waitForFunction(() => window.__worldBrowserProbe.acquired.length === 1)
    assert.equal(await addressInput.inputValue(), 'https://example.com/')
    const guest = page.locator('.world-browser-viewport [data-world-fake-webview]')
    assert.equal(await guest.count(), 1)
    // 首次导航发生在 guest 的 dom-ready（模拟元素用 0ms 定时器派发），别和它抢跑。
    await page.waitForFunction(() => document.querySelector('.world-browser-viewport [data-world-fake-webview]')
      ?.getAttribute('data-load-url') === 'https://example.com/')
    assert.equal(await guest.getAttribute('src'), 'about:blank#lease-1')
    assert.equal(await guest.getAttribute('name'), 'lease-1')
    assert.equal(await guest.getAttribute('partition'), 'persist:world-test-lease-1')
    assert.equal(await guest.getAttribute('data-sidebar-browser-frame'), 'webview')
    assert.equal(await guest.getAttribute('allowpopups'), '')
    assert.equal(await guest.getAttribute('data-load-url'), 'https://example.com/')
    assert.deepEqual(await page.evaluate(() => window.__worldBrowserProbe.acquired[0].workspace), 'world:desktop-browser')
    if (shots) await page.screenshot({ path: join(shots, 'browser-page.png'), animations: 'disabled' })

    // A main-frame failure must survive the stop-loading and title events that follow it.
    await guest.evaluate(element => {
      const failed = new Event('did-fail-load')
      Object.assign(failed, { isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED' })
      element.dispatchEvent(failed)
      element.dispatchEvent(new Event('did-stop-loading'))
      element.dispatchEvent(new Event('page-title-updated'))
    })
    const loadError = page.locator('[data-world-browser-error]')
    assert.equal(await loadError.count(), 1, 'a failed page retains its error after loading stops')
    assert.match(await loadError.innerText(), /ERR_NAME_NOT_RESOLVED/)
    assert.equal(await guest.evaluate(node => getComputedStyle(node).visibility), 'hidden',
      'the native guest must not cover the error page')
    assert.equal(await page.locator('.world-browser-progress').evaluate(node => node.classList.contains('on')), false)
    if (shots) await page.screenshot({ path: join(shots, 'browser-load-error.png'), animations: 'disabled' })
    await loadError.getByRole('button', { name: '重试', exact: true }).click()
    await loadError.waitFor({ state: 'detached' })
    assert.equal(await guest.evaluate(node => getComputedStyle(node).visibility), 'visible')
    assert.equal(await page.evaluate(() => window.__worldBrowserProbe.acquired.length), 1,
      'retry reuses the existing tab and guest lease')
    if (shots) await page.screenshot({ path: join(shots, 'browser-load-recovered.png'), animations: 'disabled' })
    // Subframe failures and an aborted navigation must not replace the main page with an error.
    await guest.evaluate(element => {
      for (const flags of [{ isMainFrame: false, errorCode: -105 }, { isMainFrame: true, errorCode: -3 }]) {
        const failed = new Event('did-fail-load')
        Object.assign(failed, flags)
        element.dispatchEvent(failed)
      }
    })
    assert.equal(await loadError.count(), 0)

    // 新标签是起始页，不申请 lease；切标签只改 visibility，不重建 DOM
    await page.locator('[data-world-browser-add]').click()
    assert.equal(await page.locator('.world-browser-tab').count(), 2)
    assert.equal(await page.locator('.world-browser-viewport').count(), 2)
    assert.equal(await page.evaluate(() => window.__worldBrowserProbe.acquired.length), 1)
    await addressInput.fill('https://example.org/')
    await addressInput.press('Enter')
    await page.waitForFunction(() => window.__worldBrowserProbe.acquired.length === 2)
    const firstGuest = await page.locator('[data-world-browser-tab="tab1"]').getAttribute('data-world-browser-tab')
    assert.equal(firstGuest, 'tab1')
    await page.locator('[data-world-browser-tab="tab1"]').click()
    assert.equal(await page.locator('.world-browser-viewport').count(), 2)
    assert.equal(await page.evaluate(() => window.__worldBrowserProbe.acquired.length), 2)
    assert.deepEqual(await page.locator('.world-browser-viewport').evaluateAll(nodes => nodes.map(node => ({
      hidden: node.style.visibility === 'hidden', guests: node.querySelectorAll('[data-world-fake-webview]').length,
    }))), [
      { hidden: false, guests: 1 }, { hidden: true, guests: 1 },
    ])
    if (shots) await page.screenshot({ path: join(shots, 'browser-tabs.png'), animations: 'disabled' })

    // target=_blank 通过 onOpenRequested 回传 → 在本窗口开新标签
    await page.evaluate(() => window.__worldBrowserProbe.listeners.get('lease-1')('https://example.net/'))
    await page.waitForFunction(() => document.querySelectorAll('.world-browser-tab').length === 3)
    await page.waitForFunction(() => window.__worldBrowserProbe.acquired.length === 3)
    // 地址栏跟着活动标签走，但输入框是受控组件 + effect 同步，可能晚一帧；
    // 这里等值到位再断言，不去赌那一帧（赌赢了也只是偶然）。
    await page.waitForFunction(() => document.querySelector('[data-world-browser-address]')?.value === 'https://example.net/',
      null, { timeout: 3000 })
    assert.equal(await addressInput.inputValue(), 'https://example.net/')

    // 关标签释放 lease，且只释放一次
    await page.locator('.world-browser-tab-close').last().click()
    await page.waitForFunction(() => window.__worldBrowserProbe.released.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__worldBrowserProbe.released), ['lease-3'])

    // 标签上限 8：触顶后 + 置灰，不静默丢页
    for (let i = 0; i < 6; i += 1) await page.locator('[data-world-browser-add]').click()
    assert.equal(await page.locator('.world-browser-tab').count(), 8)
    assert.equal(await page.locator('[data-world-browser-add]').isDisabled(), true)

    // 逃逸口：window.open 交给系统浏览器
    await page.locator('[data-world-browser-tab="tab1"]').click()
    await page.locator('.world-browser-cap[title="在系统浏览器打开"]').click()
    assert.deepEqual(await page.evaluate(() => window.__worldBrowserProbe.opened), ['https://example.com/'])

    // 最小化用 visibility 而非 display:none，guest 视口不塌成 0
    await page.locator('.world-browser-cap[title="最小化"]').click()
    // .is-min 的 visibility 延后 140ms 才生效（与桌面其它窗口同一套淡出动画）
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.world-browser-window')).visibility === 'hidden')
    const minimized = await page.evaluate(() => {
      const element = document.querySelector('.world-browser-window')
      const style = getComputedStyle(element)
      const viewport = document.querySelector('.world-browser-viewport')
      return { min: element.classList.contains('is-min'), display: style.display,
        visibility: style.visibility, viewportWidth: Math.round(viewport.getBoundingClientRect().width) }
    })
    // 1024 外框 → 内容区 1022，再被 .is-min 的 scale(.96) 量成 981；关键是 guest 视口没塌成 0
    assert.equal(minimized.min, true)
    assert.equal(minimized.display, 'flex')
    assert.equal(minimized.visibility, 'hidden')
    assert.ok(minimized.viewportWidth > 900, `最小化后 guest 视口宽度 ${minimized.viewportWidth} 不应塌成 0`)
    await page.locator('[data-world-taskbar="browser"]').click()
    assert.equal(await page.locator('.world-browser-window').evaluate(element => element.classList.contains('is-min')), false)

    // 关窗：所有 lease 恰好归还一次，DOM 全部消失
    await page.locator('.world-browser-close').click()
    await page.waitForFunction(() => document.querySelectorAll('.world-browser-window').length === 0)
    const leases = await page.evaluate(() => ({
      acquired: window.__worldBrowserProbe.acquired.map(item => item.lease),
      released: window.__worldBrowserProbe.released,
    }))
    assert.deepEqual(leases.released.slice().sort(), leases.acquired.slice().sort())
    assert.equal(new Set(leases.released).size, leases.released.length, '每个 lease 只能释放一次')
    assert.equal(await page.locator('.world-browser-viewport').count(), 0)
    assert.deepEqual(errors, [], '不能出现未捕获异常')

    await checkBrowserCrashRecovery(browser, bundleText, shots)

    console.log(`Browser window passed: 1024×640 @128,76; titlebar 32 / tabs 36 / toolbar 40 / address 26 r13;`
      + ` ${leases.acquired.length} leases acquired & released; 8-tab limit`
      + (shots ? `; PNG → ${shots}` : '; 截图已关闭（设 WORLD_BROWSER_SHOTS_DIR 可开启）'))
  } finally {
    await page.close()
  }
}

/** A dead renderer must stay stopped until the user explicitly retries. */
async function checkBrowserCrashRecovery(browser, bundleText, shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.setContent(HOST_HTML)
    await page.evaluate(installBrowserProbe)
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    await page.locator('[data-world-browser-icon]').dblclick()
    const input = page.locator('[data-world-browser-address]')
    await input.fill('https://example.com/')
    await input.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-world-fake-webview]')?.dataset.loadUrl === 'https://example.com/')

    await page.locator('[data-world-fake-webview]').evaluate(element => element.dispatchEvent(new Event('render-process-gone')))
    await page.waitForFunction(() => window.__worldBrowserProbe.released.includes('lease-1'))
    // Wait for the React effect and any attempted automatic mount to settle.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const failure = page.locator('[data-world-browser-error]')
    assert.equal(await failure.count(), 1, 'renderer exit keeps an actionable error visible')
    assert.match(await failure.innerText(), /GONE/)
    assert.equal(await page.locator('[data-world-fake-webview]').count(), 0,
      'a renderer exit does not automatically create a replacement guest')
    assert.equal(await page.evaluate(() => window.__worldBrowserProbe.acquired.length), 1,
      'no replacement lease is requested before retry')
    assert.equal(await page.locator('.world-browser-tab').count(), 1)
    assert.equal(await input.inputValue(), 'https://example.com/')
    if (shots) await page.screenshot({ path: join(shots, 'browser-renderer-stopped.png'), animations: 'disabled' })

    await failure.getByRole('button', { name: '重试', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-fake-webview]')?.dataset.loadUrl === 'https://example.com/')
    assert.equal(await failure.count(), 0)
    assert.equal(await page.locator('.world-browser-tab').count(), 1, 'retry preserves the original tab')
    assert.equal(await page.evaluate(() => window.__worldBrowserProbe.acquired.length), 2,
      'an explicit retry acquires one replacement lease')
    assert.equal(await page.locator('[data-world-fake-webview]').getAttribute('name'), 'lease-2')
    if (shots) await page.screenshot({ path: join(shots, 'browser-renderer-recovered.png'), animations: 'disabled' })
    await page.locator('.world-browser-close').click()
    await page.waitForFunction(() => window.__worldBrowserProbe.released.includes('lease-2'))
    assert.deepEqual(await page.evaluate(() => window.__worldBrowserProbe.released), ['lease-1', 'lease-2'])
    assert.deepEqual(errors, [])
    console.log('Browser renderer recovery passed: 0 automatic replacements, 1 explicit retry, original tab retained, both leases released once.')
  } finally {
    await page.close()
  }
}
