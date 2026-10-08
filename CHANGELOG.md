# Changelog

## Unreleased

### claude 完整接入批
- 子代理面板双源化：claude Task/Agent sidechain 解析（parseClaudeTranscript 副产物 subAgents）→ 与 pi 同口径的 SubAgentActivityDto（当前工具/输出摘要/运行时长/结果摘要），GET /api/sessions/:id/agents 自动按 source 分发
- ROADMAP 立项 claude v0.2 批：终端接管（tmux send-keys 通用通道）待做，token 级 delta 标注为架构限制

### 性能与体验（弱网优化批）
- server：@fastify/compress 响应压缩（brotli 优先，体积约 -70%）+ /assets 内容 hash 产物长缓存 immutable（二次打开零请求）
- web：新建会话 ?new=1 深链修复——跨页保留 query（如 ?tab=）+ popstate 同步弹出表单（只开不关），新增 newSessionPath 路由助手与回归测试
- cli：`check` 新增「链路延迟体检」（parseNetcheck/latencyAdvice）：解析 tailscale netcheck 四因子（IPv6 / 对称 NAT / 端口映射 / DERP 绕路）并按优先级给可操作建议；修复跨行空白正则吃掉 PortMapping 空值行的解析 bug
- README（中英）新增「⚠️ 延迟警告」：P2P 直连 vs DERP 中继体验对比 + 三指标健康值表 + `tailscale ping` 直连验证（手机远程慢的根因与自检指引）
- 自启修复：launchd plist / systemd unit 注入 PATH（node 同目录 + homebrew）——nvm/brew 环境下服务内找不到 npm/pnpm 导致自启即失败的通用修复
- 常驻即远程：`setup -- --autostart` 检测到 tailscale 时自启命令自动携带 `--tailscale`（开机幂等重配 Serve，手机通道开箱即连；`--lan` 可覆盖）

### 手机远程方案（headscale / PWA 双路径）
- `--tailscale` 自动识别控制面（`tailscale debug prefs` ControlURL）：官方 → serve HTTPS 自动证书（真 WebAPK）；自建 headscale → tailnet 内 HTTP 回退（headscale 不支持 tailscale cert）并说明 PWA 限制
- Tailscale 状态诊断强化：CLI 崩溃（Trace/BPT trap 等）/ 未登录 / 已停止 分别给出可操作指引，不再误导用户执行 `tailscale up`
- macOS GUI 桥失效（CLIError error 3）时提示 `sudo tailscale serve` 绕行方案（root 直连守护进程，实测有效）
- 新增 docs/HEADSCALE.md + docs/headscale/（docker compose + Caddy）：任意 VPS 半小时自建控制面，含设备接入、排障与真 PWA 三方案
- README 重写「手机远程全流程」：官方免费版 / 自建 headscale / 局域网三路径 + WebAPK HTTPS 前提说明
- README 新增「标准集成链路」章节（真机实测跑通的默认集成方式）：官方 Tailscale 四步流程 + 实测踩坑表（macOS GUI 桥失效的 sudo 绕行、WebAPK 与 HTTP 源、证书开关、手机超时）
- 开源门面：中英双语 README（README.md / README.en.md）+ 真机实拍截图与演示 GIF（工作台 / chat / 多子代理面板 / 双模式 / 应用锁）
- 开源就绪批：GitHub Actions CI（Node 20/22 矩阵，build+lint+test）、issue/PR 模板、测试与证据文件真实域名/用户名脱敏（→ example.com / <user>）

### 开发体验（DX 一键化）
- 新增 `pnpm dev`（cli/dev.js）：一条命令并行起 server tsc --watch + node --watch 热重启 + web Vite HMR，输出按进程加行前缀，Ctrl+C 一次杀全部
- 配置自愈：`dev` / `start` 配置缺失时自动从模板生成 hub.config.json，不再报「配置不存在」退出
- 规避 pnpm 内置 `pnpm setup` 顶掉项目 script 的陷阱（README 注明用 npm run setup），Vite 端口支持 AGENT_HUB_WEB_PORT 指定
- 新增 ecosystem.config.js（pm2 部署：pnpm build && pm2 start）；README 补开发/部署双流程

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
