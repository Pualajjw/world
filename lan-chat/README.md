# 局域网聊天 · world 内置小应用

同一局域网里，装了 world 插件的 dsh 之间自动互相发现，直接私聊、建群聊。不需要账号、不需要中心服务器。

> 已正式内置进 world（`0.2.7`）：启动 dsh 后由 `world/index.js` 自动拉起服务，开始菜单「应用 → 局域网聊天」安装并打开即可。本目录同时保留独立模式（`start.cmd`），不开 dsh 也能直接体验。

## 一、先看界面（不用装任何东西）

双击 [`prototype.html`](./prototype.html)。它是自包含的可点原型：world 壁纸 + 应用窗口，预置了 2 个群聊、3 个私聊和 4 台设备，可以切会话、发消息、建群、改昵称、切深浅主题、最小化/最大化窗口。
界面规格见 [`DESIGN.md`](./DESIGN.md)。

界面源码只有一份 `app.html` + `app.css` + `app.js`，原型由 `node build-prototype.mjs` 内联生成；真实运行时由服务直接托管 `app.html`，所以**原型和成品是同一套界面**。

## 二、立即用起来（独立模式，推荐先试这个）

Windows 双击 `start.cmd`，或命令行：

```shell
cd world/lan-chat
node server.mjs
```

浏览器打开 `http://127.0.0.1:53317/`（`start.cmd` 会自动打开）。把同一网段里另一台机器也跑起来，几秒后「通讯录」和右栏「局域网发现」里就会自动出现对方，显示机器名、IP 和它装的 `@local/dsh-world` 版本。

| 项 | 值 |
| --- | --- |
| HTTP / 页面 / API | `53317`（被占用则自动顺延到 53318…53327） |
| UDP 发现 | `53318`，每 3 秒广播一次，11 秒无心跳标记离线 |
| 广播目标 | `255.255.255.255` + 每块网卡的子网广播地址 |
| 防火墙 | 首次运行请放行 node.exe 的 UDP 53318 / TCP 53317；Windows 弹窗点「允许访问」 |
| 环境变量 | `LAN_CHAT_PORT`、`LAN_CHAT_DISCOVERY_PORT`、`LAN_CHAT_OPEN=1` 自动开浏览器、`LAN_CHAT_NODE` 指定 node 路径 |

没有 node 也可以把 `LAN_CHAT_NODE` 指向 dsh 自带 runtime 里的 `node.exe`。

## 三、内置到 world 桌面

`world` 插件本体已接入，不需要再安装第二个插件：

- `world/index.js` 在 Host 侧启动本目录的 `server.mjs`，并注册 `world-lan-chat/port` RPC；
- `world/lan-chat-app.js` 是内置应用窗口组件，`world/client-src.js` 把它接进开始菜单「应用」分组、桌面图标、任务栏与窗口状态机；
- 安装 world（`0.2.7`，需重启 dsh）后：**开始 → 应用 → 局域网聊天 → 安装**，桌面出现图标，双击即可打开。窗口支持拖动标题栏、8 边缩放、最小化 / 最大化 / 关闭，位置尺寸记在浏览器本地。
- 窗口内容通过 iframe 指向本机聊天服务（`http://127.0.0.1:<port>/`），界面与独立模式、原型完全一致。服务端口由 RPC 查询，端口被占用时自动顺延。
- `world/package.json` 的 `files` 已包含 `lan-chat/` 与 `lan-chat-app.js`，`package.mjs` 打出的 tgz 会随包分发。

> 内置服务与独立模式共用 53317 端口；两者同时启动时后者会自动顺延端口并在控制台打印实际地址，不会冲突。卸载应用只移除桌面图标与入口，Host 侧的发现服务仍随 world 运行（这样别的机器仍然能发现你）。

## 四、功能

