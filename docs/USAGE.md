# 使用与运维

[返回 README](../README.md) · [English](USAGE.en.md)

本文保留完整的会话行为、部署步骤与配置参考。首次安装和连接手机见[安装指南](INSTALL.md)；各 agent 的专有能力见 [Claude 驱动](CLAUDE_DRIVER.md)和 [Codex 驱动](CODEX_DRIVER.md)。

## 旧会话续聊与发送模式

已经完成的会话仍可继续聊：即使电脑上的原终端已关闭，手机发送新消息也会从保存的上下文开始新一轮工作。只打开会话不会自动重发历史任务；会话名称（如“任务完成状态”）也不代表当前运行状态。执行依赖电脑上的 hub 服务及对应 agent 运行环境；关闭 PWA 不会停止已受理的任务，hub 服务重启不会自动恢复执行或接管。

| Claude 场景 | 发送行为 |
|---|---|
| 平行模式，当前空闲 | hub 启动一次 CLI 续聊，无需原终端保持打开 |
| 平行模式，hub 启动的任务正在运行 | 普通发送返回忙；“插话”和“排队”均在该任务结束后发送 |
| 平行模式，未接管的电脑终端正在运行（pi / Claude） | 三种发送模式均返回忙（pi 为 `EXTERNAL_ACTIVE`，Claude 为 `SESSION_BUSY`），并给出可行动的中文原因；平行模式无法向这个终端排队 |
| 接管模式 | hub 持有新的 CLI 进程；“插话”在工具间隙处理，“排队”在本轮结束后处理；正忙时普通发送通过回执报告失败 |

pi 平行模式由 hub 进程内的 SDK 实例续聊，**工具调用（读写文件、执行命令）在你电脑上真实执行且无人工批准**，请只在你信任的仓库使用；Claude 平行默认 `--permission-mode bypassPermissions`：工具在你电脑上**自动执行且无人工批准**（与 pi 同类风险，请只在信任的仓库使用），可在 hub 配置 `claudeDriver.permissionMode` 改回 `manual` 等需确认档位——需确认档位下平行与接管两路径都会在手机上弹出审批卡片（同一套 HostRequestCard，允许/拒绝后继续）。模型/网络失败（含余额耗尽、连接中断、上下文溢出）在 pi 里不抛异常而是落在消息的 stopReason 上，hub 会把它透出为气泡内错误条：上下文溢出给「压缩上下文」一键自救，主动中止用中性语气不当报错；错误类提示常驻不自动消失。被双写闸门拦下或终端未执行的消息会退回离线队列并保留失败气泡（含重试入口），文本不会丢。

Codex 两条通道同样默认最高执行权限：免操作审批、完整文件与网络访问。权限只作用于 Hub 驱动的 agent 进程，沿用当前系统账号能力；模型向你提问时仍会等待问答卡片。已有配置中的显式 `inherit` 或收紧档位会继续保留，升级不会覆盖你的选择。

Claude 接管不会控制原来的 TUI 窗口。接管期间请避免同时在原窗口输入；tmux 仅展示 hub 进程的输出。外部活动检测依赖文件更新时间，静默窗不能替代进程锁。

默认 `active-only` 策略下，pi 终端扩展在线时默认接管；Claude 在状态为 `running` **或** `lastDrivenBy=terminal` 时默认尝试接管，其他情况默认平行。`always` 每次打开均尝试接管，`never` 只手动切换；用户手动选择优先，实际接管仍受静默窗、开关及并发上限约束。

回复中的一条消息结束后，整轮任务可能仍在执行工具。页面以整轮结束事件和服务端状态确认完成，静默 5 秒会补查状态，不会仅凭静默就显示完成。

上传图片通过缩略图展示；Claude 的图片尺寸/坐标提示属于内部元数据，不显示为用户消息。旧的 `@.agent-hub-uploads/...` 历史消息在保存了对应的成功读图结果后可恢复预览；仅有路径、尚未读图的历史记录不保证刷新后有预览。完整约束见 [API 契约](API_CONTRACT.md)和 [Claude 驱动说明](CLAUDE_DRIVER.md)。

## 部署

本机常驻（推荐平台自启机制）：

```bash
agent-hub setup --autostart   # 全局安装；先停止前台实例，注册后会尝试立即启动
```

注册后随用户登录启动，具体平台行为见平台说明。检测到 tailscale 时自启命令自动携带 `--tailscale`（启动时尝试确保 Tailscale Serve）；纯局域网用 `agent-hub setup --autostart --lan` 覆盖。Tailscale 本身的安装、登录和首次 HTTPS 授权需先完成。日常运维：

