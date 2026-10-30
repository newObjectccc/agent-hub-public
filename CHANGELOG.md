# Changelog

## 0.3.0-beta.3（2026-10-30）pi 模型选择

- 新建 pi 会话可搜索并选择本机已配置的 provider/model；聊天输入框上方显示当前模型，支持空闲时切换，例如 `xai / grok-4.5`。
- 显式选择写入当前会话并在首条消息前恢复，保留上下文与 pi 全局默认值；旧版扁平会话通过 SDK 迁移后续写。原模型不可用时阻止静默跨 provider 回退，失败消息由用户手动重试。
- 切换与发送、SDK 启动互斥，运行中、终端持有和接管期间拒绝切换；模型接口沿用 Bearer 与应用锁保护，只返回 provider/id/name，不返回凭据或网关配置。
- 中英 README、安装排错与 API 契约同步，明确终端 `/model` 的 Enter 仅切会话、Ctrl+S 才保存默认值，以及 Hub 自启动环境与终端配置的区别。

## 0.3.0-beta.2（2026-10-29）公开发布准备

- 统一默认全自动：Codex 平行与接管两通道共用 `never` + `danger-full-access`，与 pi 直接工具执行、Claude `bypassPermissions` 对齐；保留显式继承与收紧档位，配置错拼不回落最高权限，接管核对实际生效策略。

- 显式开启 API 鉴权却漏填 token，以及 auth 字段拼错、类型错误时拒绝启动，保留默认关闭鉴权的私有网络用法。
- 配置读取与权限字段错误在启动前拒绝，修复 `manual` 拼错后回落最高权限的问题；CLI 和 server 的 JSON 错误不再回显配置原文，合法的全自动配置保持可用。
- 更新 Fastify / fast-uri 安全补丁，并固定 SDK 精确依赖中的 Undici 修补版本；npm CLI 发布物增加 shrinkwrap 与真实安装版本检查，避免仅 pnpm 锁文件修复而消费者仍安装旧版本。
- 公开文档去掉维护者本机权限偏好的叙述，明确使用者配置、验证范围与历史隐私清理流程。

## 未发布（2026-10-23）Codex 交互问答 UI 与平行通道可用性

- **Codex 默认通道固化为 📱 平行**（产品规则）：进入会话默认平行继续，与 pi/claude（active-only：电脑上活跃 → 默认接管）刻意区分——Codex 接管有「须先退出桌面 ChatGPT app 对应会话」的写者互斥前提，默认接管几乎必失败。实现为双层硬规则（前端 `attachDefaultWorthy` 对 codex 源短路 + server `stampTerminal` 恒下发 `defaultPolicy: "never"`），`codexDriver.defaultPolicy` 配置保留仅兼容、不影响默认通道；手动切换/pin 仍可接管。模式选择 sheet 对 codex 把「📱 平行继续」标为主按钮（引导与默认一致）。

- **Codex 交互式请求不再「无 UI 直接报错」**：`item/tool/requestUserInput`（工具向用户提问）与 `mcpServer/elicitation/request`（MCP 输入收集）从直接 respondError/decline 改为手机问答卡片（HostRequestCard 新增 `kind: "question"` 模式：逐题渲染问题/选项/自由文本输入，可提交回答或明确拒绝）。应答严格按协议形状 `{"answers":{"<qid>":{"answers":[...]}}}`；**绝不代答**——超时 / turn 终态 / 取消一律 respondError 明确告知模型「用户未回答」，绝不自动选第一项。问题文本走脱敏预览（凭据/秘密不出手机）；`account/chatgptAuthTokens/refresh`、`attestation/generate` 及未知请求保持安全响应、不上手机。
- **Codex 平行通道目录检查豁免**：`codex exec resume` 补 `--skip-git-repo-check`。实测 0.163 下非 git 且非 TUI 信任目录的会话发送 100% 被拒（`Not inside a trusted directory and --skip-git-repo-check was not specified.`，config 的 `trust_level` 条目对 exec 无效），手机端表现为「发送即报错」；该 flag 只豁免入口防呆、不触碰审批/沙箱（`--dangerously-bypass-*` 红线不变）。
- **权限与交互规则**：Codex 的 `inherit` 沿用使用者自己的本机设置，Claude 默认 `claudeDriver.permissionMode: bypassPermissions`；凡仍需用户交互的场景（工具提问 / elicitation）一律给手机 UI，不得出现「需交互但无 UI 直接报错」。

## 未发布（2026-10-22）Claude 默认最高权限

