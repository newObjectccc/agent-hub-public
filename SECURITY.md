# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.3.x | ✅ |
| < 0.3 | ❌ |

## Reporting a Vulnerability

**请勿在公开 issue 中报告安全问题 / Do NOT open a public issue for security vulnerabilities.**

优先渠道（按顺序）：

1. **GitHub Private vulnerability reporting**：仓库 Security 页 → *Report a vulnerability*（若该入口未开启，走第 2 条）。
2. 通过 [GitHub 个人主页](https://github.com/newObjectccc) 上的联系方式私下联系维护者。

报告中请尽量包含：影响版本/commit、复现步骤、影响面评估（能做什么、不能做什么）。我会在 7 天内回复确认收到，并在修复后与你协调披露时间。

## Threat Model（了解这个项目的安全边界）

agent-hub 是**自托管**工具：它能读取你的会话记录并驱动你机器上的 pi / Claude Code / Codex agent（包括执行命令、读写文件）。请把它当成「对本机 agent 的遥控器」来对待。

**默认信任边界 = 你的私有网络**：

- 默认只监听 `127.0.0.1`，拒绝通配地址绑定；局域网开放需要显式 `allowLan`
- 推荐部署形态是 Tailscale / headscale / 私有局域网（见 README 安全须知）
- **请勿把端口直接暴露公网**；公网访问请用 Tailscale/headscale 或前置带鉴权的反向代理

**当前已知的边界限制（请在评估风险时纳入）**：

- `auth.token` 与自带 PWA 面板不兼容（web 端无 Bearer 输入能力）；它只服务 API/CLI 调用方。显式开启但 token 为空，以及 auth 字段拼错、结构/类型错误均拒绝启动，避免鉴权静默失效。
- 应用锁（PIN / WebAuthn）是 UI + 业务请求门禁，不能替代网络层边界
- **hub 通道 = 对本机 agent 的全权遥控**：Claude 会话默认 `claudeDriver.permissionMode: "bypassPermissions"`，
  工具（读写文件、执行命令）自动执行、无人工审批门禁，仅适用于信任的仓库与设备；
  改回 `manual` 等需确认档位后，平行与接管两路径均恢复手机审批卡片（超时或进程退出默认拒绝）
- 部分只读文件接口（`/api/fs/tree`、`/api/git/*`、`/api/files/content`）尚未强制 `workspaceRoot` 根约束
- 同源判定对本机回环端口有开发期放宽

**权限与交互配置**：

- Codex 的 `inherit` 沿用使用者自己的本机权限与沙箱设置；Hub 不预设本机账户的具体值。
- Claude 的合法权限档位可显式选择，默认 `bypassPermissions`；需要人工确认时配置 `claudeDriver.permissionMode: "manual"`。pi 平行通道工具真实执行、无审批。
- 非法 Claude 权限值、拼错/放错位置的字段，以及损坏或非对象配置会在启动前报 `CONFIG_INVALID`；配置内容不随错误回显。缺少配置文件时仍支持首次默认初始化，`//` 注释键继续允许。
- 工具提问与 MCP elicitation 通过手机问答卡片应答；超时、取消或收尾时明确告知模型用户未回答，不代答。
- 凭据与认证类请求不上手机，保留现有审批超时与收尾拒绝规则。

## Security Invariants（我们维护的硬规则）

- 不读取、不记录、不回显任何凭据文件（`~/.codex/auth.json`、`~/.zshrc` 密钥等）
- git 集成硬只读（status/log/diff/show/branches），无任何写操作
- 日志与错误信息统一脱敏（`[REDACTED]`），路径预览截断
- 审批/权限请求超时与收尾一律 deny，绝不自动 allow