| 能力 | 说明 |
| --- | --- |
| 自动发现 | UDP 广播携带 id、昵称、机器名、IP、HTTP 端口和 world 插件版本；新邻居立即回包，不用等下一个周期。另有本机邻近端口探测作为补充通道，同一台机器开多个 dsh / 独立服务、或广播被交换机拦截时也能互相看到 |
| 私聊 | 通讯录点一下即建会话；消息点对点 POST 到对方 `/api/receive` |
| 群聊 | 勾选在线设备或模型好友建群，群定义与邀请同步给成员；模型好友默认不加入大厅或群聊，须显式邀请；群主可配置其他成员是否能 @ 已邀请模型（默认关闭） |
| 在线状态 | 绿点 / 离线分组、在线人数胶囊、右栏雷达扫描动画 |
| 会话体验 | 未读徽标、最后一条预览、搜索（`/` 聚焦）、日期分隔、系统消息、@ 高亮、表情与快捷语（统一的线性图标工具条）、Enter 发送；同一人 5 分钟内的连续发言合并成一串（藏重复头像、只留最后一条的气泡尾巴） |
| Markdown | 消息气泡渲染标题、**加粗**、*斜体*、`行内代码`、代码块（带语言标签与一键复制）、有序 / 无序列表、引用、表格、分隔线、http(s) 链接；**先转义再拼 HTML**，HTML 标签与 `javascript:` 链接一律当纯文本 |
| 长会话 | 只渲染最近 60 条，顶部「载入更早的 60 条」按距底距离翻页不跳屏；消息 HTML 按 id 缓存，纯在线状态推送不重建消息 DOM |
| 本机模型好友 | dsh 里配置的每个模型都是通讯录「本机模型」分组里的一位好友；点开即私聊，直接发消息就能让它干活；每个模型绑定一个真实 dsh 会话，上下文由 dsh 维护 |
| 会话绑定 | 模型私聊右栏「dsh 会话」卡片：新建会话（换干净上下文）/ 绑定已有 / 解绑；未绑定的模型第一次派活时自动新建 |
| 记录另存 | 会话、消息、绑定关系写进 `<home>/lan-chat/state.json`，与 dsh 会话互不依赖，重启后接着看 |
| @ 派活 | 输入框 `@` 面板列出群内已邀请的模型与会话成员，插入 `@名字 ` 后写任务；也支持手打 `@provider/model` / `@模型id`；模型所在设备用户可直接派活，其他群成员需群主开启权限；思考中提示、失败落系统消息 |
| 自动重试 | 一轮 turn 失败默认再试一次（指数退避 + 抖动）；连接重置、5xx、429、超时、空回复重试，鉴权 / 额度这类「再试也没用」的错误直接报错；单轮上限 300 秒，超时取消该会话的 turn |
| 个性化 | 昵称（广播给其它设备）、跟随 dsh 外观的浅色 / 深色主题、群公告、成员信息卡 |
| 细节规矩 | 三档明暗层级（凹槽 / 应用面 / 浮起）保证深色下「选中 = 浮起」而不挖洞；输入为空时发送键禁用；滚到底自动跟随、往上翻不抢滚动位置；键盘焦点才画描边；`prefers-reduced-motion` 下关掉动画 |
| 实时 | `/api/events` SSE 推送状态快照，发现设备 / 收到消息 / 建群 / 模型回复都会即时刷新 |

## 五、接口与安全

| 接口 | 用途 |
| --- | --- |
| `GET /api/state` | 完整状态（我 / 设备 / 模型好友 `bots`（含各自绑定的 `sessionId`）/ 思考中 `pending` / 重试 `retrying` / 会话 / 消息），并顺带刷新模型目录 |
| `GET /api/bots/sessions` | 列出 dsh 里已有的会话，给「绑定已有」用（带 `botId` 表示已被哪个模型占用） |
| `POST /api/bind` | 把模型绑定到某个 dsh 会话；`sessionId` 为空表示解绑 |
| `POST /api/context/reset` | 给模型换一个全新的 dsh 会话（= 清空上下文，聊天记录不删） |
| `GET /api/events` | SSE 状态流 |
| `GET /api/ping` | 健康检查 |
| `POST /api/profile` | 改昵称 |
| `POST /api/read` | 清未读 |
| `POST /api/send` | 发消息并转发给目标设备；本地消息里 @ 到模型时，把这句话 prompt 进它绑定的 dsh 会话 |
| `POST /api/conversations` | 建私聊 / 群聊（`peerId` 可以是设备 id，也可以是 `bot:provider/model`） |
| `POST /api/group/settings` | 群主邀请本机模型好友，并同步是否允许其他群成员 @ 已邀请模型 |
| `POST /api/receive` | 接收其它设备转发来的消息、建群邀请 |

- 只接受回环 / 私有网段来源的写请求，拒绝公网地址；请求体上限 64 KB，单条消息 2000 字；
- 会话、消息、模型绑定防抖写入 `<home>/lan-chat/state.json`（原子写，停服前 flush），重启后恢复；身份 id 与昵称存在 `<home>/lan-chat/identity.json`；
- 所有流量只在局域网内点对点传输，不经过任何外部服务器；首版不加密、不鉴权，仅适合可信局域网。

## 六、本机模型好友

dsh 里配置的每个模型都成为通讯录独立分组里的「本机好友」，但默认不加入局域网大厅或任何群聊。点开模型私聊可直接发消息；在建群时邀请模型，或从群聊右栏「管理模型与 @ 权限」拉模型入群后，群成员才可以在 `@` 面板里看到它。群主可开启「允许其他群成员 @ 已邀请的模型好友」，默认关闭；模型所在设备的用户始终可以派活。一次可 @ 多个已邀请模型，各自回一条；思考期间工具条显示「🤖 X 正在思考…」。