- **Claude 会话默认权限姿态反转**：平行与接管两路径统一由新配置 `claudeDriver.permissionMode` 决定 `--permission-mode`，默认 `bypassPermissions`——手机创建的会话工具自动执行、无人工审批（此前平行路径硬编码 `--permission-mode manual` 强行盖掉用户 settings 的 bypass，手机发消息时需确认的工具一律被拒）。
- 取值：`bypassPermissions`（默认，最高权限）/ `manual` / `default` / `acceptEdits` / `plan`（需确认档位：平行与接管两路径都走手机审批 bridge，同一套审批卡片 UI）/ `inherit`（不下发 flag，沿用 `~/.claude/settings.json` 等 settings 合并判定，含配置缺失/损坏回退挂 bridge 的 fail-safe）。合法档位保留；非法值、拼错/误放字段与非对象 claudeDriver 会拒绝启动（2026-10-29 修复）。
- 实现走官方 `--permission-mode` 档位通道；`--dangerously-skip-permissions` / `--allowedTools` 红线保留不变。bypass 档位不挂权限 bridge；非 bypass 档位手机审批闭环、超时 deny 一律不变。
- UI/文档文案同步诚实化（AttachIntroSheet、README 中英、API_CONTRACT / CLAUDE_DRIVER / ARCHITECTURE / SECURITY）：默认档位下工具调用自动执行且无需人工批准，请只在信任的仓库使用；改回 `manual` 等需确认档位后两路径均恢复手机审批卡片。
- 验证：server 949 + web 983 模拟测试全绿（含新增档位矩阵与危险 flag 红线用例）；真机对照实验（副作用落盘铁证）确认 flag 级 `--permission-mode bypassPermissions` 工具自动执行零拦截、`manual` 档位工具确实被拦（模型会口头编造已执行的输出，验收必须以副作用为准）。

## 未发布（2026-10-23）平行路径手机审批闭环

- **平行（📱）路径补齐手机审批通道**：权限请求登记表从 ClaudeDriverHub 解耦为共享 `HostRequestRegistry`（attach/平行两路径共用），平行 spawn 非 bypass 档位同样挂 MCP permission bridge（`--permission-prompt-tool` + 回连 env）——需确认的操作挂起在手机 HostRequestCard 上批/拒，不再是“工具被 CLI 直接拒绝且无任何提示”。默认 `bypassPermissions` 仍全自动、不挂 bridge（无审批卡片属预期）。
- 权限请求守卫不变：只在「有人在环」（attach 中或平行 run 中）时挂起，未知会话伪造请求一律 deny；run 结束/abort/detach/崩溃/超时一律 deny 收尾（手机卡片同步消失，不等 TTL）。
- 手机刷新/断线重连的 host-requests 兜底拉取不再限接管路径，平行模式的未决卡片同样回来。

## 未发布（2026-10-22）可选 Tailscale 接入

- Tailscale 明确为推荐的可选远程方案；中英 README 与安装指南补充本机、可信局域网和自建网络入口。
- 源码版 `remote` 支持 `--lan` / `--no-tailscale`，自启注册支持 `--no-tailscale` 跳过自动检测；npm Beta.1 保留使用 `start` / `start --lan` 的说明。
- 统一识别 PATH、macOS App 内置 CLI 与 Windows 默认安装路径；macOS 后台调用强制 CLI 模式，缺少客户端时给平台官方安装引导。
- 未登录/已停止的有效 JSON 状态不再因非零退出码被误报为二进制损坏；不再让过期的 Online 标记覆盖已停止状态；修正控制面域名后缀匹配和畸形 URL 处理。

## 0.3.0-beta.1（2026-10-22）npm 首次试用发布

- npm 包内置前后端构建，无需用户安装 Git/pnpm 或现场构建；首次 setup 不再递归安装依赖。
- npm/npx 的配置与应用锁状态保存到 `~/.agent-hub`，更换安装目录与升级后继续保留；源码仓路径不变。
- 保留首次 Serve/HTTPS 授权输出在 stdout 的官方链接；dry-run 不再执行 Serve 配置。
- Node 最低版本与依赖对齐为 22.19；全局 pi CLI 改为可选，Claude/Codex 用户无需安装。
- 修正安装包名、Tailscale HTTPS 首次授权步骤、真实审批验证范围及发布物隐私排除；增加真实 npm 安装、换安装目录、HTTP/WS 和应用锁保留冒烟。
- Beta：另一台电脑、手机实际连接与模型任务由用户继续验收；Tailscale 受控 CLI 测试不能代替跨设备验证。

## 未发布（2026-10-16）Codex 接管 MVP 与兼容性

- 新增 Codex app-server 接管：原生发送/插话、中止、本地排队、手机命令/文件/权限审批、真实图片输入、退出清理和断线快照；默认仅手动接管，保留 native writer 互斥，不自动回退 exec。
- 修复服务重启后手机残留接管选择未恢复握手、发送通道与界面不一致的问题；驱动断开仍保留 Codex 接管选择，可重新点选恢复。跨轮复用审批 ID 也能显示独立卡片。
- 修复前台恢复/重连时旧历史请求覆盖新 WS 完成消息和状态的竞态；快速任务在 HTTP 响应前完成时不再重新显示思考中。
- 新增 codexBin 配置与 CLI/server 只读版本诊断；修复 parallel 的准备竞态、取消、UTF-8/尾帧、图片、状态与解析兼容性。
- 加固实验台：默认只读、显式 --run、独立临时目录、失败非零退出、日志脱敏、完整握手与模拟进程回归；修正文档中过度推断的版本根因、桌面接入和审批协议。
- 验证范围与未完成真机矩阵见 docs/CODEX_DRIVER.md；模拟测试不等于桌面原会话接入已验证。

## 未发布（2026-10-16）手机继续不活跃会话：正确性与性能批

