# 新电脑安装与手机验收（npm Beta）

目标：新电脑安装 npm 包，手机和电脑加入同一 Tailscale 网络后，能从手机打开工作台并让这台电脑上的 agent 工作。npm 包包含构建产物，不需要克隆仓库、安装 pnpm 或本地构建。

## 1. 电脑准备

- Node.js ≥22.19（自带 npm），检查 `node --version`、`npm --version`。
- pi、Claude Code、Codex 任选至少一种，先用该电脑的普通用户完成安装、登录，并在原 CLI 中确认能正常对话。模型权限、订阅或 API 额度由相应服务提供，Hub 不代替登录。
- 电脑和手机安装 Tailscale，登录同一账号并连接；电脑终端能执行 `tailscale status`。自定义 tailnet ACL 需要允许手机访问电脑。
- 电脑保持开机联网；进入睡眠或停止 Hub 后，手机无法让它继续工作。

Codex 接管当前要求二进制 ≥0.162（含对应 alpha），不要求版本号与桌面 App 完全相同。`agent-hub check` 会输出实际所用二进制的诊断；必要时在配置的 `codexBin` 指定路径。模型调用与完整审批的验证边界见 [CODEX_DRIVER.md](CODEX_DRIVER.md)。

## 2. 安装与首次启动

```bash
npm install -g @newobjectcccddd/agent-hub@beta --registry=https://registry.npmjs.org/
agent-hub --version
agent-hub remote
```

临时试用可用 `npx --registry=https://registry.npmjs.org/ @newobjectcccddd/agent-hub@beta remote`。上述命令仅对本次指定 npm 官方源，保留已有公司源设置；安装公开包不需要 npm 登录。不要安装裸名 `agent-hub`，那是第三方包。全局安装遇到 EACCES 时使用用户级 Node/npm 安装或 npm prefix；以你自己的用户运行 Hub，避免误用 root 的空会话目录。

`remote` 自动完成配置初始化、可用的 pi 扩展安装和 Tailscale Serve 引导。全局 pi CLI 是可选项；使用 Claude/Codex 不需要另外安装 pi。只测本机可运行 `agent-hub start`，打开 `http://127.0.0.1:7700`。

首次 Serve 需要 MagicDNS 与 HTTPS 证书。CLI 若给出启用地址，使用 tailnet 管理账号打开确认；也可在 Tailscale 管理后台 DNS 页开启。授权后重新执行 `agent-hub remote`。以打印 **“Tailscale Serve 已开启（HTTPS）”** 和 `https://<node>.<tailnet>.ts.net` 为成功信号，单独看到本机地址不代表远程已通。

