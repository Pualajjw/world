# world 远程桌面 · 方案设计与插件体积预算

> 约束前提：**不能让 world 插件变太大**。本文按「先省体积、再谈能力」排序给方案。
> 依据：只读 dsh 源码（`E:/deepseek-harness`）实测，未写实现代码。配套可行性见 `REMOTE-DESKTOP-FEASIBILITY.md`。

---

## 0. 一句话结论

**满足「小插件」的最优解不是把远程桌面引擎塞进 world，而是按「到底要远程什么」拆开，把重活全部外包：**

- **dsh ↔ dsh 页面协同** → 直接复用 dsh 自带的 **LiveShare**（world 插件增量 ≈ 0 字节）。
- **world ↔ 任意机器（要控 OS 桌面）** → 内嵌 **noVNC/Guacamole（iframe 指 URL，增量 ≈ 2KB）**；被控端靠系统自带 RDP/VNC。
- **只有「必须真·OS 级双向、且不想依赖外部服务器」** 时，才用 **koffi 截屏 + 注入**（代码小、无二进制，但有门槛）。

关键判断：**「远程」到底指哪一层**，决定体积差 3 个数量级。

---

## 1. 先厘清「远程」的三种粒度（这决定一切）

| 粒度 | 含义 | 例子 | 需要的技术 |
| --- | --- | --- | --- |
| **L1 页面协同** | 两个人看/操作**同一个 dsh 网页（含 world 桌面）** | 同事打开我的 world 桌面看我在干啥 | 传页面/DOM，**不传 OS 像素** |
| **L2 虚拟桌面** | 只共享 **world 这个网页桌面**（不含 OS 其它窗口） | 远程看我的 world | 截 world 的 DOM/canvas |
| **L3 OS 桌面** | 看/控**整台 Windows**（任何程序） | 真·远程桌面 / 远程修电脑 | 截 OS 屏幕 + 注入 OS 键鼠 |

> 你说的「桌面可以远程 world」偏 **L2/L3**，「world 远程别的电脑」偏 **L3**。**L3 才是最费体积的**；如果其实只要 L1/L2，体积几乎为零。

---

## 2. 方向 A：别的机器远程进 world（world 作为被控端）

| 方案 | world 插件增量 | 外部依赖 | 能到什么粒度 | 备注 |
| --- | --- | --- | --- | --- |
| **A1 · 复用 LiveShare** | **≈ 0**（菜单里加一个「共享」入口即可） | 需部署 **Liveshare server**（OAuth+库+路由）+ 启用实验 bundle | **L1**（页面协同；可看到 world 桌面） | dsh 自带子系统，安全模型现成；**最省体积** |
| **A2 · world 自渲染 DOM 协同**（rrweb 式） | **~10–40KB**（自写 DOM 镜像 ~10KB，或 rrweb ~30KB gzip） | 无（纯前端 + 本机 Host 转发） | **L2**（只 world 桌面） | 不碰 OS 截屏权限；world↔world 或浏览器 viewer |
| **A3 · OS 截屏 + 键鼠注入** | **~5–20KB 代码**（无二进制） | WAN 需 TURN；截屏要么改 dsh 放行 getDisplayMedia，要么 Host koffi 调 GDI/DXGI | **L3**（整机） | 真远程桌面；**唯一能控 OS 的** |

**A1 细节（重点，因为它几乎零成本）：**
- LiveShare（`packages/experimental/liveshare`）做的事就是「**把一个 Session 分享给外部 viewer，viewer 页 = owner 自己的 Web shell，跑 owner 的全部插件**」。world 是 owner 插件（`shell.overlay` 桌面层）→ **viewer 页面会照样把 world 桌面渲染出来**（推断，需实测确认）。
- 两个方向其实是**同一套机制、角色互换**：A 是我把 Session 共享出去，对方当 viewer；B 是我当 viewer 去看别人共享的页面。
- 安全模型现成：`remote-access` 按 `share-viewer` 主体授权，分 `view`/`write` 两档，可停、可过期、可审计。
- **硬限制（必须知道）：**
  1. 它是 **L1 页面协同，不是 L3 OS 控制**——不给对端 OS 鼠标键盘。
  2. 实验性、opt-in，**必须另外部署一个 Liveshare server**（OAuth provider + 数据库 + 路由），这是真基建成本（但不占 world 体积）。
  3. **Session 维度**：共享的是一个会话，不是「整台机器」；viewer 的会话列表会被裁剪。
  4. **world 的 Host RPC 默认对非 owner 是 403**——`remote-access` README 明确「Exact Connection Fetch routes…refuses them to every non-owner Peer with 403 until each route declares its own access rule」。所以 viewer 能看到 world 界面，但 VSCode/局域网聊天等走 `ctx.connection.fetch` 的功能要 world **逐路由声明访问规则**才能用（少量代码）。
  5. 跨版本必须匹配。