> 场景：会话没有活跃在电脑终端里（无 pi 进程 / 无 claude TUI），从手机 PWA 找到它并继续对话——
> 即默认的 📱 平行继续路径。本批全部改动围绕这条链路的「不丢数据 / 不丢消息 / 失败可见 / 不卡」。

### 修复（P0：正确性、会丢数据/丢消息）
- **pi 平行发送双写闸门**（新错误码 `EXTERNAL_ACTIVE`，409）：此前 `hub.prompt` 的 busy 判定只看 server 内 SDK 实例的 `isIdle`，完全不看外部——终端只要没装 `pi-command` 扩展就是**零保护**，两边同时 append 会让 JSONL 出现同 parent 分叉（一侧消息在 `selectActiveBranch` 回溯下静默不可见），版本迁移触发 `_rewriteFile()`（`openSync(f,"w")` 截断重写）时更会**永久抹掉对方已追加的行**。现按三路信号拦截（终端心跳在线 / live-feed 60s 内有事件 / 文件 mtime 在 60s 静默窗内），`/compact` 同闸门，文案给具体出路。
- **闸门防自锁**（两处实测踩到的坑）：本进程持有 live 实例时直接放行；mtime 判据采用 claude 同口径的 `mtime <= own.at` 比较；并额外记录 `SessionManager.open` 可能触发的迁移重写时刻。否则「手机新建会话后发第一条消息」与「建实例后发第二条」都会被自己的闸门拦死 60s。
- **模型错误不再被吞成「（无内容）」**：pi 的余额耗尽 / `Connection error.` / 上下文溢出都**不抛异常**，只落在 assistant 消息的 `stopReason`+`errorMessage` 上，而 DTO 此前不取这两个字段（实测用户语料里就有 `"You have no credits remaining…"`）。现在实时流式与历史加载两条路径同口径透出 `error{message,kind}`，本轮以错误收尾时 `status=error` 并补发 `error` 事件；`contextOverflow` 给「压缩上下文」一键自救，`aborted` 用中性语气不当报错。
- **「假接管」不再吞消息**：心跳 TTL 是 90s，用户关掉终端后的这 90s 里 `isOnline` 仍为 true → 前端自动接管并提示“终端在线，已默认接管终端” → 消息入队却没人取 → 60s 后一条小字提示 → detach 取消指令，而消息**既不入离线队列也不回落平行**，输入框已清空 = 文本彻底消失。现 server 记录扩展长轮询活性（`POLL_TTL_MS=45s`，比心跳硬得多）并下发 `terminal.responsive`：`attach` 与 `/message` 在**入队前**就拒绝死终端（`ATTACH_UNAVAILABLE`，文案明说“这条消息没有发出去”）；前端 `responsive===false` 不自动接管；`command_ack{ok:false}` 与 `ATTACH_UNAVAILABLE` 都把原文退回离线队列并切回 📱 平行（前者标**手动**重试——无法排除“终端其实执行了、只是回执丢了”，自动重发会重复执行；后者标自动重试——server 入队前就拒了，明确未投递）。
- **中止竞态**：实例建成前点「停止」此前是空操作（`abort` 撞上 `live.get(id)===undefined` 直接 return，任务照样跑完整轮）。现登记中止请求 + 立即恢复 UI + 实例建成后跳过执行。
- **幂等占位期不再伪报成功**：同 `clientMessageId` 的上一次提交还在 flight 时，此前直接回 `accepted:true`（`modeOf` 为 null 时还伪报 `mode:"prompt"`）；若首发最终 409/500，重发方已以为成功 → 消息静默消失。现回 409 `PROMPT_IN_FLIGHT`，前端归入自动重试（幂等键保证不双执行）。
- **浏览器真机验证抓到并修复的三个闸门/保留缺陷**（真实浏览器 + 独立验证实例，非单测能覆盖）：
  1. **闸门被 tail 启发式回写绕过**：WS 握手启动文件 tail，tail 对「只有 user 消息、尚无 assistant 回复」的文件启发式收尾置 idle 并回写 `statuses`；闸门的 own 判据不分来源时会把这个 idle 当成本进程登记 → 同一 60s 窗口内先 409 后 202，消息真的被执行。现 `statuses` 条目带 `source: "own"|"tail"`，闸门只信 `own`，且 tail 回写不覆盖本进程权威登记。
  2. **`live.has` 无条件放行让闸门失效 10 分钟**：abort 只中止 run 不删实例（空闲 10min 才逐出），期间外部写盘完全拦不住。现改为比较「文件 mtime vs 本进程实例最后活动时刻 + 5s 容差」：run 进行中放行（steer/followUp 不自锁），实例空闲后外部写入仍能拦。
  3. **对账先于入队的竞态清掉失败气泡**：发送被拒前 ~10ms 的一次 GET 对账会 reconcile 掉 local-* 占位（那时消息还没入队，既有保留逻辑救不了），队列里的文本因此在界面上没有重试入口。现入队时若占位已不在列表则补回失败气泡（含图片预览重建）。

