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

## 5. 约定

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
