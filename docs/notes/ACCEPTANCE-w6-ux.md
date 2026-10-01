# w6-ux 交互体验包浏览器实测证据

> 本文件从 `evidence/w6-ux/README.md` 迁入（开源整备）：验收文字记录与复现 stub 留档于 docs/notes/，
> 文中引用的截图为过程产物，不入库（历史可从 git 记录恢复）。

日期：2026-09-29。工具：ego-browser（Chromium，移动视口 390×844，深/浅色双主题）。
数据源：`w6-ux-stub-server.mjs`（仅取证用的安全 stub：伪造 300 会话 / 120 条消息，
实现与生产一致的 `GET /api/sessions/:id?before=&limit=` 分页；POST prompt 记录请求体
到 `prompt-requests.jsonl`，并经 WS 推送 `status=running` 与 `message_end`）。
**stub 不进任何运行时代码路径**，复现：`node docs/notes/w6-ux-stub-server.mjs`（默认端口 7799，STUB_PORT 可覆盖）。

| 截图/文件 | 验证内容（AC） |
|---|---|
| `01-home-mobile-virtual-list.png` | AC1/AC6：300 会话虚拟列表（DOM 仅 8-13 行，scrollHeight 45003px = 300×150）、野兽派深色、移动视口无横向溢出 |
| `02-session-list-scrolled-window.png` | AC1：滚动后窗口平移（paddingTop 14400px / paddingBottom 28800px，渲染行数恒定 8-12） |
| `03-chat-tail50-lazy-load.png` | AC1：chat 首屏只渲染尾部 50 条（m71..m120）+「↑ 加载更早消息」按钮 |
| `04-chat-load-older-progress.png` | AC1：上滑/点击加载更早一页（50→100，first=m21，仍有按钮；hasMore=false 后按钮消失） |
| `05-longpress-copy-menu.png` | AC2：长按气泡 → 复制菜单（复制文本/关闭） |
| `06-copy-toast.png` | AC2：复制成功 toast「已复制消息文本」 |
| `07-send-loading-steer-mode.png` | AC2/AC3：发送中转圈 + 禁用；运行中模式切换条（⚡自动/💬新消息/✋插话/⏭排队）选中「✋插话(steer)」 |
| `08-quick-command-panel.png` | AC4：⚡ 快捷指令面板（4 内置 + 自定义添加/删除 + localStorage 持久化） |
| `09-quick-insert-into-input.png` | AC4：点击模板插入输入框（可编辑后发送） |
| `10-voice-recording-pulse.png` | AC4/AC6：🎙 按住说话录音中（aria-pressed + 野兽派脉冲动画；触发浏览器麦克风权限请求 = API 真实调起） |
| `11-back-scroll-memory.png` | AC2：chat 返回列表滚动位置记忆（见下方说明） |
| `12-pull-to-refresh-full-page.png` | AC2：下拉刷新覆盖**全页面**滚动区（.app > .ptr），拖过阈值显示「松开刷新」，松手触发 /api/kpi + /api/sessions + /api/system 刷新 |
| `13-home-light-theme.png` | AC6：浅色主题（#fff7e8 米白底）一致、无横向溢出 |
| `prompt-requests.jsonl`（过程产物，未入库） | AC3：REST 请求参数原始记录 `{"text":"...","mode":"steer"}` 与 `{"text":"...","mode":"followUp"}` |

## 控制台/网络核对

- 页面无未解释 console error（stub 环境下唯一的 WS/网络噪声为 stub 自身行为）
- `GET /api/sessions/:id?limit=50` → 尾部 50 条 + `hasMore:true`；`?before=m71&limit=50` → 更早 50 条（与真实 server 一致，见 `server/src/test/paginate.test.ts`、`contract.test.ts`）

## 交互补充说明

1. **滚动记忆**（`11`）：纯 JS 导航（等价真实 SPA 路由）下 scrollTop 9000 → 返回恢复 9000 精确。
   ego-browser 的 `click()` 会用 wheel 把目标滚入视口（惯性），因此用 click 返回时会看到
   9000→8347 的惯性漂移——那是自动化工具副作用，真人手指/点击不受影响（对照实验 D 证实）。
2. **语音**：按住 🎙 触发 Web Speech API（浏览器弹麦克风权限 = 真实调用）；
   `Object.defineProperty` 删除 `SpeechRecognition`/`webkitSpeechRecognition` 后按钮消失、其余按钮保留
   （优雅隐藏）。转写文本进入输入框走 `insertSnippet`（见 `VoiceInputButton.tsx`）。
3. **下拉刷新到顶判定**覆盖：window 滚动区 + 虚拟列表内滚区（`data-ptr-scroll`）+ chat 消息区；
   列表未到顶时手势不生效（防误触）。
4. **动画**：`prefers-reduced-motion: reduce` 仿真后 `animation-duration/transition-duration` 均为
   `0.01ms`（`1e-05s`）——全局尊重系统偏好。
