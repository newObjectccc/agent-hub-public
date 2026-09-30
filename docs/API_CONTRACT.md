# API 契约（v0，前后端并行开发的唯一接口基准）

> 本文件是 server/ 与 web/ 的强制契约。任何一方不得单方面修改字段名/路径；
> 需要变更时记录到本文件并在合并收口时由主会话统一裁决。

Base URL: `http://<host>:<port>/api`（默认端口 7700）
所有响应 `Content-Type: application/json`。错误统一为：
`{ "error": { "code": string, "message": string } }`，HTTP 4xx/5xx。

## 1. 会话（sessions）

### GET /api/sessions
列出全部会话，**合并两个来源**：
- `source: "pi"`：`~/.pi/agent/sessions/` 全目录扫描（session-format v3 JSONL）
- `source: "claude"`：`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`（Claude Code transcript）

```json
{
  "sessions": [
    {
      "id": "uuid-or-slug",
      "source": "pi | claude",
      "name": "pi-seksun-KPI",
      "cwd": "/Users/me/Workspace/im-production-copy",
      "updatedAt": "2026-02-18T12:00:00.000Z",
      "messageCount": 42,
      "status": "idle | running | error",
      "lastUserMessage": "帮我检查周报 KPI 口径（截断 120 字符）",
      "lastAssistantMessage": "好的，我先查 ETL 水位…（截断 120 字符）",
      "sessionFile": "/Users/me/.pi/agent/sessions/--Users-me-.../2026-02-18_xxx.jsonl",
      "isSubAgent": false,
      "parentSessionId": null,
      "lastDrivenBy": "terminal"
    }
  ]
}
```
排序：`updatedAt` 倒序（跨来源统一排序；同刻按 id 稳定排序）。`status` 由 server 内存中的运行态决定
（本进程启动的 prompt 才可能是 `running`），否则按文件活动推断（60s 内有写盘 = running）。

`source` 为 v0 新增契约字段：列表项与详情里的 `session` 均带该字段；前端按其渲染来源徽章。

`isSubAgent` 为 R3 新增契约字段（列表项与详情里的 `session` 均带）：pi-subagents 派生的
子代理会话为 `true`。识别规则（server 检测）：会话名匹配 `^[a-z0-9-]+#[0-9a-f]{6,}$`
（如 `developer#abc123` / `acceptance-reviewer#f81d33aa`），或入口消息含 pi-subagents
派生特征（system preamble 中的 `<sub_agent_context>` / `<active_agent name=` 等）。
前端按其渲染 🤖“子代理”徽章、分组折叠展示，主会话排前。

`parentSessionId` 为本轮新增契约字段（列表项与详情里的 `session` 均带，可缺省）：pi 会话
header 的 `parentSession`（文件路径）解析出的父会话 id（文件名末段）。pi-subagents 派生
子代理与 fork 分支均带血缘；claude 侧无独立父子会话文件恒 `null`；解析不出为 `null`。
前端按 `isSubAgent && parentSessionId` 将子代理以树形子行挂到父会话下，识别不出的归
“未归组子代理”兜底分组。

`lastDrivenBy` 为驱动来源标注契约字段（列表项与详情里的 `session` 均带，可缺省）：
`"panel" | "terminal"`。`POST /api/sessions/:id/prompt` 接受成功后 server 把会话记入
“面板驱动过”集合（持久化 `data/panel-driven.json`，重启不丢；只增不减，claude 会话同理），
命中即 `"panel"`，否则 `"terminal"`；缺省按 `"terminal"` 容错。语义：手机面板发消息 =
server 进程的 pi SDK 实例驱动**同一会话文件**追加，电脑终端 pi 需 `pi --resume` 重开
才能看到；前端按其渲染 📱 面板驱动 / 🖥 终端驱动 徽章与预期提示条。

### GET /api/sessions/:id
会话详情 + **active branch** 的消息历史（渲染 chat 用）。

**分页查询参数（v0 契约补充，chat 消息懒加载用）：**

| 参数 | 说明 |
|---|---|
| `limit` | 页大小（整数 1..500，缺省 50）。带 `before` 或 `limit` 任一即进入分页模式 |
| `before` | 游标 = 上一页最早一条消息 `id`；返回该 id **之前（不含）** 的最近 `limit` 条 |

- **不带任何查询参数**：保持 v0 行为，返回 active branch 全量消息（`hasMore=false`、`nextBefore=null`）
- `?limit=50`：返回尾部 50 条（首屏）；`?before=<id>&limit=50`：上滑加载更早一页
- `before` 游标不存在时退化为尾部窗口（客户端按 id 去重合并，幂等安全）
- `limit` 非法（非整数 / <1 / >500）→ 400 `INVALID_REQUEST`

