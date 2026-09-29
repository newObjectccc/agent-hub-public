# 平台集成细则

## 通用（三平台一致）

1. 安装 Node.js ≥ 20（Windows 建议官方安装包，macOS/Linux 建议 nvm）。
2. `node cli/setup.js && node cli/start.js`。
   - `setup`：环境检测（node/pi/tmux/ttyd/tailscale）+ 生成 `config/hub.config.json`；
     pi 缺失只提示 `npm i -g @earendil-works/pi-coding-agent` 或 npx 方式，不自动安装。
   - `start`：node_modules 缺失时自动 `pnpm install`（pnpm 缺失回退 `npm install`），
     再构建 web（vite build）与 server（tsc），最后启动 `server/dist/index.js`。
3. 浏览器打开 `http://127.0.0.1:7700`。

> 所有步骤均可用 `--dry-run` 预演（不写盘、不安装、不启动）；
> `node cli/cli.js check` 为只读环境检测报告。

## macOS

```bash
brew install tmux ttyd tailscale   # 全部可选
sudo pmset -c sleep 0              # 插电不睡眠（远程访问需要，可选）
node cli/setup.js --autostart      # 写入 ~/Library/LaunchAgents/com.agent-hub.plist 并 launchctl load（可选）
```
手动命令（注册失败时）：`launchctl load ~/Library/LaunchAgents/com.agent-hub.plist`

Tailscale Serve（手机远程，`node cli/start.js --tailscale` 会自动引导）：
```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:7700
```

## Linux

```bash
sudo apt install tmux ttyd         # Debian/Ubuntu；其余发行版用对应包管理器
curl -fsSL https://tailscale.com/install.sh | sh
node cli/setup.js --autostart      # 写入 ~/.config/systemd/user/agent-hub.service 并 systemctl --user enable --now（可选）
```

## Windows

- 核心功能 **PowerShell / CMD 原生可用**（server、web、pi 均为 Node）。
- tmux 不支持原生 Windows，二选一：
  1. 跳过（chat 功能不受影响）；
  2. 装 WSL：`wsl --install`，然后在 WSL 内 `sudo apt install tmux`。
- Tailscale 官方安装包：https://tailscale.com/download/windows
- 自启：`node cli/setup.js --autostart` 用 schtasks 注册任务计划 `agent-hub`（ONLOGON 启动）；
  失败仅提示，可按输出的确切命令手动注册。

## 远程访问三种模式

| 模式 | 命令 | 适用 |
|---|---|---|
| 本机 | `node cli/start.js` | 就在电脑前 |
| 局域网 | `node cli/start.js --lan` | 同一 WiFi 下的手机/平板 |
| Tailscale | `node cli/start.js --tailscale` | 出门在外（需 Tailscale + Serve） |

> 安全：除以上模式外 server 只绑 127.0.0.1。不要把端口直接暴露到公网。

### Tailscale 实操（macOS 实测可用配置）

macOS 上 Tailscale Serve 的 **HTTP/HTTPS 代理组件**在部分环境不可用
（报 `501 Not Implemented` 或代理链路 502），推荐用**纯 TCP 转发**，手机浏览器
直接访问即可（server 不校验 Host）：

```bash
# macOS GUI 版 CLI（standalone wrapper 可能有 bundle 报错，用 app 内二进制）
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
$TS serve --bg --tcp=4700 tcp://127.0.0.1:7700
$TS serve status   # 确认 tcp://<host>:4700 → tcp://127.0.0.1:7700
```

手机（已连 Tailscale）访问：`http://<你的设备名>.<tailnet>.ts.net:4700`（或 tailscale IP:4700）。

**排查坑**：若 curl 返回 502，先检查本地代理劫持——
`curl --noproxy '*' <url>` 再测一次（Clash/`http_proxy` 会把内网域名交给上游代理）。

**PWA 安装**：HTTP 模式下安卓 Chrome 菜单“添加到主屏幕”可作快捷方式使用；
要完整 standalone 安装需 HTTPS——在 Tailscale admin console 开启 HTTPS Certificates
后改用 `$TS serve --bg --https=443 --terminate-tls=<host> http://127.0.0.1:7700`。
