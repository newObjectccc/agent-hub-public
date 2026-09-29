# Agent Hub

跨平台（macOS / Linux / Windows）的 **pi agent 会话中枢**：
在任何设备的浏览器里打开 PWA 面板 → 一目了然看到 KPI 与全部 agent 会话 →
点击进入 chat 界面继续对话。会话与 pi CLI 完全互通（同一份 `~/.pi/agent/sessions/`）。

## 组成

| 组件 | 是否必须 | 说明 |
|---|---|---|
| pi（`@earendil-works/pi-coding-agent` SDK） | ✅ 核心 | 驱动 agent 会话 |
| server + web PWA | ✅ 核心 | 面板 + chat 界面 |
| tmux | 可选增强 | 终端直连入口（Windows 用 WSL） |
| ttyd | 可选增强 | 浏览器里开真终端 |
| Tailscale | 可选增强 | 出门在外用手机访问家里电脑（自动 HTTPS） |

核心功能**不依赖**任何可选增强，缺了照常跑。

## 快速开始

```bash
git clone https://github.com/newObjectccc/agent-hub.git
cd agent-hub
pnpm install
node cli/setup.js        # 检测环境、生成 config、安装 pi
node cli/start.js        # 启动 server + 构建 web，默认 http://127.0.0.1:7700
```

手机远程访问（可选）：
```bash
node cli/start.js --tailscale    # 自动探测 tailscale serve，输出 ts.net 地址
```
详见 [docs/PLATFORM.md](docs/PLATFORM.md)（三平台安装细则）与
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## PWA 安装

浏览器打开面板地址 → 菜单 →「添加到主屏幕」。之后就像原生 App 一样全屏启动。

## 开发

- 前后端接口以 [docs/API_CONTRACT.md](docs/API_CONTRACT.md) 为唯一基准。
- `pnpm -r build` 全量构建；`pnpm -r test` 测试；`pnpm -r lint` 检查。