```json
{
  "session": { "...同列表项..." },
  "messages": [
    {
      "id": "entry-id",
      "role": "user | assistant | toolResult | custom",
      "timestamp": 1733234401000,
      "text": "纯文本/markdown 原文",
      "thinking": "思维链全文（assistant 的 thinking 块，无则 null）",
      "toolCalls": [
        { "name": "bash", "summary": "ls -la", "status": "pending|running|done|error", "resultPreview": "…" }
      ]
    }
  ],
  "hasMore": false,
  "nextBefore": null
}
```
说明：`role` 与 pi session-format v3 对齐；toolResult 消息折叠进产生它的 assistant 消息的 `toolCalls[]`。
`messages` 仅含 active branch（树结构选活跃叶到根的路径）。
`hasMore` = 本页之前是否还有更早消息；`nextBefore` = 下一页 `before` 游标（本页最早一条消息 id），
无更早消息时为 `null`。

claude 会话（`source: "claude"`）返回同构映射后的消息：transcript 的 user/assistant/tool_result
映射到 `user`/`assistant`/`toolResult` role；同 `message.id` 的 assistant block 行聚合为一条消息，
`tool_use` 聚合为 `toolCalls[]`（`tool_result` 折叠回填 status/resultPreview）；thinking 跳过；
`ai-title` 行作为 `name`；不识别的行/块优雅跳过。
`thinking` 服务端保证不省略（无思维链为 `null`）；客户端兼容旧数据缺省（视为无思维链）。
### POST /api/sessions
新建会话。请求：`{ "cwd": "/abs/path", "name": "可选", "source": "pi | claude（可选，缺省 pi）" }`
响应 201：`{ "session": { ...列表项... } }`

- `source` 缺省/空 → `"pi"`；非法值 → 400 `INVALID_REQUEST`。registry 按 source 分发到对应适配器。
- `source: "pi"`：落盘 session-format v3 JSONL header（原 v0 行为）。
- `source: "claude"`：**创建空白 transcript 会话文件**（新 UUID，`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`，
  含一条 `isMeta` 占位行 + 可选 `ai-title` 行；解析后消息数 0，chat 显示空会话）。
  首条消息走既有 `claude -p --resume <id>` 流程。
  > 实测（claude 2.1.267）：空文件 `--resume` 报 `No conversation found`；含 isMeta 占位行的合成
  > transcript 可正常 resume 并向同一文件 append。故“新建”= 合成空白会话文件，而非“引导首条消息才建会话”。
- `cwd` 必须是绝对路径（否则 400 `INVALID_CWD`），且必须存在（否则 400 `INVALID_CWD`）。

### POST /api/sessions/:id/fork
复制会话（fork）：基于某会话的**完整上下文**生成独立新会话（新 id/新文件，继承 source、
cwd、消息历史；**原会话文件只读，完全不受影响**，新旧会话可各自独立继续工作）。请求体忽略（留空 `{}`）。
响应 201：`{ "session": { ...列表项（新会话）... } }`；会话不存在 → 404 `SESSION_NOT_FOUND`。

- `source: "pi"`：pi SDK `SessionManager.createBranchedSession(leafId)`（与 pi `/fork` 命令同一实现），
  从 **active branch 末尾** fork 新 JSONL 文件：header 带 `parentSession` 血缘指向原文件，
  root→leaf 消息链完整重链（id/parentId 保留）；无 assistant 消息的分支由 server 兑底立即写盘。
- `source: "claude"`：server 侧把 transcript 文件复制为**新 UUID** 的会话文件（行内 `sessionId`
  同步替换为新 id，消息 `uuid/parentUuid` 链原样保留），后续 prompt 走 `claude -p --resume <new-id>`。
  实测：fork 后新会话独立 append，原文件字节不变。
- 名称随上下文继承（pi 的 `session_info` / claude 的 `ai-title` 均在复制范围内）。

### POST /api/sessions/:id/prompt
发送消息。`mode` 语义与 pi SDK 一致：
- `"prompt"`（默认）：空闲时发送；**会话正忙且未指定 mode 时返回 409** `SESSION_BUSY`
- `"steer"`：插入当前运行之后（转向）
- `"followUp"`：排队到当前 run 结束后

请求：`{ "text": "消息内容", "mode": "prompt|steer|followUp" }`
响应 202：`{ "accepted": true, "mode": "..." }`
实际输出走 WebSocket 事件流。

claude 会话：server 本地 spawn
`claude -p <text> --resume <session-id> --output-format stream-json --verbose --include-partial-messages --permission-mode manual`，
解析 stream-json 事件映射到 §4 WS 事件；`steer`/`followUp` 降级为排队（run 结束后自动发送）；
安全默认：`--permission-mode manual`（覆盖用户 settings，不可无人确认执行破坏性操作），
不使用 `--dangerously-skip-permissions` / `--allowedTools`。

### POST /api/sessions/:id/abort
中止当前运行（claude 会话：杀 spawn 的子进程）。响应 200：`{ "aborted": true }`（空闲时也返回 true，幂等）。

