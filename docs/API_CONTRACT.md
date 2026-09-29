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
      "thinking": "思维链全文（assistant 的 thinking 块，无则 null）",
      "toolCalls": [
        { "name": "bash", "summary": "ls -la", "status": "pending|running|done|error", "resultPreview": "…" }
      ]
    }
  ]
}
```
说明：`role` 与 pi session-format v3 对齐；toolResult 消息折叠进产生它的 assistant 消息的 `toolCalls[]`。
`messages` 仅含 active branch（树结构选活跃叶到根的路径）。
`thinking` 服务端保证不省略（无思维链为 `null`）；客户端兼容旧数据缺省（视为无思维链）。

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
  "tailscale": { "available": true, "loggedIn": true, "hostname": "my-mac" },
  "sessionDir": "/Users/me/.pi/agent/sessions",
  "workspaceRoot": "/Users/me/Workspace"
}
```
`available:false` 不是错误——前端展示为"可选增强未安装"。

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

## 4. WebSocket 事件流

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

client → server（可选，替代 REST）：
| type | 字段 |
|---|---|
| `prompt` | `text, mode` |
| `abort` | — |
| `ping` | —（保活，server 回 `pong`） |

断线重连：client 指数退避重连；重连后通过 `GET /api/sessions/:id` 全量对账（不做增量恢复，v0 简化）。

## 5. 约定

- 时间一律 ISO 8601 UTC（`timestamp` 毫秒为 pi 原始值）。
- 所有列表字段缺省 `[]`，对象缺省 `null`，不得省略字段。
- 端口、session 目录、workspace root 可由 `config/hub.config.json` 覆盖。

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