### 性能（本机真实语料实测：pi 241 文件/284MB、claude 321 文件/145MB、最大单文件 24.9MB）
- **`ensureLive` 移出 HTTP 响应路径**：`createAgentSession` 打开 24.9MB 会话实测**同步阻塞事件循环 ~600ms**，而它此前在 `prompt()` 返回 202 **之前**——手机发一条消息要等半秒才收到受理，且期间所有客户端的 WS/HTTP 集体卡住。改为先受理后建实例（依据：`sweep` 只逐出「已收尾且 isIdle」的实例，故无 live 实例 ⟹ 必然空闲，busy 判定不需等实例）。
- **claude 清单 per-file 快照缓存 + 并发分批**：热扫 **380ms → 6.8ms（~54x）**，6 遍连扫 fileReads 294 → 49；此前每次 5s TTL 过期就全量重读 145MB，会话活跃时被 presence 持续触发。
- **快照缓存按根目录分键**：此前是模块级单一 Map + 按「本次文件集合」全局 prune，两个根目录交替扫描会互相清空缓存（实测每轮都退化成 1150ms 全量冷扫、`cacheHits=0`，连与空目录交替也一样）。现每轮 **5ms**、hits 正常累积（**~230x**）。当前生产未爆只因 search 与 hub 恰好同目录，而 `lineageFileCaches` 早已按目录分键——同代码两种口径，接第二个源就会炸。
- **parallel 路径 delta 节流 + WS 背压**：attach 路径早有 100ms 合并，parallel 却每个 SDK chunk 直接广播一帧，而 parallel 正是本场景走的路。现两条路径共用同一个 `EventThrottle`（防口径漂移）；WS 广播增加背压——单连接 `bufferedAmount` 超 512KB 时丢弃 delta 帧（`message_end` 带完整文本 + 前端按 id upsert，丢了会自动补齐），生命周期事件一律不丢，消掉弱网手机下唯一无上界的内存增长点。

### 体验
- 会话唤醒失败不再统一英文 `internal error`：新错误码 `SESSION_CORRUPT`（409）给中文可行动原因（会话文件损坏 / 已被清理 / 工作目录不存在），并保留原始错误尾巴便于排障。
- 双模式说明 sheet 不再绑「终端在线」——终端离线恰恰是平行模式的主场景，此前最需要知情的人永远看不到说明；并按 source 明示权限真相（pi：bash/edit/write 在电脑上真实执行且**无人工批准**；claude：固定 `manual`，需确认的工具被拒）。
- 错误类提示常驻（发送失败 / 接管失败 / 终端未执行 / 压缩失败），不再 6s 自动消失；普通轻提示保持原样。
- 切后台/锁屏回来立即对账（此前停在旧画面，漏掉的增量要等重连或手动下拉，很容易被当成卡死）。

### 本次验证
- `server` **802 passed / 0 fail**（基线 747，新增 55：外部活跃闸门 14、轮询活性 7、缓存分键 6、节流与背压 9、claude 快照缓存 18、中止竞态 1）；`web` **961 passed / 0 fail**（基线 930，新增 31：错误渲染与分类 14、错误透传 7、假接管与知情权 9、幂等分类 1）。双端 `tsc --noEmit` 干净；cli 84、integrations lint 全绿。
- **浏览器真机验证**（真实浏览器 + 独立验证实例：独立 config/data/端口，未触碰线上 `server/dist` 与 `web/dist`）：
  - 真实历史会话（含 `You have no credits remaining…` / `Connection error.` / `Operation aborted`）→ 错误条正确渲染、原文完整、「（无内容）」清零；aborted 中性语气不带 alert 角色
  - 终端离线打开历史会话 → 双模式说明 sheet 弹出且明示「真实执行且无人工批准」；claude 源给 manual 准确语义
  - 320/390/768 三档视口无横向溢出
  - 双写闸门：mtime 新鲜 → 409 + 常驻 notice + 文本保留为失败气泡（含重试入口）+ 文件未被执行写入；mtime 老化 5 分钟 → 放行；对账后失败气泡不消失
  - 上下文溢出会话 → 「压缩上下文」按钮可点且有反馈
- 性能数字均为改动前后同机同语料实测（脚本走独立 `.tmp-dist`）。

### 已知未做（评估后主动放弃 / 留待后续）
- **详情加载仍全量读大文件**：24.9MB 会话实测 78ms、heapUsed +71MB，而最终只返回 53 条消息（JSON 仅 0.04MB）；`MAX_JSONL_PARSE_BYTES=50MB` 太宽松使尾部窗口分支从未生效。未做原因：尾部窗口会切断 `selectActiveBranch` 的 `parentId` 回溯链，**丢消息的风险高于省字节的收益**；若要做需「窗口不足则向前扩大重读」的渐进策略 + 逐条一致性回归。
- WS `prompt` 通道仍无幂等键（重连重放可双执行）；两台手机并发同一会话缺 per-id 串行闸（`isIdle` 置位前有多个 await，判定窗口存在）。
- `loadClaudeSubAgents` / `loadClaudeSessionMessages` 仍每次全量读盘（单个 transcript 实测最大 10MB），可复用本批的快照缓存。

## 未发布（2026-10-15）会话恢复与消息可靠性