**A2 细节：** world 是个 React 页面，最干净的「只远程 world」就是**镜像 DOM**（MutationObserver → JSON → viewer 重放），或对 world 的渲染容器做 `html2canvas` 快照流。**完全不碰 OS 截屏权限**（绕开 getDisplayMedia 被拒的死结）。代价：DOM 协同对 canvas/video/复杂动画还原差，且只镜像 world 自身，不含 OS 其它窗口。

**A3 细节：** 见第 5 节铁律——截屏/编码/推流的重活要拆开：Host 用 koffi 调 GDI/DXGI 抓帧 → 把帧交给 renderer → renderer 用 **Chromium 内置 WebRTC 编码**（**编解码 0 字节**）→ 推给对端。难点仍是「抓帧从哪来」（getDisplayMedia 被 dsh 拒，见可行性文档 1.5 实测 4）。

---

## 3. 方向 B：world 远程别的电脑（world 作为控制端）

| 方案 | world 插件增量 | 外部依赖 | 能控谁 | 备注 |
| --- | --- | --- | --- | --- |
| **B1 · 内嵌 LiveShare viewer 页** | **≈ 2–5KB**（一个 iframe 窗口，复用局域网聊天窗口壳） | 对方跑 dsh+world 且共享了页面 + Liveshare server | dsh+world 机器（L1） | **最省体积**；只有对方是 dsh 用户才成立 |
| **B2 · 内嵌 noVNC / Guacamole** | **≈ 2KB**（iframe 指 URL）或 **~300KB**（打包 noVNC，不推荐） | 对方跑 VNC/RDP 服务 + 一个 Web 网关（VNC 可直连端口） | **任意机器**（L3） | 控别人电脑的**最省体积**路径；对方要有 VNC/RDP |
| **B3 · 自研 WebRTC viewer + 目标装 agent** | **~5–20KB**（viewer 端） | 目标机装一个 agent（截屏+注入）+ WAN 需 TURN | 任意机器（L3） | 真 P2P；agent 是**独立产物，不算 world 插件**，所以 world 仍小 |

**B1 细节：** 对方把那台机器的 LiveShare viewer 链接给我，我在 world 里开个 iframe 窗口指过去（和局域网聊天 iframe 同一套路）。前提：对方是 dsh+world 用户且主动共享。**两方向共用 LiveShare，role 互换。**

**B2 细节：** 目标机跑 VNC Server（如 TightVNC）或开 Windows RDP；world 里 iframe 指向 **noVNC**（`http://目标:6080/vnc.html`）或 Guacamole 网关。**noVNC 优先从 URL 加载，不打包**——world 只多一个窗口定义。对方有 VNC/RDP 就行，与是否用 dsh 无关。

**B3 细节：** world 只当「瘦 viewer」（收 WebRTC 流、发键鼠事件）；**截屏+注入的重活放在目标机的独立 agent**（可复用 dsh 的 koffi 思路，或一个几十 KB 的小程序）。因为是独立产物，不撑大 world 插件。代价：要分发/安装 agent。

---

## 4. 「小插件」六条铁律（守体积）

