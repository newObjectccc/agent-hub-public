# 架构与跨平台设计

## 目标

一套可在 **Windows / Linux / macOS** 快速集成的 agent 会话中枢：
手机（或任何设备）通过浏览器 PWA 访问 → 面板看 KPI 与全部 agent 会话 →
点击进入 chat 界面继续对话。三个来源统一纳管，底层分别使用 pi SDK、Claude CLI 和 Codex CLI。
原生会话文件保存历史；运行状态、队列和接管关系由 hub 在内存中管理。

## 分层

```
PWA (web/) ←HTTP+WS→ server (Fastify + SessionRegistry)
                         ├─ PiAdapter     → pi SDK / pi-command 扩展
                         ├─ ClaudeAdapter → 单次 claude -p 进程
                         │  ClaudeDriverHub → 持续运行的 claude -p 进程 / 权限 MCP bridge
                         └─ CodexAdapter  → codex exec resume（parallel）
                         └─ CodexDriverHub → stdio app-server（attach，原生审批/steer/interrupt）
                                  │
                             原生 JSONL 会话文件
                         （扫描、增量 tail、历史对账）

可选增强：tmux 投屏 / ttyd Web 终端 / Tailscale 远程 / 平台服务自启
```

**核心列表、历史、chat 不依赖 tmux、ttyd 或 Tailscale。**
缺少它们只降级对应的投屏、Web 终端或远程访问能力。实际执行仍需要对应来源的运行环境与授权；
pi 终端接管还需要在线的 pi-command 扩展。Claude 接管关闭时仍可使用平行模式。

## 组件职责

| 目录 | 职责 | 技术 |
|---|---|---|
| `server/` | REST + WS、三源适配、进程管理、KPI/通知/用量、只读 git、系统检测 | Node ≥22.19、TypeScript、Fastify、ws、pi SDK |
| `web/` | PWA：面板首页（KPI+会话列表）、chat 页 | Vite、React、TypeScript（UI 库不限，禁重依赖） |
| `cli/` | `setup` / `dev` / `start` / `remote` / `check`（doctor 别名）/ `open`，以及投屏渲染器 | Node、跨平台 |
| `integrations/` | pi live-feed / pi-command、Claude 权限 bridge | pi 扩展、MCP stdio |
| `config/` | 配置模板、KPI 数据源；实际 `hub.config.json` 本地生成且不入库 | JSON |

## 跨平台矩阵

| 能力 | macOS | Linux | Windows | 降级策略 |
|---|---|---|---|---|
| server / web / pi SDK | ✅ | ✅ | ✅ | 执行按来源分发，不要求所有 agent 同时安装 |
| Claude / Codex 执行 | 本机 CLI | 本机 CLI | 对应环境的 CLI | 未安装或未授权时无法执行该来源任务 |
| PWA 访问（核心） | ✅ | ✅ | ✅ | 无降级 |
| tmux（终端增强） | brew | apt/yum | **WSL 或跳过** | `cli check` 显示建议；chat 不受影响 |
| ttyd（Web 终端） | brew | 包管理器 | 官方二进制 | 不装则不提供"终端直连"入口 |
| Tailscale（组网） | 官方 | 官方 | 官方 | 不装仍可本机访问或显式启用局域网模式 |
| 服务自启 | launchd | systemd | 任务计划程序 | `cli setup --autostart` 平台适配，失败仅提示 |

## 关键设计决定

1. **不用 ttyd 承载 chat**：SDK/CLI 事件及文件 tail 统一映射为 WS 消息，ttyd 是独立的可选旁路。
2. **历史来自原生文件**：pi `~/.pi/agent/sessions/`、Claude `~/.claude/projects/`、
   Codex `~/.codex/sessions/`（另含配置的归档根）。没有另建一份聊天数据库。
   列表扫描有缓存；发送前 Claude 重新检查文件 mtime，避免旧缓存掩盖外部活动。
3. **模式按来源实现**：pi 平行模式用 SDK，接管模式经扩展注入已有终端进程；Claude 平行模式每轮
   启动 CLI，接管模式由 hub 新建持续运行的 CLI 进程续接同一 session。Claude 的原 TUI 不受控制，
   tmux 只投屏 hub 进程。Codex 使用独立 app-server 接管同一线程，默认只手动接管；桌面已占用时拒绝，不转 exec 重试。
