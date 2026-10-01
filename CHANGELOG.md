# Changelog

## Unreleased

### 性能（二次 OOM 风险拆除）
- 会话 tail 增量解析：字节偏移 + 完整行边界 + UTF-8 安全，活跃长会话不再每 2s 全量重解析（不丢不重有专项测试）
- claude 适配层清单 TTL 缓存 + inflight 去重：单请求全语料扫描 2→0
- scan per-file mtime+size 快照：二次扫描 0 读盘 0 parse；Insight 计数化（不再驻留全量 messages，9KB→0.8KB/会话）
- AgentSession LRU 逐出（20 个 + 10min 空闲 TTL）；feed/statuses/clientSeen/血缘 pending 等 Map 统一淘汰
- /api/system 30s 缓存（原每请求 200ms）、/api/usage 启动预热 + 300ms 限时（原冷启动 2.3s 同步等待）
- 血缘扫描 TTL 快照（原每 10s/连接全目录 readdir）；coalesceDeltas 分片 join；usage spread 循环化

### 体验（UI/UX 改进批）
- 草稿持久化：按会话存 localStorage，刷新/切回自动恢复，30 天清理
- 搜索深链回溯：命中未加载的早期消息时按 before 游标回溯（≤6 页），未命中给轻提示
- 锁状态机修复：解锁失败严格停解锁页（不再误回落设置页）；错误文案友好化 + 重试入口；PIN 输入 readOnly 消除双键盘
- 输入语义：语音 pointer capture（移出=取消不写半句）、Enter 发送启发式 + 组合输入冷却、发送模式粘性保留（复位带提示）
- Markdown 块级缓存：流式回复渲染输出逐字符一致，长文 O(n²)→增量
- toast 去重/上限 3/手动关闭；Sheet 焦点陷阱 + Esc + 焦点归还；PullToRefresh 判定双写；首页 dashboard 失败错误条；reduced-motion 尊重

### 工程化（一键集成）
- Tailscale 检测假阳性修复（崩溃输出不再当版本号，判不可用+修复建议）
- `npm run remote` 一键远程：首次自动 setup + 构建 + start --tailscale（幂等）
- npm 发包就绪（prepared, not published）：bin/files/依赖同步；npx/bin symlink 入口守卫修复（原静默退出）；npm pack 冒烟通过
- workspaceRoot 平台回落（无 ~/Workspace 时回落 home + 提示）

### 新增
- Token/费用用量统计（pi 源）：`GET /api/usage` 全局/单会话/时间窗汇总（tokens/input/output/cacheRead/reasoning/cost），工作台今日概览与会话列表展示；mtime+size 增量对账缓存，不全量重读
- 快捷指令面板：composer ⚡ 一键插入 prompt 模板（10 个内置中英模板 + 自定义增删改，localStorage 持久化，删除/恢复默认两步确认）

### 工程化
- GitHub Actions CI：Node 20/22 × Ubuntu/macOS 矩阵，build + lint + test 全量守护
- docs/ROADMAP.md 状态与实际能力对齐，补批次 3 规划

## v0.1.0（2026-09-30）首个版本

手机 vibe coding 工作站完整能⼒首发。

### 核心架构
- pi / Claude Code 双源会话中枢：`~/.pi/agent/sessions` 与 `~/.claude/projects` 统一纳管
- server（Fastify + WS + pi SDK）+ PWA（React + Vite + Tailwind v4 野兽派紧凑 UI）+ 跨平台 CLI（纯 Node）+ pi 扩展（live-feed / pi-command）

### 会话驱动（双模式）
- 🖥 接管终端：手机消息经指令队列注入终端 pi 进程（`pi.sendUserMessage`），屏幕实时显示
- 📱 平行继续：server SDK 独立驱动，共享上下文
- 心跳在线判定（90s）、指令幂等重投（30s×3）、冲突保护、来源徽章与预期管理

### 实时与面板
- 实时旁观：终端 pi 会话的思维链/流式回复/工具执行（token 级）
- 子代理活动面板：父子血缘识别（100%）、活动卡、轻量血缘扫描、发现即推（≤10s）
- 工作台首页：🔥工作中 / ⚠️等你处理 / 今日概览（真实数据推导）

### Chat 工作页
- 阶段化等待反馈（发送中→思考中→工具执行中→回复中 + 秒表）
- slash 命令面板、@ 文件树多选、上传文件/图片、引用回复、代码高亮/复制
- 发送失败重试、输入自增高、键盘避让、触觉反馈、日期分隔

### 性能
- WS delta 40ms 批处理、消息 memo、长会话尾部锚定窗口化、图片懒加载
- 流式渲染 12-15x、相邻更新 memo 200x、DOM 21x 瘦身；dashboard SWR + 重扫节流
- dashboard git 扫描性能专项：周提交统计 15.79x 提速

### 其它
- Git 只读集成（状态/diff/log/文件联动）、全局搜索、会话分支树、复制会话（fork）
- 通知中心（聚合/已读/横幅/震动）、应用锁（PIN + WebAuthn 通行密钥解锁）、离线消息队列、ttyd Web 终端入口
- PWA 安装/离线壳、Tailscale 远程（TCP 转发）、响应式 320-1024 六档