### 修复
- Claude 历史与实时流共用元数据过滤，图片尺寸/坐标提示不再被当成用户消息；旧 `@上传路径` 消息仅从匹配的成功 Read 图片结果恢复预览，排除无关文件和错误结果。
- Claude 平行发送与本地队列保留图片预览；前端对账保留附件，并在临时用户 id 替换为落盘 id 时按文本和时间就近一对一匹配，避免刷新消息时丢图。
- Claude 流式 assistant 沿用原生 `message.id`，与历史和工具结果回填一致；stdout 安全处理 UTF-8/JSONL 分块、无换行尾行与无效 JSON 值，避免中文损坏、丢尾消息或进程异常。
- 平行模式仅为 hub 自有 run 排队；未接管的外部 TUI 忙时三种发送模式均明确返回 `SESSION_BUSY`。异步准备结束后再次检查实际运行状态与最新 mtime，再立即启动，防同会话并发双开；abort 同时取消准备中的请求与未消费队列。
- Claude 接管启动按会话共享，准备计入并发上限，取消后不再启动；准备前及 spawn 前各检查静默窗，降低外部写入冲突风险。外部状态仍是启发式，不提供进程级互斥。
- 接管 init 后保持 idle，发送后 running；result 先结束本轮、保留错误状态，再处理 followUp，常驻进程不再等于工作中。
- Chat 不再把单条 `message_end` 或 5 秒静默当成整轮完成；补查服务端状态，仍运行/查询失败时继续等待，旧查询结果不能覆盖新一轮，settled 不覆盖已有 error。
- macOS 新生成的自启配置默认 `KeepAlive=true`，服务进程退出后自动拉起；旧配置需重新加载。服务重启保留历史，不自动恢复执行。
- 三源会话共用的驱动提示、复制会话说明不再误写成 pi 专属流程，避免在 Claude/Codex 会话中提示执行 `pi --resume`；说明复制只隔离聊天记录，仍共享工作区文件。
- Claude 权限 bridge 选择合并用户、项目及项目本地配置，按更具体配置覆盖并继承未声明字段；修复只读到第一份配置就返回、项目要求审批却因用户 bypass 漏挂 bridge 的问题，增加 5 个权限覆盖回归。

### 文档与发布检查
- 中英 README、架构、API 契约、平台说明、Claude 驱动说明与路线图同步现有实现：旧终端关闭后续聊、两种驱动所有权、忙时排队边界、图片恢复条件、默认接管策略、HTTP/WS 鉴权和应用锁门禁。
- 纠正 Claude 接管忙时普通发送的回执语义：`/message` 返回 202 后通过失败 `command_ack` 报告；平行 `/prompt` 返回 HTTP 409。
- 发布物检查覆盖新增 Claude 驱动/权限协议/元数据过滤/投屏模块及驱动说明，防止 npm 包缺少运行依赖文件。

### 本次验证（2026-10-15）
- 独立 worktree：冻结锁文件安装、全量 build/lint/test 均通过；server 747、web 930（133 文件）、cli 84、pi 扩展 18，共 1779 passed、0 fail。
- 发布物检查通过：25 个关键文件、6 个运行时依赖完整；prod 审计无 moderate/high/critical，仍有包名 `cli` 的 1 条 low（GHSA-6cpc-mj5c-m9rq，workspace 撞名疑似误报）。
- 浏览器使用构建产物与模拟数据验证 320/360/390/430/768/1024 六档无横向溢出、图片加载、导航跳转及权限详情/拒绝交互；390 深浅色截图见 [Claude 驱动说明](docs/CLAUDE_DRIVER.md)。这不替代 CLI 真机权限实验。

## v0.3.0（2026-10-14）claude 接管终端（hub 驱动会话）

### 功能批（claude 接管 / 手机批权限 / tmux 投屏）
- claude 会话「接管终端」（hub 驱动会话形态，docs/CLAUDE_DRIVER.md）：attach 期间 hub 持有长驻 `claude -p --resume --input-format stream-json --permission-prompts host` 进程，手机消息 stdin 注入 = 真用户 turn；三模式映射实测定型（prompt 空闲直发/正忙回执失败、steer=工具间隙真插话、followUp=result 后排队）；abort 走 control interrupt（turn 收尾进程存活）；detach 后电脑 `claude --resume` 无缝接回
- 手机批权限：`--permission-prompt-tool` + MCP bridge（integrations/claude-perm-bridge）回连 hub，权限卡片（允许/拒绝）+ WS `host_request` 推送 + GET host-requests 断线兜底；超时一律 deny；bypassPermissions 环境全自动放行；本次 headless 实验没有 AskUserQuestion，模型以文字提问、手机文字答
- tmux 投屏（D7）：attach 自动创建 `hub-<id8>` 命名 session + 无依赖渲染器（cli/mirror.js，防终端注入），`tmux attach` 实时观看；无 tmux 自动降级；detach 打印 resume 交接提示
- 默认策略（D3 active-only）：Claude 在 `status=running` 或 `lastDrivenBy=terminal` 时默认尝试接管，其他情况默认平行；最后由终端驱动的空闲历史会话也可能默认接管，手动 pin 优先，实际启动仍须通过 server 检查
- 会话内导航条（ConversationNav，K1 Codex 风格刻度时间线）：web/src/components/ConversationNav.tsx + web/src/chat/navTicks.ts——视口指示器 / 悬停预览 / 点击跳转，长会话内快速定位（20 例测试：navTicks 15 + ConversationNav 5）
- 权限协议契约与实验记录（E1-E4 精确 JSON 形状）落 docs/CLAUDE_DRIVER.md