### POST /api/sessions/:id/compact
手动压缩上下文（仅 pi 会话；claude 会话返回 400 `INVALID_REQUEST`，由其自身 autocompact 管理）。响应 200：`{ "ok": true }`。

### GET /api/search
跨全部会话搜消息文本（大小写不敏感子串匹配，无需全文索引）。
查询参数：`q`（必填非空，否则 400 `INVALID_REQUEST`）、`limit`（可选，默认 50，钳制到 1..100）。

```json
{
  "results": [
    {
      "sessionId": "uuid-or-slug",
      "sessionName": "pi-seksun-KPI",
      "messageId": "entry-id",
      "role": "user | assistant | toolResult | custom",
      "snippet": "…前文[[命中词]]后文…",
      "timestamp": 1733234401000
    }
  ]
}
```
说明：
- 搜索范围 = 各会话 **active branch** 消息文本（与 `GET /api/sessions/:id` 的 `messages` 一致，保证点击直达可定位）；toolResult 已折叠进 assistant 的 `toolCalls`，不参与文本搜索。
- `snippet` 为命中词前后各 ~60 字符的摘要，**命中词以 `[[`…`]]` 包裹**（多处命中全部标记；前端渲染为高亮），截断处加 `…`。
- `messageId` 为命中消息的 entry id（chat 页精确锚点，配合 `?q=` 使用）。
- `timestamp` 毫秒为 pi 原始值；结果按 `timestamp` 倒序，最多 100 条。
- server 侧内存索引缓存：会话文件变更（presence 回调）或 TTL 60s 后重建。

### GET /api/sessions/:id/tree
会话分支树（从 JSONL entry 的 `id`/`parentId` 构树，pi `/tree` 语义）。会话不存在 → 404 `SESSION_NOT_FOUND`。

```json
{
  "entries": [
    {
      "id": "entry-id",
      "parentId": "parent-entry-id | null",
      "role": "user | assistant | toolResult | custom | system | other",
      "text": "摘要文本（80 字符截断）",
      "timestamp": 1733234401000,
      "hasChildren": true
    }
  ],
  "activePath": ["entry-id", "…"]
}
```
说明：
- `entries` 含**全部** entry（toolResult/usage 等也是真实树节点，跳过会断开父子链），按**先序 DFS**排列（同级按 `timestamp` 升序），前端按顺序渲染缩进树。
- `role`：`message` entry 取 `message.role`（含 `system`）；`custom_message` → `custom`；其余 entry 类型 → `other`。
- `text`：消息文本摘要；无文本的 assistant 用 `[tool] <工具摘要>` 占位；compaction/branch_summary/model_change/usage 等带 `[类型]` 前缀。
- `activePath` = 当前活跃分支到根的 id 路径，**root→leaf 顺序**（与 `messages` 顺序一致）。
- 防御：v1 线性文件（无 `id`/`parentId`）按顺序补 `anon-<i>` 成链；悬空 `parentId` 的节点视为根。

## 2. 系统状态（system）

### GET /api/system
```json
{
  "platform": "darwin | win32 | linux",
  "pi":   { "available": true,  "version": "0.87.1" },
  "claude": { "available": true, "version": "2.1.267" },
  "tmux": { "available": true,  "version": "3.4" },
  "ttyd": { "available": false, "version": null },
  "claude": { "available": false, "version": null },
  "tailscale": { "available": true, "loggedIn": true, "hostname": "my-mac" },
  "sessionDir": "/Users/me/.pi/agent/sessions",
  "workspaceRoot": "/Users/me/Workspace",
  "metrics": {
    "cpu": { "usagePercent": 42.5, "cores": 10 },
    "memory": { "usedBytes": 8589934592, "totalBytes": 17179869184, "usagePercent": 50 },
    "disk": { "usedBytes": 429496729600, "totalBytes": 1024000000000, "usagePercent": 47, "mount": "/" },
    "loadavg": [1.5, 1.2, 0.9],
    "uptimeSeconds": 90060,
    "sampledAt": "2026-02-18T12:00:00.000Z"
  }
}
```
`available:false` 不是错误——前端展示为"可选增强未安装"。`claude` 为 CLI 探测（可选增强）。

`metrics` 为 R3 新增契约字段（真实系统指标）：

- `cpu.usagePercent`：两次 `os.cpus()` times 采样差分的使用率百分比（0..100，1 位小数）；
  采样失败为 `null`。`cores` 为核心数。负载均值与 CPU 使用率**并存**（`loadavg` 另给）。
- `memory`：`os.totalmem` / `os.freemem`（used = total - free），全跨平台，单位字节。
- `disk`：项目所在盘（POSIX 解析 `df -k <workspaceRoot>`；Windows 用 `wmic logicaldisk`
  按 workspaceRoot 盘符过滤）。采集失败整体为 `null`。
