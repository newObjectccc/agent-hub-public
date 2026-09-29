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
      "sessionFile": "/Users/me/.pi/agent/sessions/--Users-me-.../2026-02-18_xxx.jsonl"
    }
  ]
}
```
排序：`updatedAt` 倒序（跨来源统一排序；同刻按 id 稳定排序）。`status` 由 server 内存中的运行态决定
（本进程启动的 prompt 才可能是 `running`），否则按文件活动推断（60s 内有写盘 = running）。

`source` 为 v0 新增契约字段：列表项与详情里的 `session` 均带该字段；前端按其渲染来源徽章。

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

claude 会话（`source: "claude"`）返回同构映射后的消息：transcript 的 user/assistant/tool_result
映射到 `user`/`assistant`/`toolResult` role；同 `message.id` 的 assistant block 行聚合为一条消息，
`tool_use` 聚合为 `toolCalls[]`（`tool_result` 折叠回填 status/resultPreview）；thinking 跳过；
`ai-title` 行作为 `name`；不识别的行/块优雅跳过。

### POST /api/sessions
新建会话（仅 `source: "pi"`；claude 会话由 Claude Code CLI 自己创建）。
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

claude 会话：server 本地 spawn
`claude -p <text> --resume <session-id> --output-format stream-json --verbose --include-partial-messages --permission-mode manual`，
解析 stream-json 事件映射到 §4 WS 事件；`steer`/`followUp` 降级为排队（run 结束后自动发送）；
安全默认：`--permission-mode manual`（覆盖用户 settings，不可无人确认执行破坏性操作），
不使用 `--dangerously-skip-permissions` / `--allowedTools`。

### POST /api/sessions/:id/abort
中止当前运行（claude 会话：杀 spawn 的子进程）。响应 200：`{ "aborted": true }`（空闲时也返回 true，幂等）。

### POST /api/sessions/:id/compact
手动压缩上下文（仅 pi 会话；claude 会话返回 400 `INVALID_REQUEST`，由其自身 autocompact 管理）。响应 200：`{ "ok": true }`。

## 2. 系统状态（system）

### GET /api/system
```json
{
  "platform": "darwin | win32 | linux",
  "pi":   { "available": true,  "version": "0.87.1" },
  "claude": { "available": true, "version": "2.1.267" },
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

> 两个 source（pi / claude）事件形状完全一致；claude 会话的流事件由 server 解析
> `claude --output-format stream-json` 后映射（text_delta / tool_start / tool_end /
> message_end / agent_settled / status / error），tail 场景由 transcript 解析器 diff 新消息补齐。

## 5. 约定

- 时间一律 ISO 8601 UTC（`timestamp` 毫秒为 pi 原始值）。
- 所有列表字段缺省 `[]`，对象缺省 `null`，不得省略字段。
- 端口、session 目录、workspace root 可由 `config/hub.config.json` 覆盖。