### 加固（并行防双写，D8）
- ClaudeAdapter busy 判定三源并集：本进程 run / hub 驱动接管中 / 外部文件活动；发送前读取最新 mtime，自有显式状态仅在没有更新的外部写入时优先。可避免已检测到的并发驱动，不保证阻止原 TUI 再次输入
- attach 准备前及 spawn 前的 sessionFile 静默窗（默认 3s）：近期外部写入时 409 ATTACH_UNAVAILABLE
- 冲突保护并集：rejectIfAttached 与 WS promptGuard 覆盖 pi 指令队列 + claude hub 驱动

### 修复批（第二轮收口）
- `@fastify/static` v10 setHeaders 契约适配：v10 的 `setHeaders` 回调收 FastifyReply（v8 传原生 res，无 `setHeader`），改用 `reply.header` 写缓存头——上一稿 tsc 编译阻断点清零
- WS upgrade Origin 校验（防跨站 WebSocket 劫持）：upgrade 闸与 HTTP CORS 闸共用 hostTrust/同源判定单一事实源——同源放行，跨域只放 `allowOrigins` 精确白名单（缺省空 = 拒绝一切跨域），反代感知走可信 Host 判定
- WS abort 过应用锁门禁：WS `abort` 此前绕过 promptGuard，锁屏期可中止 turn——补锁屏门禁（同 promptGuard 锁分支判据，但不复用其 ATTACH_ACTIVE 拒绝，接管期 abort 合法且必要）；通过后 hub 驱动接管中走 `driver.abortTurn`（control interrupt，进程存活可续），否则 `hub.abort`（镜像 HTTP `/abort` 语义）
- host-request 已决 409 语义落地：已决 id 短期记忆（TTL 约 5 分钟、上限约 200 条）内重复应答 → 409 `HOST_REQUEST_RESOLVED`，未知 → 404 `HOST_REQUEST_NOT_FOUND`——双重应答/幂等回放不再误报 404
- auth 空 token 告警（该历史行为已在 0.3.0-beta.2 改为拒绝启动）：`auth.enabled=true` 且 `token` 为空（含缺失/非字符串吞成空串）时启动 warnings 告警，防「开了鉴权却形同虚设」静默失守
- web attach 残留自愈：pin=attach 但本次打开接管不可用（claudeDriver.enabled=false 等）时自动回退，不再卡死在 attach 模式
- pack 冒烟补强：`scripts/pack-smoke.mjs` 断言从 8 个关键路径扩到 20 个关键文件 + 6 个运行时依赖声明齐全

### 修复批（本轮收口）
- [blocker] WS 鉴权接线：`WsHub.attach` 改为 opts 选项对象且 `auth` 必填（漏传 = 编译错误，此前可选参数导致生产装配漏传、auth.enabled 时 WS 完全绕过鉴权）；server 新增导出 `attachSessionWs`（封装 promptGuard 锁屏门禁 + ATTACH_ACTIVE 并集 + 从 config.auth 派生 upgrade 鉴权）作为 `startHub` 唯一 WS 挂载路径，鉴权装配断裂在生产同一路径上可回归（ws-auth-wiring）
- claudeDriver 死旋钮接线：`claudeDriver.enabled=false` 时不构造 ClaudeDriverHub（driverBusy / createApp deps / promptGuard / close.disposeAll 全可选链），claude 源 attach 路由回 400「claude 会话接管未启用」前端回落 parallel；`defaultPolicy` 随 `terminal.defaultPolicy` 下发（pi/claude 双通道、列表与详情），前端按策略决策（never=只手动 / always=打开即接管 / 缺省=active-only 容错）
- 发布物三修：根 dependencies 补 `@fastify/compress`（npm 发包后 server/dist 运行期依赖可解析）；files 白名单精确追加 integrations/ 三个源文件（bridge.mjs / pi-command / pi-live-feed，npm pack 实测入包）；`@fastify/static` ^8 升 ^10.1.6（根与 server，4 个 CVE 清零）
- 版本对齐 0.3.0（根 / cli / web / server 四个 package.json 统一）；npx 发包布局（`isPublishedLayout`：双 package.json 缺失 + 双产物在 → 发包布局）跳过依赖安装与构建两步直接启动 server/dist（源码仓布局行为逐字不变）
- CI 加固：矩阵扩为 ubuntu-latest / macos-latest × Node[20,22] 共 4 组合（不加 windows）；build 后通过 `scripts/pack-smoke.mjs` 检查真实发布清单与根运行时依赖；末尾 `pnpm audit --prod --audit-level=high` 检查 high/critical 漏洞

### 当时的验证记录（2026-10-14）
- 自动化：server 722、web 922（133 文件）、cli 84、pi 扩展 18，合计 1746 passed、0 fail；install/build/lint/test/pack-smoke 均通过
- 发布物：当时检查 20 个关键文件、6 个运行时依赖，后续新增检查见上方未发布记录
- 依赖审计：当时 high/critical 门禁通过；完整 prod 审计剩余 1 条 low（GHSA-6cpc-mj5c-m9rq，workspace cli 撞名疑似误报）
- 真机实验：stream-json 多轮注入、权限 allow/deny、工具间隙转向、control interrupt、驱动链路和 tmux 投屏，环境与结论见驱动说明

