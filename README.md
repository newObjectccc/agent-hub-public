# Agent Hub

[English](README.en.md) | 简体中文

![CI](https://github.com/newObjectccc/agent-hub/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/license-MIT-blue) ![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![PWA](https://img.shields.io/badge/PWA-ready-orange)

> 手机就是电脑的遥控器 + 独立工作台。跨平台（macOS / Linux / Windows）的 **pi / Claude Code 会话中枢**。

在任何设备的浏览器里打开 PWA 面板 → 一目了然看到全部 agent 会话与工作状态 → 点击进入 chat 界面继续对话、派发任务、实时旁观。会话与终端 CLI 完全互通（同一份 `~/.pi/agent/sessions/`）。

## 截图

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="Agent Hub 演示：工作台 → 双模式驱动 → chat → 多子代理面板" width="330">
</p>

| 🗂 工作台首页 | 💬 Chat 工作页 |
|---|---|
| ![工作台首页：今日概览与进行中会话](docs/screenshots/workbench.png) | ![Chat 工作页：思维过程与工具执行](docs/screenshots/chat.png) |
| **🤖 多子代理面板** | **📱 双模式驱动 / 🔐 应用锁** |
| ![多子代理面板：当前工具与运行时长](docs/screenshots/subagent-panel.png) | ![双模式会话驱动选择](docs/screenshots/feature-dual-mode.png) |

## 特性

- **📱 双模式会话驱动**：🖥 接管终端（消息注入终端 pi 进程，屏幕实时显示）/ 📱 平行继续（独立工作线，共享上下文）——自己选
- **🤖 子代理活动面板**：pi / claude 双源子代理实时展示（当前工具 / 输出摘要 / 运行时长），像终端多 agent 面板
- **🔴 实时旁观**：终端跑的 pi 会话，手机上看思维链、流式回复、工具执行（token 级）
- **🗂 工作台首页**：按注意力组织（🔥工作中 / ⚠️等你处理 / 今日概览），真实数据
- **📈 Token 用量**：今日/7 天/全部 token 与费用汇总，会话级用量徽章
- **💬 Chat 工作页**：阶段化等待反馈、slash 命令、快捷指令模板、@ 文件引用、上传图片、引用回复、代码高亮/复制
- **📊 会话管理**：优先级排序、子代理父子树、全局搜索、分支树、复制会话（fork）
- **🌿 Git 集成**：仓库状态、diff 查看器、工具调用文件联动（只读安全）
- **⚡ 性能**：WS 批处理、消息 memo、长会话窗口化（流式渲染 12-15x、DOM 21x 瘦身）；服务端 brotli 压缩 + hash 产物长缓存（弱网/远程友好）
- **🔔 通知中心**：会话完结横幅/震动/声音、未读聚合、点击即读
- **🔐 应用锁 + 离线队列**：PIN / WebAuthn 通行密钥解锁、断网消息排队自动重发
- **🖥 Web 终端**（ttyd 可选）：面板内直接开真终端

## 快速开始

方式一：npm 包（npx / 全局安装）——或直接 git clone（见方式二），两种路径任选：

```bash
npx agent-hub remote        # 一键远程：首次自动 setup → 构建 → 启动 + Tailscale
# 或安装后使用完整子命令（dev / setup / start / remote / check / open）
npm install -g agent-hub
agent-hub setup             # 检测环境、生成 config
agent-hub remote            # = start --tailscale，已初始化时直接走 start（幂等）
```

方式二：直接 git clone（仓库开发 / 自托管源码）：

```bash
git clone https://github.com/newObjectccc/agent-hub.git
cd agent-hub
npm run dev          # 开发模式一条命令：server 热重载 + web Vite HMR（前端 http://localhost:5173）
npm run start        # 正式启动：装依赖 → 构建 → 启动，默认 http://127.0.0.1:7700
npm run remote       # 一键远程：自动 setup + 构建 + start --tailscale（幂等）
```

> ⚠️ 用 pnpm 时**不要敲 `pnpm setup`**——那是 pnpm 内置命令（配置 pnpm shell 环境用的），不会执行本项目的 setup。需要 setup 时用 `npm run setup` 或 `node cli/setup.js`。另外 `dev` / `start` 在配置缺失时会自动生成默认配置，setup 仅用于环境体检、装 pi 扩展和注册自启。

## 标准集成链路：手机远程让 pi 干活（实测跑通）

> 这是本项目推荐的默认集成方式，已在 macOS + Android 真机上端到端验证：**装 Tailscale → 一条命令 → 手机装真 PWA（无地址栏）→ 随时给电脑上的 pi 派任务**。

### 步骤（全程 10 分钟）

1. **电脑 + 手机装 [Tailscale](https://tailscale.com/download)，登录同一账号**
   个人免费版（3 用户 / 100 设备）即可；手机 App 商店搜 Tailscale，登同一账号并打开连接开关
2. **开启 HTTPS 证书**：[Tailscale Admin Console](https://login.tailscale.com/admin) → HTTPS Certificates → Enable（一次性，签发面板域名证书用）
3. **电脑上一键启动**：

```bash
npm run remote        # = setup + 构建 + start --tailscale，幂等可重复执行
# 等价：node cli/start.js --tailscale；仅局域网用 --lan
```

   成功输出形如：

```
Tailscale Serve 已开启（HTTPS）：https://<node>.<tailnet>.ts.net
手机浏览器打开该地址 → 菜单 →「安装应用」= 无地址栏真 PWA（WebAPK）。
```

4. **手机安装 PWA**：Chrome 打开打印的 `https://…` 地址 → 菜单 →「**安装应用**」（不是「添加到主屏幕」）→ 打开验证：无地址栏、独立窗口、独立任务栈
5. 之后电脑不在身边时：手机打开 PWA → 工作台 → 派任务 / 实时旁观 / chat 续聊

### ⚠️ 延迟警告：先体检 P2P 直连（延迟敏感用户必读）

手机远程的体验**完全取决于链路走 P2P 直连还是 DERP 中继**：

| 链路 | 延迟 | 体验 |
|---|---|---|
| ✅ P2P 直连（IPv6 / UDP 打洞成功） | < 50ms | 秒开、流式丝滑 |
| ❌ DERP 中继（打洞失败的兜底） | 300ms+ | 明显卡慢——首屏几十个 API/WS 往返，延迟逐级放大 |

部署完先跑一条命令体检（输出「链路延迟体检」一节）：

```bash
agent-hub check              # 等价手动：tailscale netcheck
```

三个关键指标与预期值：

| 指标 | 健康值 | 不健康时怎么做 |
|---|---|---|
| `IPv6` | `yes` | `no` → 路由器启用 IPv6 + 防火墙放行入站 UDP 41641（**首选：v6 无 NAT，免打洞直连**） |
| `MappingVariesByDestIP` | `false` | `true` = 对称 NAT 打洞难 → 路由器开 UPnP；手机蜂窝网络常见，换 Wi-Fi 或用蜂窝 IPv6 出口 |
| `PortMapping` | `UPnP` / `NAT-PMP` | 空 → 路由器开 UPnP，或手动端口转发 UDP 41641 到电脑 |

另看 `Nearest DERP`：正常应为香港/东京（30-50ms）；若显示海外节点且 200ms+（国际链路绕路），打洞失败时会非常慢——务必配好上述直连条件，兜底可自建国内 DERP。

验证直连成功（手机连上 Tailscale 后在电脑执行）：

```bash
tailscale ping <手机的 Tailscale IP>    # 出现 direct（UDPv6）= P2P 直连已打通
```

> 💡 同一 Wi-Fi 下无需 Tailscale：`npm run start -- --lan` 直连局域网 IP，永远最快。

### 已知问题（实测踩坑记录）

| 现象 | 解法 |
|---|---|
| macOS 执行 serve 报 `GUI failed to start` / `CLIError error 3` | GUI 桥失效，root 可直连守护进程：`sudo tailscale serve --bg --https=443 http://127.0.0.1:7700`（实测有效；CLI 诊断失败时也会提示此命令） |
| PWA 装出来带地址栏 / 只是快捷方式 | 当前是 HTTP 源（如自建 headscale），Chrome 只会生成主屏幕快捷方式；换 HTTPS 源重装即解 |
| serve 报证书错误 | Admin Console 的 HTTPS Certificates 未开启（见步骤 2） |
| 手机打开地址超时 | 手机 Tailscale 未连接，或两端登的不是同一账号 |
| 手机能打开但非常慢 | 大概率走 DERP 中继（打洞失败）：跑 `agent-hub check` 体检，按上方「⚠️ 延迟警告」逐条优化 |

> 💡 PWA 冷知识：只有 **HTTPS 源**才能装成真 WebAPK（无地址栏独立窗口），与 manifest 配置无关。官方 Tailscale 的 serve 自动签证书就是为此服务的。

**替代路径**：自建 headscale 控制面见 [docs/HEADSCALE.md](docs/HEADSCALE.md)（tailnet 内 HTTP，PWA 降级）；纯局域网用 `--lan`。详见 [docs/PLATFORM.md](docs/PLATFORM.md)（三平台安装细则）。

## 架构

```
手机 PWA ──HTTP/WS──▶ server (Fastify) ──▶ pi SDK / claude CLI
                          │                    │
                     终端增强层              ~/.pi/agent/sessions
                  （tmux/ttyd/Tailscale）    （会话唯一事实源）
```

| 目录 | 说明 |
|---|---|
| `server/` | REST + WS、pi/claude 双源适配、KPI/通知/git/终端集成 |
| `web/` | PWA（React + Vite + Tailwind v4，野兽派紧凑 UI） |
| `cli/` | 跨平台 dev/setup/start/check/open（纯 Node 零 bash 依赖） |
| `integrations/` | pi 扩展（live-feed 实时流出 / pi-command 反向指令） |
| `docs/` | API 契约、架构、平台细则、headscale 自建指南（HEADSCALE.md）、路线图 |
| `docs/headscale/` | 自建 headscale 控制面部署文件（docker compose + Caddy 自动 HTTPS） |

## 开发

```bash
pnpm install
pnpm dev                           # 一条命令开发调试（推荐）
#   server:tsc  tsc --watch 增量编译
#   server      node --watch 热重启（改后端代码自动生效）
#   web         Vite HMR（改前端代码即时生效）
pnpm build && pnpm lint && pnpm test   # 全量验证（1200+ 测试，GitHub Actions CI 守护）
```

注意：开发调试入口是 Vite（默认 `http://localhost:5173`），`/api` `/ws` 已代理到 server（默认 7700）；不是直接访问 7700。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 部署

本机常驻（推荐平台自启机制）：

```bash
npm run setup -- --autostart   # macOS launchd / Linux systemd / Windows 任务计划
npm run start                  # 前台正式启动（构建 + 启动，配置缺失自动生成）
```

注册后开机自动启动，无需手动操作。日常运维：

| 操作 | macOS（launchd） | Linux（systemd --user） |
|---|---|---|
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user stop agent-hub` |
| 启动 | `launchctl load ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user start agent-hub` |
| 日志 | `~/Library/Logs/agent-hub.log` | `journalctl --user -u agent-hub` |

> 💡 崩溃自愈：launchd 默认 `KeepAlive=false`（崩溃后下次开机才拉起）；需要崩溃自动重启时把 plist 里 `KeepAlive` 改为 `true`。服务器场景直接用下方 pm2（自带自愈）。

服务器（pm2，崩溃自愈 + 开机自启）：

```bash
pnpm build
pm2 start ecosystem.config.js
pm2 save && pm2 startup        # 开机自启
```

## 配置

- `config/hub.config.json`：端口/目录（setup 生成）
- `config/kpi-sources.json`：可选指标卡数据源（`${ENV_VAR}` 引用密钥）

## License

[MIT](LICENSE) © 2026 newObjectccc