- `loadavg`：`os.loadavg()` 1/5/15 分钟均值；Windows 无负载均值 → `null`。
- `uptimeSeconds`：`os.uptime()` 系统运行时长秒。

**降级契约**：任一指标单项失败只降级该项（`null`），`metrics` 整体采集失败为 `null`，
均不影响工具探测字段，`/api/system` 永不因指标采集挂掉。前端按 `null` 显示 `—`/
“不可用”，不显示假数字。

## 3. KPI（通用卡片，不与任何业务系统耦合）

### GET /api/kpi
读取 `config/kpi-sources.json`（用户可编辑），每个 source 由 server 拉取/计算后归一化：

```json
{
  "cards": [
    {
      "id": "seksun-weekly",
      "title": "Seksun 周报 KPI",
      "value": "98.2%",
      "trend": "up | down | flat | unknown",
      "delta": "+0.4%",
      "updatedAt": "2026-02-18T12:00:00.000Z",
      "link": "https://app.example.com/...",
      "error": null
    }
  ]
}
```
`config/kpi-sources.json` 结构：
```json
{
  "sources": [
    { "id": "seksun-weekly", "title": "Seksun 周报 KPI",
      "type": "http-json", "url": "https://…/api_v2/traceability/seksun-kpi/weekly",
      "headers": {}, "jsonPath": "$.data.completionRate", "unit": "%",
      "link": "https://app.example.com/" }
  ]
}
```
拉取失败时单卡片返回 `error` 字段，不影响其它卡片。server 每 5 分钟刷新缓存。

> **状态（2026-02 W4）**：KPI 已从首页移除（用户决策：无意义）。
> `/api/kpi` 与 `config/kpi-sources.json` **保留**（接口契约不动，第三方可继续用），
> 但 web 前端**不再渲染**任何 KPI 区块。

## 4. 首页工作台统计（dashboard）

### GET /api/dashboard/stats
首页工作台统计：数字全部从会话扫描真实推导（无占位）。

```json
{
  "working": 1,
  "needAttention": 2,
  "todayDone": 3,
  "todayMessages": 24,
  "weekCommits": 17,
  "streak": 5,
  "weekMessages": 96,
  "weekDone": 4,
  "todayDoneSessions": ["uuid-1"],
  "workingSessions": [
    {
      "id": "uuid-1", "name": "pi-seksun-KPI", "cwd": "/Users/me/Workspace/x",
      "status": "running",
      "startedAt": "2026-02-18T11:30:00.000Z",
      "currentTool": "bash: pnpm test",
      "lastOutput": "测试全绿…（截断 120 字符）",
      "updatedAt": "2026-02-18T11:58:00.000Z"
    }
  ],
  "attentionSessions": [
    {
      "id": "uuid-2", "name": null, "cwd": "/Users/me/Workspace/y",
      "status": "idle", "reason": "settled",
      "summary": "已完成，等你确认…（截断 120 字符）",
      "updatedAt": "2026-02-18T10:05:00.000Z"
    }
  ]
}
```

字段口径（v0）：
- `working`：`status=running` 的会话数（现有 status 机制，含文件活动推断）
- `needAttention`：`reason=error`（无时间窗）∪ `reason=settled`（agent 干完等你输入，
  最后一条 user/assistant 消息是 assistant，且 24h 内更新过）
- `todayDone`：今日 `agent_settled` 次数（从消息时间推 run 边界：assistant 消息后随
  user/custom 或为末条且会话非 running；steer 插话会把一轮切成多段，v0 按边界近似计数）
- `todayMessages` / `weekMessages`：今日 / 本周（周一起，本地时区）的 user+assistant 消息数
- `weekCommits`：`workspaceRoot` 下 git 仓库（自身+子孙，含 worktree）
  `git rev-list --count --since=<本周一> HEAD` 求和；无 git/无仓库 → 0
- `streak`：连续活跃天数（活跃 = 当天有 user/assistant 消息；以最近活跃日为终点，
  今日未活跃不渐裂）
- `weekDone`：本周内至少完成一轮的会话数；`todayDoneSessions`：今日完成一轮及以上的会话 id（前端 tab 过滤用）
- `workingSessions`：运行看板卡（当前工具摘要 = 最近一次工具调用 summary；
  `startedAt` = 当前 run 起点，即最后一条用户消息时间）

列表卡片最多 20 条（数字为全量计数）。响应字段不得省略。

> **状态分类边界**：外部（文件 tail 观察的）会话 status 仅有 `running|idle`（按文件活动推断），
> `error` 分类仅覆盖本进程运行态且进程重启后丢失；历史出错但已静默 >60s 的外部会话归入「干完了」。

## 5. 通知（notifications）

### GET /api/notifications
从会话事件聚合的最近 50 条通知（时间倒序）：