## v0.2.0（2026-10-10）首个开源版本

### 功能批（国际化 / codex 桌面 app / 首页分源统计）
- i18n 国际化基础设施（轻量自研，零新依赖）：`t()` 插值 + `Intl.PluralRules` 复数 + zh/en 语言包 + MessageKey TS 类型防错 + 漏翻守护测试；设置页语言三态切换（跟随系统/中文/English）持久化 + `<html lang>` 同步；AppShell 菜单/标题示范 key 化（全量提取后续批次）
- codex 桌面 app 会话完整支持：event_msg 活动流（CommandExecution/FileChange/McpToolCall → 工具卡片，parsed_cmd 语义映射 read/write/delete_file）、token_usage_record 用量入账（多根源含归档）、compacted 压缩边界安全、archived_sessions/ 归档扫描（列表尾部 📦 徽章）
- 工作台首页按来源分统计：DashboardStats.bySource（今日消息/今日完成/工作中/等你处理 × pi/claude/codex，细分和=总量）+ 今日概览细分小字 + 工作中/等你处理来源过滤 chips

### 性能（tailnet 慢链路优化批，真机体感问题）
- 弱 ETag 协商缓存：GET JSON 响应带 W/ ETag + no-cache，重复打开命中 If-None-Match → 304 零字节体（二次打开关键优化）；identity 哈希，注册于压缩前
- 会话列表出参瘦身：剥离内部路径 sessionFile（436 会话实测 -57KB 原始载荷；br 后仍 -15KB），create/fork 响应同口径
- /api/system 工具探测 SWR 化：TTL 30s→5min，过期秒回陈旧值 + 后台刷新——CLI 冷探测 0.5~1s 永不阻塞请求（实测 ttfb 1.0s → 2ms）
- 首页概览/用量并行拉取（原串行双往返）；+3 回归测试（ETag 304 / 出参剥离 / SWR 秒回）

### P2 加固批（开源审计清理：稳健/安全 + 资源/性能 + web/a11y）
- [安全] 日志 URL 脱敏（token/secret → [REDACTED]）；uploads/git realpath 二次校验堵 symlink 逃逸；markdown 拒 `//` 协议相对 URL + `\u0000` 占位符伪造剥离；DNS rebinding 防护（Host 白名单，HTTP+WS 双把关）；PIN 锁定跨重启持久化；auth.token 写盘 0600
- [性能] git diff 并发池 + 20s 总超时；tail 内存双窗口 + knownIds 环形去重；statusCache 过期即删 + LRU；codex statuses TTL sweep + fileCache LRU；ws pending 限容 100；hub toolResults 限容 200；SW 旧 hash assets 清理
- [web] fetch 默认 30s 超时（TIMEOUT 友好文案）；unhandledRejection 全局兑底（toast 不裸吞）；a11y：AttachBadge/SystemStatus ARIA 修复、菜单 Esc 焦点归还、Sheet 焦点陷阱全覆盖
- 测试：server 571→613、web 785→794、cli 79→80 全绿

### 开源发布前审计修复批（五维度审计：安全 / 数据一致性 / 错误处理 / 资源生命周期 / 契约，P0 全清 + P1 修复）
- [安全-P0] CORS 不再反射任意 Origin（同源 + config.allowOrigins 白名单，非白名单 403）：堵死「任意网页跨域驱动面板（远程派发 agent 指令）」
- [安全-P0] WS upgrade 鉴权（Authorization / 子协议 / ?token=，与 HTTP 同口径）；WS 连接竞态泄漏修复（连接建立期断连不再泄漏 socket/interval）
- [安全-P1] 锁屏门禁升级为全局 onRequest（HTTP 423/401）+ WS prompt 通道同口径拦截（子协议携带 lock-token，不进 URL/日志）；terminalUnlocked 装配补注入
- [安全-P1] isSafeBindHost 归一化判定（`::0`/`::ffff:0.0.0.0` 等价形全拒）；`--lan` 显式 opt-in（config.allowLan:true，CLI 自动写入）
- [安全-P1] PIN 失败指数退避（5 次起 30s 封顶 15min）+ 令牌滑动续期 + app-lock.json 0600；uploads cwd 限 workspaceRoot/会话 cwd；prompt 幂等键（clientMessageId TTL 10min）；/api/live 收紧；500 固定脱敏 internal error（git 错误不吐 stderr）
- [进程] unhandledRejection/uncaughtException 兑底（日志 + 优雅 close，5s 强退）；shutdown `.catch`→exit(1)
- [数据-P0] claude statuses 添 STATE_TTL 30min sweep（外部 resume 不再被永久压制 idle）
- [数据-P1] rename 状态快照改 stat 实时 mtime（竞态不误登记）；ensureLive per-id 互斥（并发不双开）；tail rewrite 检测（ino+尾部指纹）；tail 吞消息窗口（连接后新消息照常推）；status 事件回写（WS/API 不再分叉）；dashboard 文本 Map 200 LRU；大 JSONL 50MB 尾窗降级；claude/codex tail 熔断降频（pendingReparse 不丢）
- [web-P0] WS 权威回填保留 images（发图不再当场消失，thinking 同口径）
- [web-P1] 流式对账不丢字（取更长文本+尾部保留）；/ws/events 重连补拉；双模式跨设备死锁自愈（ATTACH_ACTIVE→切接管 / ATTACH_REQUIRED→切平行）；sendPrompt 幂等键同键重发
- [web-P2] refresh 序号防护（旧响应不覆盖新数据）；markAllRead 失败回滚；未知事件 dev warn
- 测试：server 525→571、web 731→758、cli 79 全绿