说明：[官方 Serve 指南](https://tailscale.com/docs/features/tailscale-serve)；本项目使用 Serve 的 tailnet 内访问，不需要公开端口或开启 Funnel。

## 3. 手机验证

1. 手机 Tailscale 保持连接，在浏览器打开电脑打印的 HTTPS 地址，确认工作台加载完成。
2. Android Chrome 使用安装入口；iPhone Safari 使用“分享 → 添加到主屏幕”。菜单名称随平台/浏览器变化，HTTPS 与 manifest 的独立窗口设置共同决定 PWA 能力。
3. 可先在设置中配置应用锁。进入一条该电脑已有的会话；空列表时先在电脑 agent CLI 中建立会话，再刷新。
4. 发送一条小任务，确认看到受理、回复和完成状态。若任务需要人工批准，在出现卡片后自行决定；实际是否出现审批取决于所用 agent 的策略，不保证每个操作都询问。
5. 刷新手机页面，确认历史仍在；断开再连接 Tailscale，确认能重新打开。

你需要本人完成 agent 登录、Tailscale 登录、首次 HTTPS 授权和手机系统确认；自己的 agent 可负责安装、配置与启动。不要向聊天窗口发送密码、一次性验证码或 token。

## 4. 配置、更新和常驻

| 安装方式 | 配置 | 运行状态（含应用锁） |
|---|---|---|
| npm 全局安装 / npx | `~/.agent-hub/config/hub.config.json` | `~/.agent-hub/data/` |
| Git 源码仓 | `<repo>/config/hub.config.json` | `<repo>/data/` |

`~` 指当前用户的主目录（Windows 通常是 `C:\Users\<user>`）。npm 升级或 npx 换缓存目录不影响这份用户状态。`workspaceRoot` 可设置为你实际的项目目录；原有 agent 会话仍留在各 agent 的标准目录，不会被搬入包目录。

更新：先停止前台或自启动实例，再执行 `npm install -g @newobjectcccddd/agent-hub@beta --registry=https://registry.npmjs.org/`，然后重新启动。先确认前台路径工作，再用全局安装执行：

```bash
agent-hub setup --autostart
```

注册自启动会尝试立即启动服务，操作前先 Ctrl+C 停止前台实例；不要两份实例争用 7700。不要从临时 npx 目录注册自启。macOS / Linux / Windows 分别使用 launchd / systemd user / 任务计划程序，细则见 [PLATFORM.md](PLATFORM.md)。后台服务需继承相应模型环境；自定义网关仅配置在交互 shell 时，先核对前台/后台环境差异。

## 5. 常见问题

| 现象 | 检查 |
|---|---|
| npm 404 | 包名应包含完整小写作用域及 `@beta`；确认此试用版本已发布 |
| `agent-hub` 找不到 | 检查 npm 全局命令目录是否在 PATH；安装后重新打开终端，或先用 npx 试用 |
| `globSync` / Node 版本报错 | 更新至 Node ≥22.19，重新安装；Hub 启动也会拦截旧 Node |
| 手机打不开，本机能打开 | 两端 Tailscale 是否连接、ACL 是否允许、Serve/HTTPS 是否成功；使用打印的 HTTPS 地址 |
| Serve 提供授权 URL | 本人打开该地址完成首次功能授权，然后重跑 remote |
| 7700 被占用 | 停止自己已启动的旧 Hub；不要盲目终止未知进程。也可 `agent-hub remote --port 7790`，pi 终端扩展需同步 `AGENT_HUB_LIVE_URL` |
| 会话列表为空 | 当前运行用户、对应 CLI 的会话目录和登录是否正确；先创建一条本地会话 |
| 能看历史但发送失败 | 先在相同用户/环境中运行原 CLI 排查登录、模型权限和余额；再看气泡内错误与 `agent-hub check` |
| 浏览器只有快捷方式 | 核对 HTTPS、浏览器安装能力和独立窗口设置；不要用 HTTP 局域网地址替代 HTTPS 验收 |
| 自启动与前台争用端口 | 选择一种运行方式；更新自启配置前按平台停止旧实例 |

## 6. 验证范围

- 发布前以真实 tarball 在隔离 HOME 中做 npm 安装、首次配置、HTTP、静态资源、PWA manifest、WS、换安装目录后配置与应用锁保留验证。复测：先 build，再执行 `pnpm test:install`。
- 冒烟里的 Tailscale CLI 是受控 fixture，不修改维护者的真实 Serve；它验证参数与装配，不能代替另一台电脑和手机的真实连接。
- macOS 本机验收、Ubuntu/macOS CI 与你的跨机试用分别记录；Windows 原生仍需真机验收。Codex 真实审批闭环也仍需单独验证。
- npm 包仅包含运行时代码、产物和明确列出的说明文件；不包含私人配置、会话、凭据、运行状态、旧取证截图或原图备份。npm 先行试用不代表 Git 仓库历史已完成公开审查。

## 给安装 agent 的任务

先检查 Node/npm 与选用的 agent CLI；用完整作用域安装 npm Beta，按本文启动并验证本机 HTTP，再引导使用者完成 Tailscale 登录与 HTTPS 授权。保留已有配置和应用锁，不修改模型/权限来绕过失败，不读取或回显凭据文件。先查清 7700 的占用来源，再决定启动方式；完成后报告 npm 版本、HTTP 与 Serve 结果，把手机访问和真实任务回复留给使用者确认。