```json
{
  "notifications": [
    {
      "id": "uuid-1:settled:2026-02-18T11:05:00.000Z",
      "sessionId": "uuid-1",
      "sessionName": "pi-seksun-KPI",
      "kind": "settled",
      "text": "已完成…（截断 120 字符）",
      "timestamp": "2026-02-18T11:05:00.000Z",
      "read": false
    }
  ],
  "unreadCount": 1
}
```

`kind` 语义：
| kind | 含义 | 来源 |
|---|---|---|
| `settled` | agent 本轮工作结束（干完等你） | `agent_settled` 事件 / 历史扫描回填 |
| `error` | 运行出错 | `error` 事件 / status=error 回填 |
| `steering` | 会话被插话/排队（steer/followUp） | hub 运行活动 |
| `done` | 手动中止本轮运行（abort） | hub 运行活动 |

- 通知 id 确定性（`sessionId:kind:timestamp`）：重启后历史回填 id 不变，read 标记持久有效。
- 同会话同 kind、时间相差 ≤5min 的条目视为同一次事件（live 与历史回填去重），保留文本更丰富的一条。
- 历史回填：settled/error 的会话自动浮出（含最后输出摘要）。

### POST /api/notifications/read
全部已读（read 标记持久化到 JSON 文件 `data/notifications-read.json`，无 DB）。
响应 200：`{ "ok": true, "unreadCount": 0 }`。之后新增的通知仍为未读。

## 6. WebSocket 事件流

### WS /ws/sessions/:id
连接即进入"订阅"模式：server 推送 pi 会话事件（与 pi JSON event stream 语义对齐）。

server → client（每条一个 JSON 对象）：
| type | 字段 | 说明 |
|---|---|---|
| `session` | `id, cwd` | 连接后首条，握手确认 |
| `message_start` | `message: {id, role, timestamp}` | 消息开始 |
| `text_delta` | `messageId, delta` | 流式文本增量 |
| `thinking_delta` | `messageId, delta` | 流式思维链增量（累积到消息 `thinking` 字段） |
| `tool_start` | `messageId, toolCall: {name, summary}` | 工具开始 |
| `tool_end` | `messageId, toolCall: {name, summary, status, resultPreview}` | 工具结束；`status:"running"` 时为执行中快照（`resultPreview` 为部分结果，前端按 `name` 合并进同一工具卡） |
| `message_end` | `message: {同 GET 详情的 message 结构（含 thinking）}` | 消息完成（权威数据） |
| `agent_settled` | — | 本轮工作全部结束（UI 恢复输入框） |
| `status` | `status: "idle\|running\|error"` | 状态变化 |
| `error` | `code, message` | 运行期错误 |
| `attach_state` | `attached, terminalOnline` | 终端驱动状态变化（§12：接管建立/失效） |
| `command_ack` | `commandId, ok, error` | attach 指令回执（成功/失败原因） |

client → server（可选，替代 REST）：
| type | 字段 |
|---|---|
| `prompt` | `text, mode` |
| `abort` | — |
| `ping` | —（保活，server 回 `pong`） |

断线重连：client 指数退避重连；重连后通过 `GET /api/sessions/:id` 全量对账（不做增量恢复，v0 简化）。

> 两个 source（pi / claude）事件形状完全一致；claude 会话的流事件由 server 解析
> `claude --output-format stream-json` 后映射（text_delta / tool_start / tool_end /
> message_end / agent_settled / status / error），tail 场景由 transcript 解析器 diff 新消息补齐。

## 5. 约定
补充：
- 文件 tail 推断的外部会话 run 结束（静默 60s）同样发 `agent_settled` + `status:idle`
  （"本轮工作全部结束"语义一致，供通知聚合与 UI 恢复输入框）。
- hub 运行活动（steer/followUp 插话、abort 中止）内部上报给通知聚合，不新增 WS 事件类型。

### WS /ws/events（全局频道）
连接即订阅全局广播，首条握手 `{"type":"session","id":"events","cwd":""}`。

server → client：
| type | 字段 | 说明 |
|---|---|---|
| `sessions_changed` | — | 任一会话文件落盘/删除（presence 扫描） |
| `session_status` | `sessionId, status` | 会话运行状态变化（首页运行看板实时刷新） |
| `notification` | `notification: NotificationItem` | 新通知（横幅/震动/声音/未读角标） |
| `pong` | — | ping 响应（保活） |

## 7. 约定
- 时间一律 ISO 8601 UTC（`timestamp` 毫秒为 pi 原始值）。
- 所有列表字段缺省 `[]`，对象缺省 `null`，不得省略字段。
- 端口、session 目录、workspace root 可由 `config/hub.config.json` 覆盖。

## 6. Git 与文件（只读，硬约束）

> **只读硬保证**：server 只调用只读 git 子命令（rev-parse/status/log/diff/show/branch/rev-list），
> **不提供**任何写操作（commit/checkout/push/…）；`file`/`path`/`commit` 参数全部校验：
> 路径 resolve 后必须在仓库根内（防穿越），commit/ref 走白名单正则（防选项注入）；
> git 命令一律 `execFile` 数组传参（无 shell），输出有大小上限。
>
> `cwd` 必须是绝对路径且存在 `.git`（普通仓库目录或 worktree 文件），否则统一
> **404** `{"error":{"code":"NOT_REPO","message"}}`。

