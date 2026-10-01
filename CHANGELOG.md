# Changelog

## Unreleased

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
