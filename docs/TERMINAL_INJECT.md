# 终端注入接管（Terminal Inject Takeover）

> claude / codex 的「像在电脑上打字一样」接管形态（2026-11-12）。
> 相关：[CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)（hub 后台驱动接管）、[CODEX_DRIVER.md](CODEX_DRIVER.md)、
> pi 注入先例 `integrations/pi-command/command.ts`。

## 一、形态与产品语义

接管（attach）时**先探测终端在场**，按结论三分流：

| 在场结论 | 行为 | 用户可见效果 |
|---|---|---|
| TUI 在场 + 宿主可注入（tmux/kitty/wezterm） | **注入接管**：手机消息像打字一样进真 TUI，由 TUI 自己执行/渲染 | 原窗口实时显示发送内容与回复 =「就像我在电脑上发送一样」 |
| TUI 在场 + 宿主无注入通道 | **409 拒绝**（防与真人 TUI 双写） | 提示用 📱 平行模式，或先在电脑结束该会话 |
| 无 TUI（会话不在任何窗口） | **后台驱动接管**（既有行为，CLAUDE_DRIVER.md） | 电脑不展示，手机收回复 |

产品规则（用户拍板 2026-11-12）：

- **三种 agent 一致**：pi 已有扩展注入（不变）；claude/codex 走本机制；
- **两端都可输入、先后排队**：手机注入和真人打字都进同一输入框，按到达先后生效（= 共用一台电脑）；
- **不在窗口就后台运行**：窗口中途关闭 → 发送时自动降级 hub 后台驱动（`gone → driver.attach + send`）。

## 二、为什么「通用」成立（不绑死终端模拟器）

终端模拟器各自为政（kitty 有 remote control、Alacritty 没有），**注入层不可能一个 API 打天下**。
通用性建立在「统一发现层 + 按宿主分发的注入适配器 + 自动降级」上：

1. **发现层完全通用**（不挑终端）：会话 → 交互 TUI 进程（ps 进程表 + lsof cwd 匹配）→
   读进程环境变量判宿主：
   - `TMUX_PANE` → tmux 通道（**任何终端模拟器通用**：kitty/iTerm2/Alacritty/SSH 都可以）；
   - `KITTY_WINDOW_ID` + `KITTY_LISTEN_ON` → kitty 通道（裸 kitty）；
   - `WEZTERM_PANE` → wezterm 通道。
2. **注入层按宿主适配**（`terminal-inject.ts`）；没有注入通道的终端自动落「后台驱动」或 409。
3. 内核层 TIOCSTI 理论通用但已被现代系统限制/废弃，不依赖。

## 三、注入字节语义（2026-11-12 真机探针验证）

```
\x1b[200~<文本>\x1b[201~\r
 └─ bracketed paste 包裹：内嵌换行留在输入框，不被当回车提前提交
                     └─ 结尾 \r = 真回车（pty ICRNL 转 \n）→ 提交本轮
```

- kitty：`kitten @ --to <socket> send-text --match id:<wid> --stdin`（探针实测 ESC 标记与 \r 原样透传）；
- tmux：`load-buffer`（stdin）→ `paste-buffer -d -t <pane>`（原样灌 pane）；
- wezterm：`wezterm cli send-text --pane-id`（stdin）。
- 真机验收（claude TUI v2.1.311）：文本进输入框、\r 提交为真用户 turn、TUI 原生渲染回复、
  多行粘贴不提前提交。

## 四、实现落点（速查）

| 组件 | 位置 |
|---|---|
| 终端在场发现 | `server/src/adapters/terminal-host.ts`（discoverHost；ps/lsof 解析纯函数可单测） |
| 注入适配器 | `server/src/adapters/terminal-inject.ts`（buildInjectBytes / buildSendPlans / injectMessage） |
| 注入接管注册表 | `server/src/adapters/inject-hub.ts`（probe/tryAttach/send/detach/statusFor） |
| 路由分流 | `server/src/routes.ts` attach 三态、message 注入+降级、detach、rejectIfAttached、stampTerminal |
| 装配 | `server/src/index.ts`（InjectHub 构造 + RouteDeps + WS 冲突并集） |
| 前端形态标识 | `web/src/api/attach.ts`（徽章/状态条文案）、AttachModeMenu/AttachIntroSheet（如实文案） |

关键约束：

- **写者互斥**：注入形态写者恒为 TUI 单点（与真人共用输入框）；无 TUI 时才由 hub 驱动写；
  形态切换先清对方登记（防 driver/inject 双持双写）。TUI 在场无通道时拒绝接管（不与真人 TUI 双写）。
- **发送时重发现**：宿主变化自动跟随（如挪进 tmux）；窗口关闭 → `gone` 信号 → 路由自动降级。
- **v1 限制**：pid↔sessionId 多候选取最近启动并标 `ambiguous`（真 TUI 不持有会话文件句柄）；
  注入模式暂不支持发送图片（400 提示走平行）；abort 需在电脑上操作（TUI 自己持有执行）；
  steer/followUp 语义在注入形态统一即发（排队由输入框天然提供）。

## 五、回归验收清单

1. 手机打开 kitty 里的活跃 claude 会话 → 默认接管为**终端注入**；发消息 → 原窗口像打字一样
   出现、TUI 执行渲染、手机同步看到（真机实测 ✅）
2. 会话不在窗口 → 自动后台驱动接管（原行为不变）；窗口中途关闭 → 下一条消息自动转后台 ✅（路由级测试）
3. 多行/特殊字符消息原样进输入框、不提前提交（真机实测 ✅）
4. tmux 里跑的会话（任何终端模拟器）→ tmux 通道注入（计划级测试；真机未实测，标注见下）
5. 无注入通道的终端里跑的会话 → 409 防双写（路由级测试 ✅）
6. 注入接管期间 parallel 发送 409 ATTACH_ACTIVE；detach 后恢复 ✅
7. 既有回归：server 1058 用例 + web 1061 用例（见交付报告）

**未实测项**：codex 真 TUI 注入（与 claude 同一套发现/注入路径，单测覆盖；机器上无 codex 会话在跑）；
tmux 通道真机注入（适配器计划有单测）；pi 回归仅静态核对（未改动 pi 代码路径）。