### GET /api/git/status?cwd=

分支名、ahead/behind、dirty 文件列表、仓库根（`git rev-parse --show-toplevel`）。

```json
{
  "cwd": "/Users/me/Workspace/demo",
  "root": "/Users/me/Workspace/demo",
  "branch": "main",
  "detached": false,
  "upstream": "origin/main",
  "ahead": 2,
  "behind": 0,
  "dirty": [
    { "path": "server/src/git.ts", "status": "M", "origPath": null },
    { "path": "new.txt", "status": "??", "origPath": null },
    { "path": "new.ts", "status": "R", "origPath": "old.ts" }
  ],
  "dirtyCount": 3
}
```

说明：`status` 为 porcelain 状态字母（`M`/`MM`/`A`/`D`/`R`/`??`…，已去空格）；
rename/copy 取新路径放 `path`，旧路径放 `origPath`。无 upstream 时 `upstream:null` 且
`ahead/behind` 为 0；detached HEAD 时 `detached:true`，`branch` 回退短 hash。

### GET /api/git/log?cwd=&limit=

提交列表（`limit` 钳制到 1..100，缺省 20；`hash` 为短 hash）。

```json
{
  "commits": [
    {
      "hash": "abc1234",
      "author": "peter",
      "authorDate": "2026-02-18T12:00:00.000Z",
      "relativeTime": "2小时前",
      "subject": "feat: git 集成"
    }
  ]
}
```

### GET /api/git/diff?cwd=&file=&commit=

unified diff 原文。`file` 省略 = 全部变更；`commit` 省略 = 工作区（`git diff HEAD`），
指定时看某提交的 diff（`git show --format= --patch`）。

```json
{
  "root": "/Users/me/Workspace/demo",
  "file": "src/foo.ts",
  "commit": null,
  "truncated": false,
  "diff": "diff --git a/src/foo.ts b/src/foo.ts\n…"
}
```

说明：`truncated:true` 表示 diff 超过 512KB 已截断；`file` 越出仓库根 → 400
`INVALID_PATH`；非法 `commit` → 400 `INVALID_REQUEST`。

### GET /api/git/branches?cwd=

```json
{
  "branches": [
    { "name": "main", "current": true, "upstream": "origin/main" },
    { "name": "feat/w3-git", "current": false, "upstream": null }
  ],
  "current": "main"
}
```

### GET /api/files/content?cwd=&path=

文件纯文本内容（语法高亮由前端做）。上限 256KB（超出 `truncated:true`）；
二进制文件 → 400 `INVALID_FILE`；不存在/目录 → 404 `FILE_NOT_FOUND`；
`path` 越出仓库根 → 400 `INVALID_PATH`。

```json
{
  "root": "/Users/me/Workspace/demo",
  "path": "src/foo.ts",
  "size": 1234,
  "truncated": false,
  "content": "export const a = 1;\n"
}
```

### 错误码（本节新增）

| code | HTTP | 含义 |
|---|---|---|
| `NOT_REPO` | 404 | cwd 非绝对路径 / 不存在 / 无 `.git` |
| `INVALID_PATH` | 400 | 路径穿越（resolve 后越出仓库根） |
| `INVALID_REQUEST` | 400 | 非法 commit/ref 参数 |
| `INVALID_FILE` | 400 | 二进制文件不支持预览 |
| `FILE_NOT_FOUND` | 404 | 文件不存在 / 是目录 |
| `GIT_FAILED` | 500 | git 命令执行失败 |
## 6. pi 实时旁观接入（live ingest，2026-02 新增）

### POST /api/live/:sessionId

pi 扩展 `integrations/pi-live-feed/live-feed.ts` 把**任意终端 pi 会话**的实时事件流
（思维链/流式回复/工具执行，token 级）推给 server，server 转成 §4 的 WS 事件广播到
`/ws/sessions/:sessionId`。fire-and-forget 语义：扩展侧失败静默，server 侧坏数据丢弃，绝不 500。

请求体（三种形态等价）：

```json
{ "events": [ { "type": "text_delta", "messageId": "live-1-…", "delta": "你" } ] }
```

事件对象即 §4 的 server→client 事件子集：`message_start` / `text_delta` / `thinking_delta` /
`tool_start` / `tool_end`（含 `status:"running"` 执行中快照）/ `message_end`（message 含 `thinking`）/
`agent_settled` / `status`。未知 `type`、缺关键字段的条目静默丢弃。

响应 202：`{ "accepted": <接受条数> }`。

