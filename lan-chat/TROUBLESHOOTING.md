# 局域网聊天：发现失败排查手册

这份文档来自一次真实排查（2026-11，Kylin V10 与 Windows 之间“我能看到它、它看不到我”），把过程和可复用的方法一起留下。

## 先分清两条通道

| 用途 | 协议 | 端口 |
| --- | --- | --- |
| 在线发现（谁在线） | UDP 广播 `hello`，每 3 秒一次，11 秒 TTL | 53318 |
| 消息与在线兜底 | HTTP（点对点） | 53317 起 |

**能看到对方 = 收到了对方的 UDP `hello`。** HTTP/TCP 能通不代表能看见；反过来，能看见也不代表能发消息。

## 本案证据链

现象：机器 A（192.168.1.134）能看到 kylin-pc（192.168.1.12），kylin-pc 看不到 A。

1. A 的 `/api/state` 有 kylin peer；kylin 的 `/api/state` 是 `peers: []`。
2. 从 A 手工向 `192.168.1.12:53318` 发一条合法 `hello` 单播：发送成功，kylin 的 `peers` 仍然为空。
3. `ping` 通，`curl http://192.168.1.12:53317/api/ping` 通 → 路由、网段、TCP 都正常。
4. kylin 上 `ss -lunp | grep 53318` 显示 `dsh-desktop-next` 正常绑定，且只有一个实例 → 不是端口占用。
5. kylin 的 `iptables -S`：
   - 入站 `KSC_IN_PRIVATE_ALLOW` 有 `--dport 53317 -j ACCEPT`，**没有 UDP 53318**；
   - 入站链末尾是 `REJECT --reject-with icmp-host-prohibited`；
   - 出站 `KSC_PRIVATE_OUTPUT` 没有末尾 REJECT，OUTPUT 策略是 `ACCEPT`。

根因：**Kylin 安全中心（ksc-defender）只放行了 TCP 53317；入站 UDP 53318 被 REJECT，出站默认放行。** 所以 kylin 的广播能出来（A 看得到它），A 的广播进不去（它看不到 A）。

修复：在 kylin 放行入站 **UDP 53318**。临时命令：

```bash
sudo iptables -I KSC_IN_PRIVATE_ALLOW 1 -p udp --dport 53318 -j ACCEPT
```

持久做法：**安全中心 → 防火墙 → 自定义规则 → 入站 → UDP 53318 → 允许（本地网络）**。验证方式是 kylin 的 `peers` 里出现 A 的 id，并稳定超过 11 秒。

## 可复用的五步排查法

1. **两边各自读状态**：`/api/state` 的 `peers` 是真相；`online` 由最近 11 秒内是否收到 `hello` 决定。
2. **手工造一条合法包**：从一侧向另一侧的 53318 发 `hello` 单播，观察对方 `peers` 是否变化。这一步能区分“我没发出去”还是“对方收不到”。
3. **验证基础网络**：`ping` + `curl http://对端:53317/api/ping`。TCP 通说明 IP/路由/网段没问题。
4. **看监听**：`ss -lunp` / `netstat -ano` 查 53318 是否绑定、是否多个实例。
5. **看防火墙方向性**：入站白名单 + 末尾 REJECT、出站默认 ACCEPT 是“单向可见”的典型特征；只放行消息端口（TCP）而漏掉发现端口（UDP）很常见。
6. **修完复验**：对方 `peers` 里出现自己的 id，并稳定在线超过 TTL（11 秒）。

## 从 0.2.66 起程序自带诊断

- `GET /api/diagnostics`：本机 IP/端口、UDP 是否绑定、最近一次收发时间、HTTP 在线通知成功/失败次数、被忽略的包计数、对端列表和警告。
- `/api/state` 里新增精简的 `network`：发现端口、是否绑定、最近收到广播时间、在线数、警告。
- 聊天窗口「局域网发现」卡片底部显示 UDP 状态、最近收到广播的时间和排查提示，并带「复制诊断」按钮。
- **HTTP 在线兜底**：发现新设备时，除了 UDP 回包，还会 POST `/api/presence`；之后每 6 秒向已认识设备重推一次。即使一端的 UDP 入站被防火墙拦截，只要对端 TCP 53317 可达，也能看到“我在”。需要双方都升级到 0.2.66+。

## 常用命令

Windows（PowerShell，管理员）：

```powershell
Get-NetConnectionProfile
netstat -ano | findstr 53318
New-NetFirewallRule -DisplayName "DSH LAN Chat UDP" -Direction Inbound -Protocol UDP -LocalPort 53318 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "DSH LAN Chat TCP" -Direction Inbound -Protocol TCP -LocalPort 53317 -Action Allow -Profile Private
```

Kylin / Linux：

```bash
sudo ss -lunp | grep 53318
sudo iptables -S | grep -E '5331[78]|KSC'
sudo iptables -I KSC_IN_PRIVATE_ALLOW 1 -p udp --dport 53318 -j ACCEPT   # 临时；持久请用安全中心
```

抓包确认（可选）：`sudo tcpdump -ni any udp port 53318`，同时让对端保持运行；有包但界面不更新 → 应用/端口占用；无包 → 防火墙或网络。
