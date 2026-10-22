# 平台集成细则

npm 全局安装 / npx 用户先看 [新电脑安装指南](INSTALL.md)：包内已含构建产物，运行配置位于 `~/.agent-hub`。下面的 `node cli/...` 命令针对源码仓；全局安装可改用对应的 `agent-hub` 子命令。

## 通用（三平台设计一致；Windows 待真机验收）

1. 安装 Node.js ≥ 22.19（Windows 建议官方安装包，macOS/Linux 建议 nvm）。
2. `node cli/setup.js && node cli/start.js`。
   - `setup`：环境检测（node/pi/tmux/ttyd/tailscale）+ 生成 `config/hub.config.json` + 安装 pi 扩展；
     全局 pi 为可选，缺失只提示 `npm i -g @earendil-works/pi-coding-agent` 或 npx 方式，不自动安装。
   - 源码仓的 `start`：依赖缺失时自动安装，再构建 web 与 server，最后启动 `server/dist/index.js`。
     npm/npx 发布包已含构建产物且由 npm 安装依赖，跳过这两步直接启动。
3. 浏览器打开 `http://127.0.0.1:7700`。

> 所有步骤均可用 `--dry-run` 预演（不写盘、不安装、不启动）；
> `node cli/cli.js check` 为只读环境检测报告。

## pi 实时旁观（live-feed 扩展，可选）

`node cli/setup.js` 已自动安装 live-feed 和 pi-command 到 `~/.pi/agent/extensions/`，
重新 setup 会更新为仓库版本；之后重启已有 pi 终端会话以加载扩展。需要手动安装时：

```bash
mkdir -p ~/.pi/agent/extensions
cp integrations/pi-live-feed/live-feed.ts ~/.pi/agent/extensions/live-feed.ts
cp integrations/pi-command/command.ts ~/.pi/agent/extensions/pi-command.ts
```

之后任意终端里跑的 pi 会话都会把思维链/流式回复/工具执行实时推给 agent-hub
（手机 chat 页 token 级旁观）。可选环境变量：`AGENT_HUB_LIVE_URL`（覆盖推送地址，
默认 `http://127.0.0.1:7700`）、`AGENT_HUB_LIVE_TOKEN`（与 `hub.config.json` 的
`auth.token` 对齐的共享密钥，为空则不带鉴权）。扩展故障静默、不阻塞 pi。

## claude 接管投屏（tmux，可选）

Claude 接管由 hub 新建 CLI 进程续接会话，不控制原 TUI；接管期间避免同时在原 TUI 输入。
其输出可实时投屏到电脑终端：attach 后自动创建 tmux 命名
session `hub-<id8>`，电脑上运行 `tmux attach -t hub-<id8>` 观看（退出接管后 pane 会打印
`claude --resume` 交接提示）。依赖 tmux（无则自动降级为不可用，接管功能不受影响）；
`hub.config.json` 的 `claudeDriver.mirror: "off"` 可关闭。原终端已关闭的历史会话仍可从手机续聊，
平行模式无需 tmux。详见 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)。

## macOS

```bash
brew install tmux ttyd tailscale   # 全部可选
sudo pmset -c sleep 0              # 插电不睡眠（远程访问需要，可选）
node cli/setup.js --autostart      # 写入 ~/Library/LaunchAgents/com.agent-hub.plist 并 launchctl load（可选）
```
手动命令（注册失败时）：`launchctl load ~/Library/LaunchAgents/com.agent-hub.plist`

新配置默认 `KeepAlive=true`，进程退出后自动拉起；旧 plist 需重新注册才能更新。
已加载旧配置时，先 `launchctl unload ~/Library/LaunchAgents/com.agent-hub.plist` 再运行 setup，
让 launchd 重新读取配置。主动停止也用 unload；只杀进程会被再次拉起。
服务重启不会自动恢复任务或接管，历史仍保留。

**ttyd Web 终端（F2，可选增强）**：装了 ttyd（≥ 1.7）后，手机 PWA 侧栏出现「⌨ 终端」入口
（系统页也有快捷入口）。语义：**按需拉起**——打开终端页点「▶ 打开真终端」时 server 才 spawn
ttyd（随机高端口 + 仅 127.0.0.1 + 随机 Basic 凭证），浏览器只走 server 的同源反代
`/terminal/*`（token 能力凭证），ttyd 从不对外暴露；server 关闭 / 空闲 30min 自动回收。
未安装显示「未安装（brew install ttyd）」灰色指引；Windows 显示「不支持（WSL 内可用）」。

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

- 核心功能按 **PowerShell / CMD 原生运行**设计，尚待 Windows 真机验收（server、web、pi 均为 Node）。
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

### Tailscale HTTP 转发回退（macOS 历史排障记录）

macOS 上 Tailscale Serve 的 **HTTP/HTTPS 代理组件**在部分环境不可用
（曾报 `501 Not Implemented` 或代理链路 502）。先按 README 的 HTTPS Serve 流程部署；
只有遇到这些问题时再尝试纯 TCP 转发。server 校验 Host，设备名 `.ts.net` 和 IP 属于支持范围：

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
后使用 `node cli/start.js --tailscale` 引导配置 HTTPS Serve。

## 构建与部署

server 会实时托管当前 `web/dist`。有手机或其他设备在使用这个工作区时，在独立 worktree 中完成
`pnpm install --frozen-lockfile`、`pnpm -r build`、`pnpm -r lint`、`pnpm -r test` 和
`node scripts/pack-smoke.mjs`，避免验证构建改写在线文件。发布时统一构建与重启；重启会中断本服务持有的任务，
不自动重放尚未完成的消息。详细协作约定见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
