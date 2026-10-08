# Agent Hub 路线图：手机端 vibe coding 工具（P0/P1/P2 全量）

> 状态标记：⬜ 待做 / 🔨 开发中 / ✅ 完成 / ⏸ 延后。每批完成后合并到 main 再开下一批。

## 批次 0：UI 基座（✅ 完成）
- ✅ Neobrutalism 野兽派视觉改造（DEV-4-ui）
- ✅ 骨架屏 + 交互动画（并入 DEV-4-ui）
- ✅ 前端 message_end 内容级去重兜底（防重复气泡防御层）

## 批次 1（P0，✅ 完成）

### T1 Git 集成 + Diff 查看 + 文件联动（server+web 垂直）✅
- 会话卡片 git 状态：仓库名、当前分支、ahead/behind、dirty 文件数
- Diff 查看器：语法高亮、移动端缩放友好；git log 时间线、分支列表
- 工具调用卡片文件路径可点击 → 文件内容/语法高亮/diff 弹层
- server：`GET /api/git/status?cwd=`、`GET /api/git/log`、`GET /api/git/diff`、`GET /api/git/branches`、`GET /api/files/content`
- **硬约束：只读**（status/log/diff/show/branches），不提供任何写操作；仓库根路径校验防穿越

### T2 通知中心 + 未读角标 + 运行看板（web 为主）✅
- `agent_settled`/`error` → 应用内横幅 + 提示音 + `navigator.vibrate` 震动
- 未读角标：首页标题/会话卡片"有新动静"标记，进入会话即读
- 通知中心页：按时间聚合的事件流（哪个会话、什么事件、何时）
- 运行看板：running 会话实时进度卡（当前工具、已运行时长、最后输出摘要）
- 会话完结通知可配置（全部/仅我发起/静音）

### T3 全局搜索 + 会话分支树（server+web 垂直）✅
- 全局搜索：跨会话搜消息内容（`GET /api/search?q=`），结果点击直达会话定位
- 会话分支树：JSONL parentId 树可视化（pi /tree 语义），点击节点预览该节点消息
- 树上操作（只读预览先行；fork/clone 批次 3 再放开）

### T4 交互收尾包 + steer 插话 + 快捷指令 + 语音（web）✅（快捷指令除外）
- 交互包：下拉刷新全页覆盖、气泡进场动画、发送 loading 态、长按消息复制、返回列表保持滚动位置
- steer 插话：运行中会话输入框切换"插话(steer)/排队(followUp)"模式
- ~~快捷指令面板~~：首发时移除（插入逻辑迁至 `web/src/utils/insert.ts`），批次 3 以新形态重做
- 语音输入：按住说话大按钮（Web Speech API，HTTP 非安全上下文优雅降级禁用）

## 批次 2（P2，✅ 完成，Web Push 除外）
### T5 系统监控 + 安全 + 离线 + 终端 + 多模态 ✅
- 系统监控卡：CPU/内存/磁盘/电池/负载（`/api/system`，跨平台，单项失败降级 null）
- 应用锁：PWA 打开需 PIN + **WebAuthn 通行密钥解锁**（超出原计划），失败锁定
- 离线队列：断网消息排队，联网自动发送（SW + 队列持久化）
- 真终端入口：ttyd 集成（检测到 ttyd 时提供"打开终端"按钮，web 内嵌）
- 多模态：图片粘贴/上传给 agent
- ⬜ Web Push 锁屏通知（依赖 Tailscale HTTPS 开通，移入批次 3+ 评估）

## 批次 3（当前批次）

### T6 文档收口 + CI 工程化 ✅
- ✅ ROADMAP/CHANGELOG/README 与实际能力对齐（WebAuthn、性能成果等补记）
- ✅ GitHub Actions CI（Node 20/22 × Ubuntu/macOS，build+lint+test 全量守护）

### T7 Token/费用用量统计（pi 源）✅
- pi 会话 JSONL usage 解析聚合（tokens/input/output/cacheRead/reasoning/cost）
- `GET /api/usage` 全局与单会话汇总；工作台今日概览 + 会话卡片展示
- ⏸ claude 源 usage 明确延后（当前只需支持 pi）

### T8 快捷指令面板（prompt 模板）✅
- composer 一键插入常用 prompt 模板（内置 + 自定义，localStorage 持久化）
- 模板管理（编辑/删除/恢复默认）、移动端体验过全局验收基线

### 批次 4（✅ 完成）— 性能与体验收口（含二次 OOM 风险拆除）

### T9 性能修复（审计驱动）✅
- tail 增量解析、claude 清单缓存、scan per-file 快照、Insight 计数化、AgentSession 逐出、Map 淘汰、system/usage 缓存预热
- 实测：live 风暴下 CPU 342%→0.4%、内存 2.5GB→382MB（前置修复 bb01753）；刷新 7.2ms→1.0ms、Insight 驻留 9KB→0.8KB/会话

### T10 UI/UX 改进批 ✅
- 草稿持久化、搜索深链回溯、锁状态机/错误文案、输入语义三件套、Markdown 块缓存、toast/焦点/刷新等杂项

### T11 一键集成 ✅
- Tailscale 检测假阳性修复、npm run remote、npm 发包就绪（npx 冒烟通过）、workspaceRoot 回落

## 批次 3 之后的候选（⬜ 未排期）
- ⬜ Web Push 锁屏通知（HTTPS 依赖解除后）
- ⏸ claude 会话终端接管（双模式对称补全，用户明确延后）→ 已立项见「claude 完整接入」
- ⬜ 树上 fork/clone 操作（T3 预留）
- ⬜ 通知规则细化（按会话/按项目静音）
- ⬜ 会话归档/清理

## claude 完整接入（v0.2 批）

- ✅ 会话六契约（列表/详情/prompt/abort/create/fork）+ stream-json 流式 + 安全约束（manual 权限、不落凭据）
- ✅ 消息级实时旁观：WS tail 按 source 注入 transcript 解析器（终端跑的 claude 会话同样实时）
- ✅ 子代理面板：Task/Agent sidechain 解析 → SubAgentActivityDto（当前工具/输出摘要/运行时长/结果），同 pi 口径
- ⬜ 终端接管模式：tmux send-keys 通用注入通道（做好后 pi/claude/其他 CLI agent 通吃）
- ⏸ token 级 delta（终端 TUI 会话拿不到流式事件，架构限制；server 驱动的 claude 会话已是 stream-json 级）
- ⬜ slash 命令清单 / 上传图片等细节对齐

## 全局验收基线（每个功能都要过）
1. 移动优先视口无横向溢出、触控目标 ≥40px
2. 深浅色双主题可读
3. 测试只增不减；`pnpm -r build/lint/test` 全绿（CI 守护）
4. 安全：git/文件 API 只读 + 路径校验；不泄漏密钥
5. 功能在 HTTP tailnet 环境可用（Web Push 等 HTTPS-only 能力优雅降级）
