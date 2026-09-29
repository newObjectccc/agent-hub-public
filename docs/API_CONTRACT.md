# API 契约（v0，前后端并行开发的唯一接口基准）

> 本文件是 server/ 与 web/ 的强制契约。任何一方不得单方面修改字段名/路径；
> 需要变更时记录到本文件并在合并收口时由主会话统一裁决。

Base URL: `http://<host>:<port>/api`（默认端口 7700）
所有响应 `Content-Type: application/json`。错误统一为：
`{ "error": { "code": string, "message": string } }`，HTTP 4xx/5xx。

## 1. 会话（sessions）

### GET /api/sessions
列出全部 pi 会话（来自 `~/.pi/agent/sessions/` 全目录扫描，含所有 cwd 分组）。

```json
{
  "sessions": [
    {
      "id": "uuid-or-slug",
      "name": "pi-seksun-KPI",
      "cwd": "/Users/me/Workspace/im-production-copy",
      "updatedAt": "2026-02-18T12:00:00.000Z",
      "messageCount": 42,
      "status": "idle | running | error",
      "lastUserMessage": "帮我检查周报 KPI 口径（截断 120 字符）",
      "lastAssistantMessage": "好的，我先查 ETL 水位…（截断 120 字符）",
      "sessionFile": "/Users/me/.pi/agent/sessions/--Users-me-.../2026-02-18_xxx.jsonl"
    }
  ]
}
```
排序：`updatedAt` 倒序。`status` 由 server 内存中的运行态决定（本进程启动的 prompt 才可能是 `running`）。

### GET /api/sessions/:id
会话详情 + **active branch** 的消息历史（渲染 chat 用）。

```json
{
  "session": { "...同列表项..." },
  "messages": [
    {
      "id": "entry-id",
      "role": "user | assistant | toolResult | custom",
      "timestamp": 1733234401000,
      "text": "纯文本/markdown 原文",
      "toolCalls": [
        { "name": "bash", "summary": "ls -la", "status": "pending|running|done|error", "resultPreview": "…" }
      ]
    }
  ]
}
```
说明：`role` 与 pi session-format v3 对齐；toolResult 消息折叠进产生它的 assistant 消息的 `toolCalls[]`。
`messages` 仅含 active branch（树结构选活跃叶到根的路径）。

### POST /api/sessions
新建会话。
请求：`{ "cwd": "/abs/path", "name": "可选" }`
响应 201：`{ "session": { ...列表项... } }`

### POST /api/sessions/:id/prompt
发送消息。`mode` 语义与 pi SDK 一致：
- `"prompt"`（默认）：空闲时发送；**会话正忙且未指定 mode 时返回 409** `SESSION_BUSY`
- `"steer"`：插入当前运行之后（转向）
- `"followUp"`：排队到当前 run 结束后

请求：`{ "text": "消息内容", "mode": "prompt|steer|followUp" }`
响应 202：`{ "accepted": true, "mode": "..." }`
实际输出走 WebSocket 事件流。

### POST /api/sessions/:id/abort
中止当前运行。响应 200：`{ "aborted": true }`（空闲时也返回 true，幂等）。

### POST /api/sessions/:id/compact
手动压缩上下文。响应 200：`{ "ok": true }`。

## 2. 系统状态（system）

### GET /api/system
```json
{
  "platform": "darwin | win32 | linux",
  "pi":   { "available": true,  "version": "0.87.1" },
  "tmux": { "available": true,  "version": "3.4" },
  "ttyd": { "available": false, "version": null },
  "claude": { "available": false, "version": null },
  "tailscale": { "available": true, "loggedIn": true, "hostname": "my-mac" },
  "sessionDir": "/Users/me/.pi/agent/sessions",
  "workspaceRoot": "/Users/me/Workspace"
}
```
`available:false` 不是错误——前端展示为"可选增强未安装"。`claude` 为 CLI 探测（可选增强）。

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
| `tool_start` | `messageId, toolCall: {name, summary}` | 工具开始 |
| `tool_end` | `messageId, toolCall: {name, summary, status, resultPreview}` | 工具结束 |
| `message_end` | `message: {同 GET 详情的 message 结构}` | 消息完成（权威数据） |
| `agent_settled` | — | 本轮工作全部结束（UI 恢复输入框） |
| `status` | `status: "idle\|running\|error"` | 状态变化 |
| `error` | `code, message` | 运行期错误 |

client → server（可选，替代 REST）：
| type | 字段 |
|---|---|
| `prompt` | `text, mode` |
| `abort` | — |
| `ping` | —（保活，server 回 `pong`） |

断线重连：client 指数退避重连；重连后通过 `GET /api/sessions/:id` 全量对账（不做增量恢复，v0 简化）。

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