鉴权：`config/hub.config.json` 的 `auth.token` **非空**时校验 `Authorization: Bearer <token>`
（401 `{error:{code:"UNAUTHORIZED"}}`）；为空则放行（tailnet 内网场景）。扩展侧通过环境变量
`AGENT_HUB_LIVE_TOKEN` 提供 token。

server 行为：

- 首个 live 事件将该会话标记为 live（10 分钟活跃窗口）：停掉/不再启动文件 tail，
  防止 tail 与 live 双推送产生重复气泡。
- 同一会话已由本进程 SDK 接管时丢弃 live 事件（SDK 流是权威源）。
- `text_delta`/`thinking_delta` 按会话做 100ms 节流合并广播；生命周期事件即时广播并保序。
- 扩展侧地址可用 `AGENT_HUB_LIVE_URL` 覆盖（默认 `http://127.0.0.1:7700`）。
## 8. Slash 命令清单（GET /api/commands）

chat 输入区 `/` 触发命令面板：server 按 source 分发命令清单（内置 + 自定义）。
发送时 `/cmd args` **原样**作为 prompt 文本走 §1 的 prompt 通道，但注意（真实 CLI + SDK 实测）：

- **pi**：SDK `prompt()` 只处理 extension 命令、`/skill:name` 与 prompt template
  （sdk.md："prompt() handles extension commands"）；**内置会话命令不处理**（实测 `/name test`
  被当普通消息发给模型）。因此 pi 内置命令全部标注 `terminalOnly:true`（UI "仅终端可用"），
  唯一例外 `/compact [instructions]`——prompt 路由特判转发官方 SDK `session.compact(instructions)`，
  响应 `202 {"accepted":true,"mode":"prompt","handled":"compact"}`。