- **上下文交给真实 dsh 会话**：每个模型绑定一个 dsh 会话。`/api/send` 只负责把消息写进聊天记录，然后调桥接的 `ask()` → `sessionController.prompt()`；回复从 `session/event` 事件流里收（认领自己那一轮的 `turn/start`，收集 `assistant/message`，等 `turn/end`）。**不自己拼 history**，上下文、压缩、落盘都由 dsh 负责。
- **可以换会话**：模型私聊右栏的「dsh 会话」卡片提供「新建会话」（`POST /api/context/reset`，换一个干净上下文）、「绑定已有」（`POST /api/bind` + `GET /api/bots/sessions` 列出现成会话）、「解绑」。未绑定过的模型在第一次派活时自动新建，工作目录 `<home>/lan-chat/workspace`。
- **聊天记录另外保存**：`store.mjs` 把会话 / 消息 / 绑定关系防抖写进 `<home>/lan-chat/state.json`（停服前 flush），和 dsh 会话互相独立。换会话或删会话都不影响聊天记录，重启后接着看。
- **模型能查聊天记录**：`lan-chat-tool.js` 注册两个只读工具 —— `lan_chat_conversations`（所有聊天窗口 + 条数）和 `lan_chat_history`（按会话 / 关键词 / 最近 N 小时查消息，按时间倒序）。
- **自动重试**：一轮 turn 失败默认再试一次（`attempts: 2`），按「值不值得再试」分类：`ETIMEDOUT / ECONNRESET / EPIPE / fetch failed`、`408/425/429/5xx`、超时、空回复 → 重试；鉴权失败、模型不存在、余额 / 配额不足 → 立刻失败。单轮上限 300 秒，超时用 `sessionController.cancel()` 取消该会话的 turn。重试期间输入框上方显示「第 2/2 次重试」。
- **工具审批**：本插件新建的会话里，工具审批自动放行一次（不落持久授权）；手动绑定进来的会话仍走 dsh 客户端原本的审批流程，可能需要你去 dsh 里点一下。
- **本机私有**：模型回复只落在本机的会话里，不转发到局域网其它设备；其他成员的 @ 由模型所在设备按群权限设置处理。
- **群聊权限**：模型成员和「允许其他成员 @」开关跟群定义同步并持久化；收消息时模型所在设备仍会检查模型是否已被邀请，以及其他成员 @ 的开关。
- **独立模式**：`start.cmd` 没有宿主，`models` 桥接为空 → 通讯录不显示模型好友，其余聊天功能照常（聊天记录照常保存）。
- **安全边界不变**：`/api/send` 仍只接受回环 / 私有网段、单条 2000 字；模型回复同样经 `cleanText` 截断，不会把超长输出塞进会话。

## 七、文件清单（本目录）

| 文件 | 作用 |
| --- | --- |
| `prototype.html` | 自包含界面设计稿 / 可点 demo |
| `DESIGN.md` | 界面设计规格（布局、尺寸、配色、交互、动效） |
| `app.html` / `app.css` / `app.js` | 唯一一份界面源码，demo 与 live 共用 |
| `markdown.js` | 消息用的轻量 Markdown 渲染器（无依赖、先转义后拼标签）；浏览器挂 `window.LanChatMarkdown`，单测直接 import |
| `build-prototype.mjs` | 由上面几份源码生成 `prototype.html` |
| `server.mjs` | UDP 发现 + HTTP API + SSE + 静态托管，零第三方依赖 |
| `start.cmd` | Windows 一键启动独立模式 |
| `../model-friends.js` | Host 侧桥接：枚举配置模型、建 / 列 dsh 会话、`prompt` 进会话并从事件流收回复（不拼 history） |
| `../lan-chat-tool.js` | 给 dsh 会话的两个只读工具：`lan_chat_conversations` / `lan_chat_history` |
| `store.mjs` | 聊天记录落盘（防抖 + 原子写 + 停服 flush） |
| `../index.js` / `../lan-chat-app.js` / `../client-src.js` | world 本体接入点：Host 服务与端口 RPC、内置窗口组件（标题栏模型好友徽标）、桌面状态机 |
| `preview-light.png` / `preview-dark.png` | 界面设计静态预览（浅色 / 深色实测截图） |
| `preview-model-friends.png` | 「本机模型好友」界面自检截图（通讯录分组、私聊头、@ 派活与回复） |
| `preview-retry.png` | 自动重试状态自检截图（输入框上方「重试 2/3」） |
| `preview-markdown.png` | Markdown 渲染 + 长会话窗口自检截图 |
| `preview-session-bind.png` | dsh 会话绑定卡片与「绑定已有」弹层自检截图 |
| `README.md` | 本说明 |
