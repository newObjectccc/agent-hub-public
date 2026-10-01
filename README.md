# Agent Hub

> 手机就是电脑的遥控器 + 独立工作台。跨平台（macOS / Linux / Windows）的 **pi / Claude Code 会话中枢**。

在任何设备的浏览器里打开 PWA 面板 → 一目了然看到全部 agent 会话与工作状态 → 点击进入 chat 界面继续对话、派发任务、实时旁观。会话与终端 CLI 完全互通（同一份 `~/.pi/agent/sessions/`）。

## 特性

- **📱 双模式会话驱动**：🖥 接管终端（消息注入终端 pi 进程，屏幕实时显示）/ 📱 平行继续（独立工作线，共享上下文）——自己选
- **🤖 子代理活动面板**：pi 派生的子代理实时展示（当前工具 / 输出摘要 / 运行时长），像终端多 agent 面板
- **🔴 实时旁观**：终端跑的 pi 会话，手机上看思维链、流式回复、工具执行（token 级）
- **🗂 工作台首页**：按注意力组织（🔥工作中 / ⚠️等你处理 / 今日概览），真实数据
- **📈 Token 用量**：今日/7 天/全部 token 与费用汇总，会话级用量徽章
- **💬 Chat 工作页**：阶段化等待反馈、slash 命令、快捷指令模板、@ 文件引用、上传图片、引用回复、代码高亮/复制
- **📊 会话管理**：优先级排序、子代理父子树、全局搜索、分支树、复制会话（fork）
- **🌿 Git 集成**：仓库状态、diff 查看器、工具调用文件联动（只读安全）
- **⚡ 性能**：WS 批处理、消息 memo、长会话窗口化（流式渲染 12-15x、DOM 21x 瘦身）
- **🔔 通知中心**：会话完结横幅/震动/声音、未读聚合、点击即读
- **🔐 应用锁 + 离线队列**：PIN / WebAuthn 通行密钥解锁、断网消息排队自动重发
- **🖥 Web 终端**（ttyd 可选）：面板内直接开真终端

## 快速开始

方式一：npm 包（npx / 全局安装）——或直接 git clone（见方式二），两种路径任选：

```bash
npx agent-hub remote        # 一键远程：首次自动 setup → 构建 → 启动 + Tailscale
# 或安装后使用完整子命令（setup / start / remote / check / open）
npm install -g agent-hub
agent-hub setup             # 检测环境、生成 config
agent-hub remote            # = start --tailscale，已初始化时直接走 start（幂等）
```

方式二：直接 git clone（仓库开发 / 自托管源码）：

```bash
git clone https://github.com/newObjectccc/agent-hub.git
cd agent-hub
npm run setup        # 检测环境、生成 config（pi 缺失只提示安装方式）
npm run start        # 装依赖 → 构建 → 启动，默认 http://127.0.0.1:7700
npm run remote       # 一键远程：首次自动 setup + 构建 + start --tailscale（幂等）
```

手机远程访问（推荐 Tailscale）：

```bash
node cli/start.js --tailscale    # 或 --lan 局域网；或 npm run remote 一键搞定
```

详见 [docs/PLATFORM.md](docs/PLATFORM.md)（三平台安装细则）。

## PWA 安装

浏览器打开面板地址 → 菜单 →「添加到主屏幕」。之后像原生 App 一样全屏启动。

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
| `cli/` | 跨平台 setup/start/check/open（纯 Node 零 bash 依赖） |
| `integrations/` | pi 扩展（live-feed 实时流出 / pi-command 反向指令） |
| `docs/` | API 契约、架构、平台细则、路线图 |

## 开发

```bash
pnpm install
pnpm -r build && pnpm -r lint && pnpm -r test   # 全量验证（900+ 测试，CI 守护）
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 配置

- `config/hub.config.json`：端口/目录（setup 生成）
- `config/kpi-sources.json`：可选指标卡数据源（`${ENV_VAR}` 引用密钥）

## License

[MIT](LICENSE) © 2026 newObjectccc