1. **不打包编解码器/媒体引擎**：视频编码用 **Chromium 内置 WebRTC**（H.264 硬编，0 字节）。dsh 里没有现成 WebRTC 基建（只有个纯音频的语音输入实验包），所以**别自己写，直接用浏览器能力**。
2. **不打包中继服务器**：TURN/WAN 中继放外部；dsh↔dsh 场景直接蹭 **Liveshare server**。
3. **不打包完整 VNC/RDP 客户端**：noVNC/Guacamole 一律 **iframe 指 URL**，不塞进 tgz。
4. **不打包原生二进制**：Windows 输入注入用 **koffi**（dsh 的 desktop-host 已带 koffi 3.1.1，0 新增）；截屏优先走 koffi GDI/DXGI，而不是 ffmpeg。
5. **world 保持「瘦壳」**：新应用 = 一个窗口 + iframe/薄 UI（局域网聊天就是模板），逻辑在 Host 服务或外部产物里。
6. **重活外置**：需要常驻 agent / 中继 / OAuth 的东西，做成**独立产物**（不随 world tgz 分发）。

---

## 5. 体积预算表（world tfz 增量）

| 组件 | 增量 | 依据 |
| --- | --- | --- |
| 复用 LiveShare（A1/B1） | **≈ 0** | LiveShare 是 dsh 独立 bundle（3.3MB 源码但不进 world） |
| world 内 iframe 窗口（B1/B2） | **≈ 2–5KB** | 复用 `lan-chat-app.js` 窗口壳 |
| noVNC（URL 加载，B2） | **0**（若打包则 +~300KB，避免） | 远程 URL |
| DOM 协同（A2） | **~10–40KB** | 自写 ~10KB / rrweb ~30KB gzip |
| koffi 截屏+注入调用（A3/B3） | **~5–20KB 代码** | koffi 已在 dsh，无二进制 |
| WebRTC 信令客户端 | **~3–5KB** | 自写 WS/SSE 客户端 |
| TURN / Liveshare server | **0**（外部） | 服务端产物 |

> **结论：真正会让 world 变大的只有 A2（DOM 协同，几十 KB）和 A3（koffi 截屏注入，十几 KB 代码）。其余方案对 world 体积的影响都在几 KB 量级。**

---

## 6. 推荐组合（按「先省体积」）

**默认（推荐，最省）：**
- **被远程**：启用 LiveShare（A1），world 只加一个「共享本机 world」菜单入口。
- **远程别人**：world 里加一个「远程桌面」窗口，iframe 指 noVNC/Guacamole URL（B2）；若对方也是 dsh 用户，改指其 LiveShare viewer 链接（B1）。
- **world 插件增量：几 KB 级。**

**若「必须是真·OS 级双向、且不想依赖 VNC/外部服务器」：**
- 走 A3/B3：Host 用 koffi 抓帧+注入，renderer 用 WebRTC 推流；目标端用独立 agent。
- **world 增量：~15–25KB 代码，无二进制。** 但仍要解决「截屏源」（getDisplayMedia 被拒 → 改 dsh 或 Host koffi GDI）。

**明确不推荐：**
- 在 world 里自研完整屏幕采集+编码+传输+中继（会引入 ffmpeg/libwebrtc/TURN，插件暴涨，违背约束）。
- 打包 noVNC 进 tgz（~300KB）。

---

## 7. 需要拍板 & 待验证

**拍板：**
1. 「远程」要 **L1 页面协同** 还是 **L3 真·OS 桌面**？（决定选 LiveShare 还是 noVNC/koffi）
2. 能否接受 **依赖外部 Liveshare server**（OAuth+库+路由）？不能则 A1/B1 出局。
3. 目标机器是否**也跑 dsh+world**？是 → B1 最省；否 → B2（noVNC）最省。
4. 被控端要不要像 OS 远程桌面那样**控制任意程序**？要 → 必须 L3，绕不开截屏+注入。

**待实测（仍可不写业务代码）：**
- LiveShare viewer 页面**是否真的渲染出 world 桌面**（推断会，因其跑 owner 全部插件）——需启用实验 bundle + 起一个 Liveshare server 实测。
- world 的 `ctx.connection.fetch` 路由对 `share-viewer` 是否 403（文档说会），确认需补哪些 `access rule`。
- noVNC 页面**是否允许被 iframe 嵌入**（X-Frame-Options）；不允许则改为新窗口打开。
