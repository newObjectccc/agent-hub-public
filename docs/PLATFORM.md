# 平台集成细则

## 通用（三平台一致）

1. 安装 Node.js ≥ 20（Windows 建议官方安装包，macOS/Linux 建议 nvm）。
2. `pnpm install && node cli/setup.js && node cli/start.js`。
3. 浏览器打开 `http://127.0.0.1:7700`。

## macOS

```bash
brew install tmux ttyd tailscale   # 全部可选
sudo pmset -c sleep 0              # 插电不睡眠（远程访问需要，可选）
node cli/setup.js --autostart      # 写入 ~/Library/LaunchAgents（可选）
```
Tailscale Serve（手机远程）：
```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:7700
```

## Linux

```bash
sudo apt install tmux ttyd         # Debian/Ubuntu；其余发行版用对应包管理器
curl -fsSL https://tailscale.com/install.sh | sh
node cli/setup.js --autostart      # 写入 ~/.config/systemd/user/agent-hub.service（可选）
```

## Windows

- 核心功能 **PowerShell / CMD 原生可用**（server、web、pi 均为 Node）。
- tmux 不支持原生 Windows，二选一：
  1. 跳过（chat 功能不受影响）；
  2. 装 WSL：`wsl --install`，然后在 WSL 内 `sudo apt install tmux`。
- Tailscale 官方安装包：https://tailscale.com/download/windows
- 自启：`cli/setup.js --autostart` 写入任务计划程序（schtasks）。

## 远程访问三种模式

| 模式 | 命令 | 适用 |
|---|---|---|
| 本机 | `node cli/start.js` | 就在电脑前 |
| 局域网 | `node cli/start.js --lan` | 同一 WiFi 下的手机/平板 |
| Tailscale | `node cli/start.js --tailscale` | 出门在外（需 Tailscale + Serve） |

> 安全：除以上模式外 server 只绑 127.0.0.1。不要把端口直接暴露到公网。
