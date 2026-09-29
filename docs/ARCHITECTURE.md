# 架构与跨平台设计

## 目标

一套可在 **Windows / Linux / macOS** 快速集成的 agent 会话中枢：
手机（或任何设备）通过浏览器 PWA 访问 → 面板看 KPI 与全部 agent 会话 →
点击进入 chat 界面继续对话。底层由 pi SDK 驱动，会话文件复用 `~/.pi/agent/sessions/`。

## 分层

```
PWA (web/)  ←HTTP+WS→  server (Node)  ←→  pi SDK (@earendil-works/pi-coding-agent)
     ↑                      │
  任意设备浏览器        可选增强层（按平台自动检测、可缺失）：
                        tmux / ttyd / tailscale serve / launchd|systemd|任务计划
```

**硬规则：核心功能（会话列表、chat、KPI）不依赖任何可选增强。**
tmux/ttyd/Tailscale 缺失时全部功能照常工作，只在"终端直连"入口降级提示。

## 组件职责

| 目录 | 职责 | 技术 |
|---|---|---|
| `server/` | REST + WS、pi 会话管理、KPI 聚合、系统检测 | Node ≥20、TypeScript、Fastify、ws、pi SDK |
| `web/` | PWA：面板首页（KPI+会话列表）、chat 页 | Vite、React、TypeScript（UI 库不限，禁重依赖） |
| `cli/` | `agent-hub` 命令：`setup` / `start` / `check` / `open` | Node、零重依赖、跨平台 |
| `config/` | `hub.config.json`、`kpi-sources.json`（示例 + 用户覆盖） | JSON |

## 跨平台矩阵

| 能力 | macOS | Linux | Windows | 降级策略 |
|---|---|---|---|---|
| pi SDK（核心） | ✅ | ✅ | ✅ | 无降级，必须可用 |
| PWA 访问（核心） | ✅ | ✅ | ✅ | 无降级 |
| tmux（终端增强） | brew | apt/yum | **WSL 或跳过** | `cli check` 显示建议；chat 不受影响 |
| ttyd（Web 终端） | brew | 包管理器 | 官方二进制 | 不装则不提供"终端直连"入口 |
| Tailscale（组网） | 官方 | 官方 | 官方 | 不装则仅局域网 `lan` 模式监听 |
| 服务自启 | launchd | systemd | 任务计划程序 | `cli setup --autostart` 平台适配，失败仅提示 |

## 关键设计决定

1. **不用 ttyd 承载 chat**：chat 由 pi SDK 事件流渲染；ttyd 仅提供"想要真终端时"的旁路入口。
2. **会话即文件**：不自建数据库，pi 的 JSONL session 树是唯一事实源；
   server 只缓存运行态（哪个会话正在跑）。
3. **一个 server 进程管理 N 个 AgentSession**：每个活跃会话一个 SDK 实例，
   `dispose()` 回收；进程重启后历史不丢（JSONL 落盘）。
4. **监听地址**：默认 `127.0.0.1:7700`。`cli start --lan` 改绑局域网；
   `--tailscale` 时自动探测 tailscale serve 并输出 ts.net 地址。
   **绝不明文暴露 0.0.0.0 到公网。**
5. **PWA 安装条件**：需要 HTTPS。Tailscale Serve 提供免费证书；
   纯局域网模式下 Chrome 可用 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 豁免（文档说明）。
6. **Windows 说明**：pi 与 server/web 均为 Node，PowerShell/CMD 原生可用；
   tmux 相关功能指引用户走 WSL（`wsl -e tmux …`）或直接跳过。

## 目录结构

```
agent-hub/
├── README.md            # 快速开始（三平台）
├── docs/
│   ├── ARCHITECTURE.md  # 本文件
│   ├── API_CONTRACT.md  # 前后端契约（权威）
│   └── PLATFORM.md      # 各平台安装/集成细则
├── config/
│   ├── hub.config.json        # 端口/目录/监听模式
│   └── kpi-sources.json       # KPI 数据源示例
├── cli/                 # agent-hub setup|start|check|open
├── server/              # Fastify + ws + pi SDK
└── web/                 # Vite React PWA
```

## 安全

- 密钥/Token 不入库：KPI source 的 header 走环境变量引用（`${ENV_VAR}` 语法）。
- server 默认只绑回环；`--lan`/`--tailscale` 需显式开关。
- 后续可选：`hub.config.json` 里 `auth.token` 开启 Bearer 校验（v0 先不做，接口预留）。
