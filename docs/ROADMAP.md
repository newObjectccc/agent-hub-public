# Agent Hub 路线图：手机端 vibe coding 工具（P0/P1/P2 全量）

> 状态标记：⬜ 待做 / 🔨 开发中 / ✅ 完成。每批完成后合并到 main 再开下一批。

## 批次 0：UI 基座（进行中）
- 🔨 Neobrutalism 野兽派视觉改造（DEV-4-ui，分支 ui/neobrutalism）
- 🔨 骨架屏 + 交互动画（并入 DEV-4-ui）
- 🔨 前端 message_end 内容级去重兜底（防重复气泡防御层）

## 批次 1（P0，UI 合并后并行 4 路）

### T1 Git 集成 + Diff 查看 + 文件联动（server+web 垂直）
- 会话卡片 git 状态：仓库名、当前分支、ahead/behind、dirty 文件数
- Diff 查看器：语法高亮、移动端缩放友好；git log 时间线、分支列表
- 工具调用卡片文件路径可点击 → 文件内容/语法高亮/diff 弹层
- server：`GET /api/git/status?cwd=`、`GET /api/git/log`、`GET /api/git/diff`、`GET /api/git/branches`、`GET /api/files/content`
- **硬约束：只读**（status/log/diff/show/branches），不提供任何写操作；仓库根路径校验防穿越

### T2 通知中心 + 未读角标 + 运行看板（web 为主）
- `agent_settled`/`error` → 应用内横幅 + 提示音 + `navigator.vibrate` 震动
- 未读角标：首页标题/会话卡片"有新动静"标记，进入会话即读
- 通知中心页：按时间聚合的事件流（哪个会话、什么事件、何时）
- 运行看板：running 会话实时进度卡（当前工具、已运行时长、最后输出摘要）
- 会话完结通知可配置（全部/仅我发起/静音）

### T3 全局搜索 + 会话分支树（server+web 垂直）
- 全局搜索：跨会话搜消息内容（`GET /api/search?q=`），结果点击直达会话定位
- 会话分支树：JSONL parentId 树可视化（pi /tree 语义），点击节点预览该节点消息
- 树上操作（只读预览先行；fork/clone 批次 3 再放开）

### T4 交互收尾包 + steer 插话 + 快捷指令 + 语音（web）
- 交互包：下拉刷新全页覆盖、气泡进场动画、发送 loading 态、长按消息复制、返回列表保持滚动位置
- steer 插话：运行中会话输入框切换"插话(steer)/排队(followUp)"模式（契约已支持）
- 快捷指令面板：常用 prompt 模板一键插入（内置 + 自定义，localStorage）
- 语音输入：按住说话大按钮（Web Speech API，不支持时优雅隐藏）

## 批次 2（P2）
### T5 系统监控 + 安全 + 离线 + 终端 + 多模态
- 系统监控卡：CPU/内存/磁盘/电池/负载（server /api/system 扩展，跨平台）
- 应用锁：PWA 打开需 PIN（配合 config auth.token，失败锁定）
- 离线队列：断网消息排队，联网自动发送（SW + 队列持久化）
- 真终端入口：ttyd 集成（检测到 ttyd 时提供"打开终端"按钮，web 内嵌）
- 多模态：图片粘贴/上传给 agent（需先确认 pi SDK content block 支持图片；不支持则降级为文件路径引用）
- Web Push 锁屏通知（依赖 Tailscale HTTPS 开通）

## 全局验收基线（每个功能都要过）
1. 移动优先视口无横向溢出、触控目标 ≥40px
2. 深浅色双主题可读
3. 测试只增不减；`pnpm -r build/lint/test` 全绿
4. 安全：git/文件 API 只读 + 路径校验；不泄漏密钥
5. 功能在 HTTP tailnet 环境可用（Web Push 等 HTTPS-only 能力优雅降级）