### Codex 接入
- feat(server)：Codex 会话源接入（第三个 source，与 pi/claude 平级）——rollout JSONL 解析（codex-rollout.ts：消息提取 / 工具调用折叠 / 注入包装剥离，损坏行优雅跳过）+ `codex exec resume <id> --json` 本地 spawn 流式驱动（codex-stream.ts：事件流 → 契约 WS 事件）+ abort（SIGTERM→SIGKILL 幂等）/ createSession（最小 rollout）/ forkSession（id 同步替换，原文件只读）
- server：会话列表防全量读盘——TTL 清单缓存 + 文件级 mtime+size 快照缓存（数百 rollout 不重复 parse）+ 8 路并发解析；同一会话跨多个 rollout 分段文件（续写/压缩轮转）按 session_id 归并（计数求和/最新输出/最早命名，详情归并全量历史，tail 盯最新段）；会话名优先 `~/.codex/session_index.jsonl` 的 thread_name，缺失回退首条 user 文本
- server：tail 解析器按 source 分发泛化（ws.ts：claude/codex 各自 loader）；SessionRegistry 三源合并/分发（含 createSession source 路由）
- web：来源徽章 Codex（文案 "Codex"，样式与 pi/claude 同款）、新建会话支持 codex、slash 命令面板标题按 source 泛化
- 测试 +28（codex-rollout 19 + codex-stream 9）：message/function_call/function_call_output/custom_tool_call/损坏行/未知行 fixture + 适配层纯函数（fork 重写 / 新建 rollout / 索引解析 / 分段归并）

### 会话页人体工学重设计（第一批）
- 新建/刷新退出工具栏：➕收进 header 右上（肌肉记忆位，与 drawer/侧边栏同一 ?new=1 深链机制行为一致）；刷新靠下拉手势；h2 重复标题删除——列表净高 +~100px
- 新增来源筛选（pi/claude/codex）：tab 管状态、筛选管来源，正交叠加；行业标准「筛选钮+底部 Sheet 计数 chips+条件条」模式，维度可扩展（工作区/时间预留），不用不占空间
- 空态文案指向新入口；筛选纯逻辑 +8 测试

### 修复（手机真机反馈批）
- fix(server)：会话状态推断「显式 idle 优先」——新建会话/刚 settled 的会话不再被 60s 时间窗口误判 running（实测现象：刚创建的会话进 chat 页即显示「思考中」+ 停止按钮，非默认发送消息，纯状态误判）；hub / claude 双源同口径，sweep 不再秒清 idle 条目（防复现）
- fix(server)：hub.createSession 写盘后失效清单缓存——新建会话立即可见（TTL 窗口内 findSession 查不到新会话的隐患）
- fix(web)：代码块复制按钮移入独立标题栏（.code-head），不再遮挡代码内容（水平滚动/长首行均不被盖）；触屏 44px 热区 + 双主题变量
- fix(server)：forkSession 同口径显式 idle——复制出的新会话进 chat 页误显「思考中」同类缺口（hub/claude 双源）；ChatPage +3 空闲态契约回归（含「不默认发送任何消息」断言）
- fix(server)：带 name 的空会话 fork 500——SDK getLeafId 把 session_info（改名）当消息 leaf，产出无 header 的残缺文件；改为消息 leaf 判定（message/custom_message）+ meta 叶子沿 parentId 回溯，空会话/消息后改名 fork 均安全（+2 回归，修复前 2 红）
- feat(web)：顶部提示手动关闭——NoticeBanner/ToastHost/chat-notice 均补 ✕（44px 热区）+ 横向滑动关闭（≥64px，与下拉刷新零冲突）；已读/已关持久化（localStorage），同条通知刷新不重复弹（含震动/声音）

### Markdown 表格渲染（GFM）
- 轻量渲染器新增 GFM 表格支持（此前裸语法原样输出）：表头/表体、:---: 对齐、\| 转义管道、缺格补空、行内标记；移动端横向滚动容器（页面不横向溢出）
- 流式块级缓存修复：表格块在输入末尾仍可续行，末行检查点会把未定稿表格当定稿块复用（增量与全量不一致）——压掉该检查点，+6 测试含逐字符流式一致性

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
- 新功能：会话改名（手机可维护）——`POST /api/sessions/:id/rename`（空串清名）+ chat 顶栏 ⋯「重命名」Sheet 表单；pi（appendSessionInfo）/ claude（ai-title）双源，codex 明确 400；改名写盘前快照状态防 60s 时间窗误判 running
- 会话页默认 tab 动态回落：等你处理 > 工作中 > 全部（只自动选一次；URL 深链与手动选择永远优先，选中后同步 ?tab= 保持分享一致）
- 会话卡片最近消息预览 2→3 行（虚拟列表行高估算同步 clamp）
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
