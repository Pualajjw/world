# 内置浏览器

[返回 README](../README.md) · [功能总览](../README.md#功能)

不用 iframe，复用 DSH 主进程已有的受控 webview 租约，所以能打开真正的公网站点；桥不可用时退回 sandbox iframe，并在顶部说明限制。

## 多标签与三档后端

开始菜单「应用」分组里的第三个内置应用，**默认已安装、允许卸载**（像 Win11 自带 Edge）；旧配置在首次读取时自动补装一次，卸载后不会偷偷装回来。双击桌面图标打开一个可拖动、8 边缩放、可最小化/最大化的窗口，内含标签栏与地址栏。

- **能打开真正的公网站点**：不用 iframe，而是复用 dsh 主进程已有的受控 `<webview>` guest 租约（`globalThis.dshDesktop.browser` 的 `acquire / release / onOpenRequested`）。一个标签 = 一个 lease，切标签只改 `visibility`、不销毁 DOM；`target=_blank` 被主进程拦下后回传，在本窗口开新标签。**不改 dsh 源码、不加 Host RPC、不加依赖**。
- **三档后端**：Electron 桌面且桥可用 → webview；Web profile / 桥缺失 / `acquire` 失败 → sandbox iframe（顶部常驻兼容模式提示）；再不行则空态。iframe 模式下多数站点仍会因 `X-Frame-Options` 白屏，跨域导航后地址栏进入「未知」态、前进后退不可用。
- **地址栏**：`example.com` 自动补 `https://`；只放行 http/https，拒绝内嵌凭据、超长地址、DSH 自身 origin；`file:` / `javascript:` / `data:` 一律拒绝，页面内跳转同样受主进程白名单约束。带「后退 / 前进 / 刷新 / 起始页 / 在系统浏览器打开」五个键。
- **起始页搜索（`0.2.115`）**：新标签页的输入框不再只认网址——输入中文句子、带空格的短语或单个词（不是网址）时，直接打开 `https://so.qq.com/isearch?query=<URL 编码后的内容>`。`example.com`、`localhost:3000`、`127.0.0.1`、显式写出的 `http/https` 等仍按原规则补 https 后打开。地址栏本身不套这条回退，仍严格走白名单。
- **失败与重试**：网页主文档加载失败时保留错误原因和「重试」入口，后续加载结束或标题变化不会清掉提示；错误页显示时隐藏网页容器，避免遮挡提示。重试成功后恢复原标签和容器，不额外申请租约；子框架失败和中止的导航不替换主页面。
- **网页进程退出**：保留原标签、网址和重试入口，释放已退出的网页容器，等待手动重试；不会在后台自动反复重建。点击重试后只创建一个替代容器。
- **完整显示**：原生网页容器使用 flex 布局，让内部页面实际视口随内容区填满。`0.2.42` 修复了外框高 530px、内部网页却只有默认 150px 高的问题；长页可正常滚到底部，宽页可横向滚动，最大化和还原会同步网页尺寸。
- **隐私**：不读页面正文、不注入脚本、不代理流量；独立 partition `world:desktop-browser`，不与侧栏浏览器共享登录态；标签 URL / 标题不进 `desktopState`（任务栏只显示「浏览器」）；内置浏览器没有向固定助手提供导航或读取当前网址的工具。
- **上限**：单窗口 8 个标签（P1 单窗口，多窗口 3 个留到 P2）；触顶时 `+` 置灰，不静默丢页。窗口几何存 `localStorage['dsh.world.browser.window']`。
- **已知限制**（来自主进程策略，不是待修 bug）：**不支持下载**、摄像头/麦克风/定位/通知、`alert/confirm/prompt`、HTTP Basic 登录、原生新窗口；Cookie / Web storage 在 dsh 重启后清空；打不开 DSH 自身服务端口；主窗口重载会销毁所有 guest，页面内未提交的输入不恢复。受限时统一用地址栏右侧「在系统浏览器打开」。`Ctrl+L/T/W` 可能被宿主快捷键系统接走，P1 不注册全局快捷键，全部操作走工具栏。
- **原生验证**：独立 Electron 44.7.0 测试窗口已验证真实网页的内容区尺寸、横纵滚动、最大化/还原、重定向和禁止 iframe 嵌入的页面；窗口圆角裁切、完整 DSH 环境下的层级/拖窗/快捷键归属仍按 [`BROWSER-DESIGN.md`](../BROWSER-DESIGN.md) §16 验收。
- **自检**：`node --test tests/browser-frame.test.js`（白名单 / 状态机 / lease 恰好释放一次 / 起始页搜索判定）与 `node tests/browser.mjs`（窗口几何与像素、标签切换不重建 DOM、lease 全量归还、最小化不塌尺寸、起始页输入既搜网址也搜内容）。截图按需生成：默认不写盘，需要留档时用 `WORLD_BROWSER_SHOTS_DIR=prototype/shots node tests/browser.mjs`（小机器人姿势图对应 `WORLD_POSE_SHOTS_DIR`）。
- **原生回归**：设置 `WORLD_ELECTRON_BINARY` 为独立 Electron 可执行文件后运行 `npm run test:native`。`WORLD_BROWSER_POLICY` 可指定 DSH 源码中的 `apps/desktop/src/browser-guests.ts`（默认本机 `E:/deepseek-harness`）；`WORLD_NATIVE_SHOTS_DIR` 指定报告与截图目录。测试使用临时配置和本地页面，不接入用户的 Desktop 会话。

## 起始页搜索

- **不是网址就搜索**：新标签页输入「如何处理内容」这类中文句子、带空格的短语或单个词时，不再拼成 `https://如何处理内容` 去碰运气，而是直接打开 `https://so.qq.com/isearch?query=%E5%A6%82%E4%BD%95%E5%A4%84%E7%90%86%E5%86%85%E5%AE%B9`。
- **网址照旧**：`example.com`、`example.com:8080`、`localhost:3000`、`127.0.0.1`、`[::1]:8080`，以及任何显式写出 `http/https` 的输入，仍走原来的「补 https + 白名单」路径；`javascript:` / `file:` 等非法协议也仍会被拒绝并给出原因，不会被当成搜索词吞掉。
- **边界**：只改起始页输入框；地址栏还是严格的白名单（`0.2.115` 不做搜索回退）。
- **自检**：`node --test tests/browser-frame.test.js` 钉住判定与 URL 编码；`node tests/browser.mjs` 在真实浏览器里从起始页提交中文查询，断言地址栏和 guest 的 `load-url` 都是腾讯搜索地址，再验证 `example.com` 仍然直接打开。