| 操作 | macOS（launchd） | Linux（systemd --user） |
|---|---|---|
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user stop agent-hub` |
| 启动 | `launchctl load ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user start agent-hub` |
| 日志 | `~/Library/Logs/agent-hub.log` | `journalctl --user -u agent-hub` |

> 💡 崩溃自愈：新生成的 launchd 配置默认 `KeepAlive=true`，进程退出后会自动拉起。已有旧配置先用上表的 unload，再重新运行 `agent-hub setup --autostart`（源码仓用 `node cli/setup.js --autostart`），让 launchd 读取新配置；主动停止也用 unload。服务重启保留历史，但不会自动续跑任务。

服务器（pm2，崩溃自愈 + 开机自启）：

```bash
pnpm build
pm2 start ecosystem.config.js
pm2 save && pm2 startup        # 开机自启
```

## 配置

- npm 使用 `~/.agent-hub/config/hub.config.json`，源码仓使用 `config/hub.config.json`：端口/目录/鉴权（setup 生成），字段与默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `7700` | 面板端口 |
| `host` | `127.0.0.1` | 监听地址（拒绝通配绑定，见下方安全须知） |
| `sessionDir` | `~/.pi/agent/sessions` | pi 会话目录（支持 `~`，下同） |
| `workspaceRoot` | `~/Workspace` | 工作区根目录（今日概览 git 统计 / 上传与新建会话 cwd 的约束根） |
| `kpiRefreshMinutes` | `5` | 指标卡后台刷新间隔（分钟） |
| `auth` | `{"enabled": false, "token": ""}` | API / WS 鉴权（见安全须知） |
| `allowOrigins` | `[]` | 跨域白名单（精确 origin，如 `https://app.example.com`；空数组 = 拒绝一切跨域） |
| `allowLan` | `false` | 显式开启局域网暴露（允许 `host` 通配绑定；`start --lan` 会自动写入） |
| `codexBin` | `"codex"` | CLI 命令或绝对路径，parallel/接管共用；doctor 显示实际版本，接管要求 0.162+（含对应 alpha） |
| `codexDriver.enabled` / `defaultPolicy` | `true` / `"never"` | 默认平行继续，Codex 接管仅手动；此项不控制工具权限，详见 [驱动说明](CODEX_DRIVER.md) |
| `codexDriver.approvalPolicy` / `sandbox` | `"never"` / `"danger-full-access"` | 同时控制平行与接管，默认免操作审批、完整文件和网络访问（以当前系统账号与管理员策略为界）。可选审批 `inherit\|never\|untrusted\|on-request`、沙箱 `inherit\|danger-full-access\|read-only\|workspace-write`；`inherit` 才沿用本机配置。接管核对实际回显，非法权限字段拒绝启动。需要手机审批可选 `on-request`（由模型申请时提示）；`untrusted` 取决于 CLI 版本支持，真实审批闭环仍需实测 |
| `claudeDriver.enabled` | `true` | claude 接管（hub 驱动）总开关：关掉后不构造驱动、接管接口回 400，前端回落平行模式 |
| `claudeDriver.defaultPolicy` | `"active-only"` | 默认接管策略：Claude `running` 或最后由终端驱动时尝试接管 / `always`=打开即尝试 / `never`=只手动；pi 还要求扩展在线，手动选择优先 |
| `claudeDriver.idleDetachMs` | `1800000` | 空闲自动退出接管（毫秒，30 分钟；`0`=永不，运行中不退） |
| `claudeDriver.maxConcurrent` | `3` | 并发 hub 驱动上限，含正在准备的接管（超出 409 DRIVER_LIMIT） |
| `claudeDriver.mirror` | `"tmux"` | 终端投屏（tmux 命名 session，`tmux attach` 实时观看；无 tmux 自动降级 `off`） |
| `claudeDriver.externalQuietMs` | `3000` | 接管准备前及启动进程前各检查一次文件静默窗；近期外部写入返回 409，无法提供进程级互斥 |
| `claudeDriver.permissionMode` | `"bypassPermissions"` | 权限档位，同时管平行与接管两路径的 `--permission-mode`：默认 `bypassPermissions`（最高权限，两路径工具均自动执行、无人工审批）；`manual`/`default`/`acceptEdits`/`plan` = 需确认档位——平行与接管两路径都走手机审批卡片（同一套 UI）；`inherit` = 沿用你的 `~/.claude/settings.json`。非法权限值、未知键或错放字段会拒绝启动，避免回落最高权限 |

- npm 可在 `~/.agent-hub/config/kpi-sources.json` 创建可选指标卡数据源；源码仓使用 `config/kpi-sources.json`（`${ENV_VAR}` 引用密钥）

## 安全须知（部署前必读）

本项目默认**零鉴权**，信任边界是你的私有网络——部署形态决定安全性：

| 部署形态 | 安全 | 需要做什么 |
|---|---|---|
| 本机 `127.0.0.1`（默认） | ✅ | 无 |
| Tailscale / headscale / 私有局域网 | ✅ | 无（推荐形态） |
| 公网 VPS / 公网 IP 直接暴露 | ❌ | **请勿直接暴露**。需要公网访问时用 Tailscale/headscale，或在面板前面加一层带鉴权的反向代理（Caddy/Nginx basic auth、OAuth2 等） |

- **关于 `auth.token`（API 鉴权）的如实说明**：`"auth": { "enabled": true, "token": "<长随机串>" }` 开启后（token 为空、类型错误或字段拼错时拒绝启动），全部 API 与 WS 都要求 `Authorization: Bearer <token>`——**也包括自带 PWA 面板的静态资源**，而 web 端目前没有输入 Bearer token 的能力。也就是说开了它自带面板就打不开；它只适用于 API/CLI 调用方（例如由反代注入鉴权头的场景）。在补齐 web 端 token 支持之前，公网暴露请一律走 Tailscale/headscale 或前置反代鉴权，**不要**指望单靠 `auth.token` 保护公网部署
- `auth.enabled` 默认 `false` 是刻意设计（tailnet 内免 token 的顺手体验）
- **应用锁（PIN / WebAuthn）**保护界面，并在服务端校验业务 HTTP 请求和 WS 发送/中止的解锁令牌；它不能替代 API token，两层可同时启用
- `host` 默认 `127.0.0.1` 且拒绝通配绑定；局域网开放需显式 `"allowLan": true`（或 `agent-hub start --lan` / `npm run start -- --lan`，CLI 会自动写入 `allowLan`）
- 发现安全问题请**勿公开 issue**，按 [SECURITY.md](../SECURITY.md) 的渠道私下报告