4. **完成会话可以续聊**：手机发送新消息会从已保存上下文开始新一轮，无需原终端仍打开。
   只打开页面不重发任务。关闭 PWA 不停止已受理任务；服务重启保留历史，不自动恢复执行、队列或接管。
5. **状态与消息分开**：`message_end` 只完成单条消息，`agent_settled` 表示整轮结束。
   hub 管理的 Claude 进程使用实际运行状态，空闲的接管进程不算工作中；外部 TUI 只能由文件活动推断。
   页面消息结束后静默 5 秒会补查状态，仍运行或请求失败时继续等待；迟到的查询结果不能覆盖新一轮。
6. **对账不制造重复或丢图**：Claude 流式 assistant 尽量沿用原生 `message.id`，与历史及工具结果一致；
   UTF-8 与 JSONL 分块安全解码，退出时处理无换行尾行。历史和实时消息均过滤内部图片尺寸提示。
   Codex 以真实 turnId 对账当前轮快照；历史 GET 在途收到的 WS 完成消息和终态不会被旧响应覆盖。
   图片对账保留已知附件；旧 `@上传路径` 历史只在存在对应成功读图结果时恢复缩略图，详见 API 契约。
7. **并发由进程所有权约束**：同一 Claude 接管请求共用启动任务，待启动接管计入并发上限，取消后不再启动。
   平行发送在异步准备完成后才作最后的 busy 判定并立即启动，abort 同时取消启动中的请求与本地队列。
   自有平行 run 的 steer/followUp 排队；外部 TUI 忙时无法消费这些队列，三种模式均拒绝。
   attach 准备前及启动前各检查静默窗；这些检查不是进程锁，不能保证阻止外部 TUI 再次输入。
8. **监听与平台增强**：默认 `127.0.0.1:7700`，`start --lan` 显式开放局域网；`--tailscale` 引导远程访问。
   PWA 完整安装使用 HTTPS。server/web/CLI 可在 Windows 原生运行，tmux/ttyd 相关能力按平台降级。

## 目录结构

```
agent-hub/
├── README.md            # 快速开始（三平台）
├── docs/
│   ├── ARCHITECTURE.md  # 本文件
│   ├── API_CONTRACT.md  # 前后端契约（权威）
│   ├── CLAUDE_DRIVER.md # Claude 接管与权限契约、实验记录
│   └── PLATFORM.md      # 各平台安装/集成细则
├── config/
│   ├── hub.config.example.json # 配置模板；实际配置不入库
│   └── kpi-sources.json       # KPI 数据源示例
├── cli/                 # setup|dev|start|remote|check|doctor|open
├── integrations/        # pi 扩展 + Claude 权限 MCP bridge
├── server/              # Fastify + ws + 三源 adapters
└── web/                 # Vite React PWA
```

## 安全

- `auth.enabled` + 非空 `auth.token` 开启 HTTP 与 WS 鉴权；WS upgrade 同时检查来源和可信 Host。
  默认鉴权关闭，面向私有网络；配置开启但 token 为空时启动会告警。
- 应用锁（PIN / WebAuthn）另有 HTTP/WS 操作门禁，不能代替网络鉴权。
- pi 反向指令、live ingest 和 Claude 权限 bridge 限本机回环，配置 token 后须携带 token。
- 文件/git API 只读；上传限定允许的 cwd 与上传根，并检查 realpath。工具图片仅在匹配用户上传引用时回填预览。
- Claude 平行进程使用 manual 权限；接管进程遵循解析后的权限配置，非 bypass 模式通过手机审批，
  超时或退出默认拒绝。具体协议和限制见 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)。
- 真实配置、上传、运行数据不入库；KPI source 的 header 可用 `${ENV_VAR}` 引用密钥。
- server 默认只绑回环，通配绑定需显式 `allowLan`；跨域访问使用 `allowOrigins` 精确白名单。

完整字段和事件以 [API_CONTRACT.md](API_CONTRACT.md) 为准；部署与构建纪律见
[PLATFORM.md](PLATFORM.md) 和 [CONTRIBUTING.md](../CONTRIBUTING.md)。