- **claude**：自定义命令（~/.claude/commands/*.md）`claude -p` 会展开执行；内置命令 print 模式
  不可用（实测 `claude -p "/help"` → "/help isn't available in this environment."，`/compact` `/clear`
  静默无输出），UI 按 `terminalOnly` 标注"仅终端可用"并给降级提示。

### GET /api/commands?source=pi|claude

`source` 缺失或非 `pi|claude` → 400 `INVALID_REQUEST`。

```json
{
  "source": "claude",
  "commands": [
    { "name": "/clear", "description": "清空会话上下文", "builtin": true, "terminalOnly": true },
    { "name": "/e2e", "description": "打开页面并验证", "builtin": false, "terminalOnly": false }
  ]
}
```

说明：
- `pi`：返回 pi 内置清单（pi 文档 slash-commands.md 全量：/resume /new /compact /fork /tree /
  /export /session /name /bug /model /thinking …）；除 `/compact` 外全部 `terminalOnly:true`
  （见上文实测结论）。
- `claude`：内置清单（/clear /compact /config /cost /help /model /mcp …，全部 `terminalOnly:true`）
  + 扫描 `~/.claude/commands/` 的 .md 自定义命令（一层子目录 → `/dir:name` 命名空间，
  `terminalOnly:false`）。
  `description` 取 frontmatter `description:`，缺省取首个文本行；扫描失败降级为空列表，不 500。
- 条目上限 300/source；命令名限定 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`（防注入响应）。

## 9. 文件树（GET /api/fs/tree，只读，硬约束）

chat 输入区 `@` 触发文件选择面板（多选插入 `@rel/path` 引用，pi `@path` / claude @-mentions）。

> **只读硬保证**：仅 `readdir`+`stat`，无任何写入口；`cwd` 必须是存在的绝对目录；
> `path` 参数 resolve 后必须仍在 `cwd` 内（防 `../` 穿越，与 §6 git 同口径）；
> 单层列表，深度 ≤ 24、条目 ≤ 500（截断时 `truncated:true`）。

### GET /api/fs/tree?cwd=&path=&q=&hidden=

| 参数 | 说明 |
|---|---|
| `cwd` | 会话 cwd（绝对路径，必填） |
| `path` | 相对 `cwd` 的目录路径，缺省 `""`（根） |
| `q` | 文件名过滤（大小写不敏感子串，≤128 字符） |
| `hidden` | `1`/`true` 显示默认隐藏项（`.git` / `node_modules` / 点开头） |

```json
{
  "cwd": "/Users/me/Workspace/demo",
  "path": "src",
  "parent": "",
  "entries": [
    { "name": "utils", "type": "dir", "hidden": false, "size": null },
    { "name": "app.ts", "type": "file", "hidden": false, "size": 1234 },
    { "name": ".gitignore", "type": "file", "hidden": true, "size": 12 }
  ],
  "truncated": false
}
```

排序：目录优先，再按名字（大小写不敏感）。`parent` 为上一层相对路径（根为 `null`，回到根为 `""`）。
错误：`cwd` 非法/相对 → 400 `INVALID_CWD`；`cwd` 不存在/非目录 → 404 `FILE_NOT_FOUND`；
`path` 越界或深度超限 → 400 `INVALID_PATH`。

## 10. 消息内嵌图片（MessageDto.images，§1 补充）

消息 DTO 新增可选字段 `images`（无图**缺省**，向后兼容）：pi `ImageContent` / claude `image` block
统一映射为 `{ "url": "data:image/…;base64,… | https://…", "alt": null }`，每消息最多 8 张。
text 仍为纯文本（claude 纯图消息 text 为 `[image]` 占位）；前端渲染为 `<img>`（max-width 100%，
不拦截长按，保留 Android Chrome 原生"保存图片"菜单）。markdown 正文中的 `![alt](src)` 同样渲染
（src 白名单：http(s) / data:image / 相对路径）。

## 11. 终端驱动状态（SessionListItem.terminal，§1 补充）

`SessionListItem` 新增可选字段 `terminal`（claude 会话与旧 server **缺省**，向后兼容）：

```json
{ "online": true, "attached": false }
```

- `online`：终端 pi 扩展心跳在 90s 内（§12）。
- `attached`：会话处于 attach 接管模式（消息走指令队列发往终端 pi）。
- `GET /api/sessions` 与 `GET /api/sessions/:id` 均注入；前端据此渲染会话列表徽章
  （🖥⚡ 已接管 / 🖥 终端在线 / 📱 平行线）与模式菜单可用性。

## 12. 终端接管 / 指令队列（E3 双模式会话驱动）

双模式：**📱 parallel**（消息走 §1 prompt，server 内 SDK 实例处理，现状）与
**🖥 attach**（消息入指令队列，电脑终端 pi 进程经 `integrations/pi-command` 扩展取走并注入，
终端 TUI 实时显示并执行）。用户在 chat 顶栏徽章自行选择。

### POST /api/agents/heartbeat（扩展 → server，30s 一续）

请求：`{ "sessionId": "…", "pid": 123, "cwd": "/abs/path", "capabilities": ["message","steer","followUp"] }`
响应 202：`{ "ok": true, "ttlMs": 90000 }`。90s 无心跳判定终端离线（attach 自动失效并广播
`attach_state`）。

### GET /api/agents/commands?sessionId=&wait=（扩展长轮询取指令）

`wait` 钳制 0..30000（毫秒）：无指令时挂起至有指令/超时，`enqueue` 即时唤醒（低延迟）。
响应 200：

```json
{ "commands": [ { "id": "cmd-…", "kind": "message", "text": "…", "mode": "prompt|steer|followUp", "enqueuedAt": 0, "expiresAt": 0, "attempts": 1 } ] }
```

投递语义：取走即入 inflight，30s 无回执自动**同 id 重投**（扩展按 id 幂等防重复注入），
最多 3 次；队列指令 10 分钟 TTL 过期丢弃；单会话队列上限 50。

### POST /api/agents/ack（扩展 → server，回执）

请求：`{ "sessionId": "…", "commandId": "cmd-…", "ok": true|false, "error": "失败原因" }`
响应 202：`{ "ok": true, "known": true|false }`。回执幂等（同 commandId 重复 ack 返回首条结果），
结果经 WS `command_ack` 回流到 web。

> **指令通道安全**：以上 `/api/agents/*` 三端点**仅限本机回环**访问，且 `auth.token` 非空时必须
> 携带 `Authorization: Bearer <token>`（与 §6 live 接入同 token）——局域网伪造心跳/指令/回执一律 401。

### POST /api/sessions/:id/attach（接管会话）

响应 202：`{ "attached": true, "agent": { "sessionId", "pid", "cwd", "online" } }`。
终端离线 → 409 `ATTACH_UNAVAILABLE`；会话不存在 → 404；claude 会话 → 400 `INVALID_REQUEST`。

### POST /api/sessions/:id/detach（退出接管）

响应 200：`{ "attached": false }`。未投递指令取消（回执失败原因）。

### POST /api/sessions/:id/message（attach 通道发消息）

请求：`{ "text": "…", "mode": "prompt|steer|followUp", "clientMessageId": "可选幂等键" }`
响应 202：`{ "accepted": true, "channel": "attach", "commandId": "cmd-…", "mode": "…" }`。
未 attach → 409 `ATTACH_REQUIRED`；队列满 → 409 `ATTACH_QUEUE_FULL`；同 `clientMessageId`
重复提交返回同一 `commandId`（不重复入队）。

注入语义（pi 扩展 API `sendUserMessage`）：`prompt`=空闲时发（正忙回执失败原因）、
`steer`=插话当前 run 后、`followUp`=排队到 run 待办结束（空闲时等价立即发）。

### 冲突保护

attach 生效期间同会话 parallel 发送（`POST /prompt` 与 WS `prompt`）一律 409 `ATTACH_ACTIVE`
（防 server SDK 实例与终端 pi 双写同一会话文件）；`/compact` 同样拒绝。detach 后恢复。
心跳超时（90s）attach 自动失效并广播 `attach_state {attached:false}`，web 自动回落 📱 平行模式。
