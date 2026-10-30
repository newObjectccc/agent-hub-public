# API 契约（当前版本 v0.3）

> 本文件是 server/ 与 web/ 的强制契约。任何一方不得单方面修改字段名/路径；
> 需要变更时记录到本文件并在合并收口时由主会话统一裁决。

Base URL: `http://<host>:<port>/api`（默认端口 7700）
所有响应 `Content-Type: application/json`。错误统一为：
`{ "error": { "code": string, "message": string } }`，HTTP 4xx/5xx。

`auth.enabled=true` 时，HTTP 需 Bearer token（空 token、非法 auth 结构/类型或未知字段会在监听前报 `CONFIG_INVALID`）；WS upgrade 支持 Authorization、
`bearer.<token>`（亦支持 token/access_token）子协议或兼容的 `?token=` 参数，并检查 Origin/Host。
浏览器优先使用子协议，避免 token 进 URL。
应用锁另行校验解锁令牌，范围见应用锁一节；两层同时启用时须分别满足。

## 1. 会话（sessions）

### GET /api/sessions
列出全部会话，**合并三个来源**：
- `source: "pi"`：`~/.pi/agent/sessions/` 全目录扫描（session-format v3 JSONL）
- `source: "claude"`：`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`（Claude Code transcript）
- `source: "codex"`：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 扫描（rollout JSONL，
  含 `~/.codex/archived_sessions/` 归档；同一会话跨多个 rollout 分段文件按 session_id 归并）

```json
{
  "sessions": [
    {
      "id": "uuid-or-slug",
      "source": "pi | claude | codex",
      "name": "pi-report-KPI",
      "cwd": "/Users/me/Workspace/demo-project",
      "updatedAt": "2026-02-18T12:00:00.000Z",
      "messageCount": 42,
      "status": "idle | running | error",
      "lastUserMessage": "帮我检查周报 KPI 口径（截断 120 字符）",
      "lastAssistantMessage": "好的，我先查 ETL 水位…（截断 120 字符）",
      "isSubAgent": false,
      "parentSessionId": null,
      "lastDrivenBy": "terminal"
    }
  ]
}
```
排序：`updatedAt` 倒序（跨来源统一排序；同刻按 id 稳定排序）；归档会话（`archived: true`）整体排列表尾部。
列表、详情及 create/fork 响应剥离内部路径 `sessionFile`。`status` 优先取 hub 实际运行态
（含空闲的 Claude 接管进程）；无自有运行态时结合显式状态及文件活动推断。外部文件在 60s 内写入
通常视为 running，tail 还会按下文静默规则收尾，不能理解为外部进程的精确状态。

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
命中即 `"panel"`；未命中但有实质消息（`messageCount > 0`）为 `"terminal"`（消息是终端写的）；
无消息的空会话（如刚创建）为**无驱动史**：不下发该字段，前端不据此默认接管（手机新建的会话
永远从 📱 平行模式开始）。这是“曾经由面板平行驱动”的标记，
不是对当前进程所有者的探测。平行模式由 server 的 SDK/CLI 向同一上下文追加；原终端需重新 resume
才能看到，前端按其渲染来源提示（无驱动史不渲染徽章），也用它判断 Claude 默认接管策略。

`archived` 为归档会话标注契约字段（列表项与详情里的 `session` 均带，可缺省）：codex 归档
目录 `~/.codex/archived_sessions/` 扫描出的会话为 `true`（任一分段在归档目录即视为归档），
列表标注「📦 归档」并排列表尾部；非归档 / 旧 server 缺省，前端按 `!== true` 容错为非归档。

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
      ],
      "error": { "message": "模型/流式错误原文", "kind": "contextOverflow|aborted|other" }
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
pi 消息的 `thinking` 无思维链时为 `null`；Claude 当前跳过 thinking 块，不能据此承诺三源均返回思维链。
客户端兼容 `thinking` 缺省（视为无思维链）。Claude 的内部图片尺寸/坐标提示、命令元数据及 sidechain
不作为主会话用户消息展示；成功读图结果可补回旧上传消息的图片，见消息内嵌图片一节。

#### `error` 字段（模型/流式错误透出）

pi 的**余额耗尽 / 网络中断 / 上下文溢出 / 主动中止**都不抛异常，而是产生一条 `content` 可能为空、
带 `stopReason: "error"|"aborted"` + `errorMessage` 的 assistant 消息。此前 DTO 不取这两个字段，
前端只能渲染成灰色「（无内容）」气泡——用户零原因、零出路（实测语料里就有
`"You have no credits remaining…"`、`"Connection error."`）。现在：

- `error.message`：SDK 的 `errorMessage` 原文（不美化也不隐藏；缺失时给中文兜底）
- `error.kind`：`contextOverflow`（前端据此给「压缩上下文」一键自救）/ `aborted`（中性语气，不算错误）/ `other`
- 溢出分类按 `errorMessage` 文本特征粗判（SDK 内部 `isContextOverflow` 不对外导出），**宁可漏判为 `other`也不误判为可压缩**
- 实时流式与历史加载（`buildMessages`）**两条路径同口径**，否则刷新页面后错误条会消失
- 本轮以错误收尾时：`status` 置 `error`，并补发一条 `error` 事件（code = `CONTEXT_OVERFLOW` 或 `PROMPT_FAILED`）
- 仅 assistant 消息可带 `error`；claude/codex 源暂不下发（它们的失败走 spawn/stderr 路径）
### POST /api/sessions
新建会话。请求：`{ "cwd": "/abs/path", "name": "可选", "source": "pi | claude | codex（可选，缺省 pi）" }`
响应 201：`{ "session": { ...列表项... } }`

- `source` 缺省/空 → `"pi"`；非法值 → 400 `INVALID_REQUEST`。registry 按 source 分发到对应适配器。
- `source: "pi"`：落盘 session-format v3 JSONL header（原 v0 行为）。
- Beta.3 起可额外传 `"model": { "provider": "xai", "id": "grok-4.5" }`，仅 pi 支持。省略时沿用 pi 已保存默认值；显式选择仅接受本机已配置模型，写入当前会话的 `model_change`，即使尚无消息也在首次 SDK 启动时恢复。其他来源传 model、非 provider/id 字段、空值或非法标识均返回 400 `INVALID_REQUEST`；未知/未配置模型返回 400 `MODEL_UNAVAILABLE`，不创建会话。
- `source: "claude"`：**创建空白 transcript 会话文件**（新 UUID，`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`，
  含一条 `isMeta` 占位行 + 可选 `ai-title` 行；解析后消息数 0，chat 显示空会话）。
  首条消息走既有 `claude -p --resume <id>` 流程。
  > 实测（claude 2.1.267）：空文件 `--resume` 报 `No conversation found`；含 isMeta 占位行的合成
  > transcript 可正常 resume 并向同一文件 append。故“新建”= 合成空白会话文件，而非“引导首条消息才建会话”。
- `source: "codex"`：写最小 rollout 文件（仅 `session_meta` 行），后续 prompt 走
  `codex exec resume <id> --json` 本地 spawn 驱动。
- `cwd` 必须是绝对路径（否则 400 `INVALID_CWD`），且必须存在（否则 400 `INVALID_CWD`）。

### pi 模型目录与会话模型（Beta.3）

- `GET /api/pi/models?cwd=<绝对路径>`：列出 Hub 运行环境中的已配置模型；省略 cwd 用 `workspaceRoot`，目录不存在/不是目录返回 400 `INVALID_CWD`。
- `GET /api/sessions/:id/model`：读取当前 pi 会话的模型与本机目录。当前模型来自驻留 SDK，或 JSONL **active branch** 的最近 `model_change`（保留 virtual selection），无该条目才回退 assistant 模型。读取不打开/迁移会话、不启动任务、不改文件。
- 两个 GET 均直接返回 `{ "models": [{ "provider": "xai", "id": "grok-4.5", "name": "Grok 4.5" }], "defaultModel": { "provider": "anthropic", "id": "..." } | null, "currentModel": { "provider": "xai", "id": "grok-4.5" } | null, "warning": "提示" | null }`。新建目录的 currentModel 为 null；默认值与会话当前值独立。列表不调用模型服务验证权限或余额；只返回标识/名称，不返回 headers、API key、baseUrl 或认证记录。
- `POST /api/sessions/:id/model`：body 为 `{ "provider": "xai", "id": "grok-4.5" }`（不是嵌套 model）；响应 200 `{ "model": { "provider": "xai", "id": "grok-4.5" } }`。只切当前会话：驻留实例调用 SDK `setModel(..., {persist:false})`，未加载实例在当前分支追加模型条目，旧格式先通过 SDK 迁移。保留历史，不改全局默认值，不自动重试消息。
- 切换与发送/SDK 启动互斥；运行中或正在切换返回 409 `SESSION_BUSY`，外部终端持有/近期写入返回 409 `EXTERNAL_ACTIVE`，接管中返回 409 `ATTACH_ACTIVE`。会话不存在返回 404 `SESSION_NOT_FOUND`，非 pi 返回 400 `INVALID_REQUEST`，未知或当前环境未配置模型返回 400 `MODEL_UNAVAILABLE`。旧注入实现未提供模型功能时返回 501；错误信封仍为 `{error:{code,message}}`。
- 所有入口沿用 Bearer 鉴权与应用锁；无 token 的锁屏请求返回 423，错误/过期锁令牌或缺少有效 Bearer 返回 401。模型标识仅接受非空 provider/id（各 ≤512 字符，无控制字符），不接受凭据/其他配置字段。
- SDK 恢复后的模型与保存的选择不一致时，即使 SDK 未给出回退警告，也终止本次唤醒并报告 `MODEL_UNAVAILABLE`；不得静默把任务交给另一个 provider。由于 prompt 异步受理，启动阶段失败通过 WS `error` 发送此 code；用户选择模型后手动重试。

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
- `source: "codex"`：复制**全部分段 rollout** 为新 UUID 会话（行内 `session_id`/`id` 同步替换，
  原文件只读），后续 prompt 走 `codex exec resume <new-id> --json`。
- 名称随上下文继承（pi 的 `session_info` / claude 的 `ai-title` 均在复制范围内）。

### POST /api/sessions/:id/prompt
发送消息。以下为 pi SDK 的模式语义；Claude 的差异见本节下方：
- `"prompt"`（默认）：空闲时发送；**会话正忙且未指定 mode 时返回 409** `SESSION_BUSY`
- `"steer"`：插入当前运行之后（转向）
- `"followUp"`：排队到当前 run 结束后

请求：`{ "text": "消息内容", "mode": "prompt|steer|followUp" }`；`images` 可选（上传图片相对路径数组；`null` 视为未传，仅非 `null` 的非数组值才 400）
响应 202：`{ "accepted": true, "mode": "..." }`
实际输出走 WebSocket 事件流。

claude 会话：server 本地 spawn
`claude -p <text> --resume <session-id> --output-format stream-json --verbose --include-partial-messages --permission-mode <claudeDriver.permissionMode>`，
解析 stream-json 事件映射到 WS 事件；本服务启动的 run 正忙时，`steer`/`followUp` 均排队（进程 close 后自动发送，附件随队列保留）；
若是未接管的外部终端正在运行，平行模式三种 mode 均返回 `409 SESSION_BUSY`，不受理无法投递的队列；
平行通道的权限档位由 `claudeDriver.permissionMode` 配置驱动（默认 `bypassPermissions` 最高权限、工具自动执行无人工审批；
`inherit` 时不下发 `--permission-mode`、沿用用户 settings；具体工具许可仍由 CLI 配置决定），
不使用 `--dangerously-skip-permissions` / `--allowedTools`。

历史会话无需原终端在线即可 resume；打开页面本身不发送历史任务。Claude 发送在异步环境准备结束后，
依据实际自有运行状态与最新文件 mtime 再检查 busy，并在无额外 await 的情况下启动进程，避免同会话双开。
abort 会取消准备中的请求及尚未消费的本地队列，已取消的准备不会继续启动。

### 发送类错误码（prompt / compact / attach 共用）

| code | HTTP | 含义与客户端应有行为 |
|---|---|---|
| `SESSION_BUSY` | 409 | 本服务自有 run 正忙且 `mode` 缺省（可用 `steer`/`followUp`） |
| `MODEL_UNAVAILABLE` | 400 / WS | pi 所选/已保存模型在 Hub 环境不可用；在模型入口刷新并选择可用模型后手动重试，不自动切换 provider |
| `EXTERNAL_ACTIVE` | 409 | **pi 源**：外部（电脑终端）正持有/正在写该会话，平行发送会双写分叉。message 是可直接展示的中文原因（带出路）；客户端应**常驻**展示，不得自动重发（重发也一样被拒） |
| `PROMPT_IN_FLIGHT` | 409 | 同 `clientMessageId` 的上一次提交还在处理中（结果未出）。**不得当成成功**；客户端归入自动重试（幂等键保证不双执行） |
| `SESSION_CORRUPT` | 409 | 会话文件损坏/已删除/工作目录失效，无法唤醒该会话。message 带中文原因 + 原始错误尾巴（此前一律被归为 500 `internal error`，手机端零出路） |
| `CONTEXT_OVERFLOW` | — | 仅 WS `error` 事件：本轮因上下文溢出失败，客户端应给「压缩上下文」一键动作 |
| `ATTACH_UNAVAILABLE` | 409 | 终端不在线，**或心跳在但扩展已停止轮询**（见下节 `responsive`）。message 明说「这条消息没有发出去」，客户端据此自愈切平行并自动补发 |

幂等语义修正：同 `clientMessageId` 重复提交时，**仅当首发已得出受理结果**才重放 202；
首发仍在 flight 时回 409 `PROMPT_IN_FLIGHT`。此前这种情况伪报 `accepted:true`，
若首发最终 409/500，重发方已以为成功（输入框已清、气泡显示已发送），消息就静默消失了。

### POST /api/sessions/:id/abort
中止当前运行（Claude 平行模式：终止自有子进程并取消准备/队列；接管模式：向驱动发送 control interrupt，
进程可继续接下一轮）。响应 200：`{ "aborted": true }`（空闲时也返回 true，幂等）。

### POST /api/sessions/:id/compact
手动压缩上下文（仅 pi 会话；claude 会话返回 400 `INVALID_REQUEST`，由其自身 autocompact 管理）。响应 200：`{ "ok": true }`。

### POST /api/sessions/:id/rename
会话改名（手机可维护）。请求：`{ "name": "新名字" }`——`name` 必须是字符串，
**空串 = 清空名字**（恢复无名）；最长 200 字符。
响应 200：`{ "session": { ...会话列表项... } }`（改名后的会话，`name` 为新名/清空后 `null`）。

- `source: "pi"`：向会话 JSONL 追加 `session_info` entry（与 pi `/name` 同机制）。
- `source: "claude"`：追加 `ai-title` 行（transcript 会话名栏位，最新一条为当前名）。
- `source: "codex"`：400 `INVALID_REQUEST`（`来源 codex 暂不支持重命名会话`）。
- 两源改名均在写盘**前**快照推断状态（实时 mtime），防写盘刷新 mtime 后被 60s 时间窗误判 running。
- 错误：会话不存在 → 404 `SESSION_NOT_FOUND`；`name` 非字符串 / 超 200 字符 → 400 `INVALID_REQUEST`。
- 注意：本端点响应当前为适配层原样 `SessionListItem`（含内部字段 `sessionFile`），与
  create/fork 的瘦身出参（剥离 `sessionFile`）口径不一致——消费方按列表项字段使用，
  **勿依赖 `sessionFile`**。

### GET /api/search
跨全部会话搜消息文本（大小写不敏感子串匹配，无需全文索引）。
查询参数：`q`（必填非空，否则 400 `INVALID_REQUEST`）、`limit`（可选，默认 50，钳制到 1..100）。

```json
{
  "results": [
    {
      "sessionId": "uuid-or-slug",
      "sessionName": "pi-report-KPI",
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

### GET /api/sessions/:id/agents
子代理活动快照（父会话面板初始化用）：聚合该会话下「正在干活的子代理」。
会话不存在 / 无子代理 → 200 `{ "agents": [] }`（**不报 404**，面板空态即可）。

```json
{
  "agents": [
    {
      "sessionId": "sub-uuid",
      "name": "developer#abc123",
      "status": "idle | running | error",
      "currentTool": "bash: pnpm test",
      "toolRunning": true,
      "lastOutput": "正在执行测试…（截断 160 字符）",
      "startedAt": 1770000000000,
      "updatedAt": 1770000012000,
      "done": false,
      "resultSummary": null
    }
  ]
}
```

说明：
- **pi**：只聚合 pi-subagents 派生子代理（`isSubAgent && parentSessionId === :id`）；
  fork 分支虽带 `parentSessionId` 但不是「子代理在干活」，不进面板。
- **claude**：Task 子代理（transcript sidechain）与主会话同文件，从解析产物直接聚合
  （同构 `SubAgentActivityDto`）。
- **codex**：无子代理概念 → 恒空数组。
- 字段口径：`currentTool` 为当前/最近工具 summary（`toolRunning` 标注是否仍在执行）；
  `lastOutput` 最后一条 assistant 文本（截断 160 字符）；`startedAt` 首次活动时间（ms，算已运行时长）；
  `done` = 已结束（非 running），结束卡片转「✅ 完成，点击查看结果」，`resultSummary` 为结果摘要。
- 实时增量走 WS `subagent_activity`（§6 事件表），本端点为冷启动快照（二者形状对齐）。

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
  "terminal": {
    "supported": true,
    "installed": true,
    "running": false,
    "version": "1.7.7",
    "hint": null
  },
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

`terminal` 为 F2 新增（ttyd Web 终端运行态，详见“ttyd Web 终端”一节；旧 server 可缺省，前端按未启用容错）：
`supported`=平台支持（仅 POSIX）、`installed`=ttyd 已安装、`running`=按需拉起的 ttyd 在运行、
`version` 同其它工具探测、`hint`=降级提示（未安装给安装命令 / Windows 给「不支持（WSL 内可用）」）。

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
      "id": "weekly-kpi",
      "title": "周报 KPI",
      "value": "98.2%",
      "trend": "up | down | flat | unknown",
      "delta": "+0.4%",
      "updatedAt": "2026-02-18T12:00:00.000Z",
      "link": "https://example.com/dashboard",
      "error": null
    }
  ]
}
```
`config/kpi-sources.json` 结构：
```json
{
  "sources": [
    { "id": "weekly-kpi", "title": "周报 KPI",
      "type": "http-json", "url": "https://example.com/api/metric",
      "headers": {}, "jsonPath": "$.data.completionRate", "unit": "%",
      "link": "https://example.com/dashboard" }
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
      "id": "uuid-1", "name": "pi-report-KPI", "cwd": "/Users/me/Workspace/x",
      "status": "running", "source": "pi",
      "startedAt": "2026-02-18T11:30:00.000Z",
      "currentTool": "bash: pnpm test",
      "lastOutput": "测试全绿…（截断 120 字符）",
      "updatedAt": "2026-02-18T11:58:00.000Z"
    }
  ],
  "attentionSessions": [
    {
      "id": "uuid-2", "name": null, "cwd": "/Users/me/Workspace/y",
      "status": "idle", "source": "claude", "reason": "settled",
      "summary": "已完成，等你确认…（截断 120 字符）",
      "updatedAt": "2026-02-18T10:05:00.000Z"
    }
  ],
  "bySource": {
    "todayMessages": { "pi": 18, "claude": 4, "codex": 2 },
    "todayDone": { "pi": 2, "claude": 1, "codex": 0 },
    "working": { "pi": 1, "claude": 0, "codex": 0 },
    "needAttention": { "pi": 1, "claude": 1, "codex": 0 }
  }
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
- `bySource`（v0.3 增量字段）：按会话来源（`pi` | `claude` | `codex`）分组的细分计数，
  含 `todayMessages` / `todayDone` / `working` / `needAttention` 四个维度（口径与对应总量
  字段逐字一致，各细分之和 = 对应总量；未知来源保守归 `pi`）。老字段语义不变。
- `workingSessions` / `attentionSessions` 卡片携带 `source`（会话来源，前端分源徽章/过滤用）
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
      "sessionName": "pi-report-KPI",
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
连接即进入“订阅”模式：server 将三个来源的事件映射为下列统一结构。

server → client（每条一个 JSON 对象）：
| type | 字段 | 说明 |
|---|---|---|
| `session` | `id, cwd` | 连接后首条，握手确认 |
| `message_start` | `message: {id, role, timestamp}` | 消息开始 |
| `text_delta` | `messageId, delta` | 流式文本增量 |
| `thinking_delta` | `messageId, delta` | 流式思维链增量（累积到消息 `thinking` 字段） |
| `tool_start` | `messageId, toolCall: {name, summary}` | 工具开始 |
| `tool_end` | `messageId, toolCall: {name, summary, status, resultPreview}` | 工具结束；`status:"running"` 时为执行中快照（`resultPreview` 为部分结果，前端按 `name` 合并进同一工具卡） |
| `message_end` | `message: {同 GET 详情的 message 结构}` | 单条消息完成（权威数据），不代表整轮完成，后续仍可执行工具 |
| `agent_settled` | — | 本轮工作结束；UI 恢复输入，保留已经收到的 error 状态 |
| `status` | `status: "idle\|running\|error"` | 状态变化 |
| `subagent_activity` | `sessionId, parentSessionId, activity` | 子代理活动增量（§1 GET agents 的 `SubAgentActivityDto` 变化字段并集，恒含 `sessionId`，通常带 `name`）；推送到**父会话**通道（订阅 `/ws/sessions/<父 id>` 收到） |
| `error` | `code, message` | 运行期错误 |
| `attach_state` | `attached, terminalOnline` | 终端驱动状态变化（§12：接管建立/失效） |
| `command_ack` | `commandId, ok, error` | attach 指令回执（成功/失败原因） |
| `host_request` | `request: HostRequestDto` | hub 驱动 claude 会话的权限请求（§12，手机批权限卡片） |
| `host_request_resolved` | `requestId, outcome: "allow\|deny\|timeout\|cancelled"` | 权限请求已决 |

client → server（可选，替代 REST）：
| type | 字段 |
|---|---|
| `prompt` | `text, mode` |
| `abort` | — |
| `ping` | —（保活，server 回 `pong`） |

断线重连：client 指数退避重连；重连后通过 `GET /api/sessions/:id` 全量对账（不做增量恢复，v0 简化）。
Claude 流式 assistant 使用原生 `message.id`（缺失才回退临时 id），与 transcript 聚合及工具结果回填一致。
图片对账先按 id 保留已有附件；临时用户消息换成落盘 id 时，只对文本一致、时间差不超过 60 秒的消息
就近一对一匹配。服务端显式返回的 `images`（含空数组）优先，不覆盖为旧图片。

前端在 assistant `message_end` 后静默 5 秒会查询 `GET /api/sessions/:id?limit=1`；只有服务端状态
确认结束才恢复空闲。仍在运行或查询失败时继续等待并重查；新事件、新发送/重试、整轮结束或卸载页面
会作废旧查询，迟到响应不能覆盖新一轮状态。Claude 接管的 init 不代表 running，`result` 必须先广播
本轮 idle/error 与 settled，再消费 followUp；常驻进程本身不代表任务正在运行。

> 三个 source（pi / claude / codex）事件形状完全一致；claude 会话的流事件由 server 解析
> `claude --output-format stream-json` 后映射（text_delta / tool_start / tool_end /
> message_end / agent_settled / status / error），codex 会话由 `codex exec --json` 事件流映射，
> tail 场景由各自解析器（transcript / rollout）diff 新消息补齐。

### 外部运行状态约定
补充：
- 文件 tail 对外部会话只能推断结束：最后新增消息是非空 assistant 文本后静默 3 秒，或无新增消息
  60 秒，会发 `agent_settled` + `status:idle`。这是文件活动启发式，不能证明外部进程已经停止；
  hub 管理的运行状态优先，不能用短暂静默结束仍在执行的自有任务。
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

### 通用约定
- 时间一律 ISO 8601 UTC（`timestamp` 毫秒为 pi 原始值）。
- 必填列表字段无数据时为 `[]`，必填可空对象为 `null`；明确标注可选的字段允许缺省。
- 端口、session 目录、workspace root 可由 `config/hub.config.json` 覆盖。

## 7. Git 与文件（只读，硬约束）

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
## pi 实时旁观接入（live ingest）

### POST /api/live/:sessionId

pi 扩展 `integrations/pi-live-feed/live-feed.ts` 把**任意终端 pi 会话**的实时事件流
（思维链/流式回复/工具执行，token 级）推给 server，server 转成 §6 的 WS 事件广播到
`/ws/sessions/:sessionId`。fire-and-forget 语义：扩展侧失败静默，server 侧坏数据丢弃，绝不 500。

请求体（三种形态等价）：

```json
{ "events": [ { "type": "text_delta", "messageId": "live-1-…", "delta": "你" } ] }
```

事件对象即 §6 的 server→client 事件子集：`message_start` / `text_delta` / `thinking_delta` /
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
  同一个 `EventThrottle` 实现也用于 **parallel 路径**（server 内 SDK 实例的事件流）：此前只有
  attach/live-feed 路径节流，parallel 每个 chunk 直接广播，而 parallel 恰恰是「手机继续
  不活跃会话」走的路，弱网下帧数放大数十倍。
- WS 广播带**背压保护**：单连接 `bufferedAmount` 超 512KB 时丢弃 delta 帧（`text_delta` /
  `thinking_delta`），生命周期事件一律不丢。丢 delta 是安全的：`message_end` 携带完整文本，
  前端按 id upsert 会用权威内容替换流式占位，另有详情全量对账兼底。
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

### GET /api/commands?source=pi|claude|codex

`source` 缺失或非 `pi|claude|codex` → 400 `INVALID_REQUEST`。

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
- `codex`：恒返回**空清单**（`codex exec` 通道不支持 slash 命令展开，自定义命令目录未约定；
  UI 标注无可用命令）。
- 条目上限 300/source；命令名限定 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`（防注入响应）。

## 9. 文件树（GET /api/fs/tree，只读，硬约束）

chat 输入区 `@` 触发文件选择面板（多选插入 `@rel/path` 引用，pi `@path` / claude @-mentions）。

> **只读硬保证**：仅 `readdir`+`stat`，无任何写入口；`cwd` 必须是存在的绝对目录；
> `path` 参数 resolve 后必须仍在 `cwd` 内（防 `../` 穿越，与 §7 git 同口径）；
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
统一映射为 `{ "url": "data:image/…;base64,… | https://…", "alt": "string | null" }`，每消息最多 8 张。
text 仍为纯文本（claude 纯图消息 text 为 `[image]` 占位）；前端渲染为 `<img>`（max-width 100%，
不拦截长按，保留 Android Chrome 原生"保存图片"菜单）。markdown 正文中的 `![alt](src)` 同样渲染
（src 白名单：http(s) / data:image / 相对路径）。

Claude 平行模式发送时即在合成的用户消息中携带附件预览；本地队列保留附件，前端对账不因临时 id
换成落盘 id 而丢图。旧版只有 `@.agent-hub-uploads/...` 的用户消息，可从随后对应 Read 工具的
成功图片结果恢复预览：要求用户文本明确引用该路径、路径位于允许的上传根、tool_use_id 对应，
排除错误结果及无关文件图片，去重后仍至多 8 张。恢复依赖保存的成功读图结果，不能保证仅有路径的
历史记录在刷新后就有图。

`isMeta` / `turnCompanion` / sidechain 及图片尺寸提示（如 `[Image: original …, displayed at ….
Multiply coordinates …]`）不展示为额外用户消息；stdout 即使丢失标志也会过滤这种内部提示。
这不影响正常用户文本和工具结果处理。

## 11. 终端驱动状态（SessionListItem.terminal，§1 补充）

`SessionListItem` 可选字段 `terminal`（未启用对应驱动、归档 Codex 会话或旧 server 缺省，向后兼容）：

```json
{ "online": true, "attached": false, "driver": "queue", "mirror": false, "defaultPolicy": "active-only", "responsive": true }
```

- `online`：pi=扩展心跳 90s 内；Claude（hub 驱动）=服务提供接管能力，不代表原 TUI 在线，
  也不保证此次 attach 一定成功。
- `attached`：会话处于 attach 接管模式（pi=消息走指令队列注入终端 TUI；claude=hub 持有长驻
  `claude -p --resume` 进程，stdin 注入真用户 turn）。
- `driver`：`"queue"`（pi 扩展指令队列）| `"hub"`（Claude / Codex 驱动进程）；缺省按 queue 容错。
- `mirror`：tmux 投屏就绪（仅 hub 形态）。
- `responsive`（可选，仅 pi/queue 形态有意义）：终端扩展是否仍在长轮询取指令。心跳 TTL 是 90s，
  终端关掉后这 90s 里 `online` 仍为 true；`responsive: false` 表示心跳在但扩展已超 45s 没来取指令
  （死终端），客户端不得据此自动接管（否则消息入队无人取）。缺省（老 server）按 true 容错。
  详见 §12 的 `terminal.responsive` 一节。
- `defaultPolicy`（v0.3 新增，可选）：智能默认接管策略，取自 `config.claudeDriver.defaultPolicy`
  并随 terminal 下发。**Codex 恒为 `"never"`（2026-10-23 产品规则）**：进入会话默认 📱 平行继续——
  接管有「须先退出桌面 ChatGPT app 对应会话」的写者互斥前提，默认接管几乎必失败；
  与 pi/claude（active-only：电脑上活跃 → 默认接管）刻意区分；`config.codexDriver.defaultPolicy`
  保留仅兼容、不影响默认通道，手动切换/pin 仍可接管：
  `"active-only"` = pi 扩展在线时默认接管，Claude 在 `status === "running"` 或
  `lastDrivenBy === "terminal"` 时默认尝试接管（后者也可能是空闲历史会话）；`"always"` = 打开即尝试，
  pi 仍须 `online === true`；`"never"` = 只手动切换。**空会话闸门（与策略无关）**：无任何消息且
  非 `running` 的会话（`messageCount === 0`，如刚创建）任何策略下都不默认接管（手机新建 ≠ 接管电脑）。Claude 实际 attach 仍受开关、静默窗和并发上限约束。
  **老 server 缺省该字段 → 前端按 `"active-only"` 容错**（行为与历史一致）；用户手动选择（pin）
  永远优先于该策略。
- `effectivePolicy`（可选，Codex 接管会话）：生效权限策略 `{ approval, sandbox, bypass }`，
  语义与 attach 202 响应一致（`bypass: true` = approval 为 never，不请求操作审批，不得暗示有门禁；缺省 = 未知，容错）。
- `GET /api/sessions` 与 `GET /api/sessions/:id` 均注入（pi/claude/codex）；前端据此渲染会话列表徽章
  （🖥⚡ 已接管 / 🖥 终端在线|可接管 / 📱 平行线）与模式菜单可用性。

## 12. 终端接管 / 指令队列（E3 双模式会话驱动）

双模式：**📱 parallel**（消息走 prompt；pi 使用 SDK，Claude/Codex 启动各自 CLI）与
**🖥 attach**（pi 经 `integrations/pi-command` 注入已有终端进程；Claude 由 hub 新建持续运行的
CLI 进程续接同一上下文，支持 tmux 投屏；Codex 由独立 app-server 续接同一线程）。Claude / Codex 不控制原桌面窗口；Codex 原线程正被占用时需先退出原会话。
用户在 chat 顶栏徽章选择；接管期间请避免同时在原 Claude TUI 输入。

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
> 携带 `Authorization: Bearer <token>`（与 pi live 接入同 token）——局域网伪造心跳/指令/回执一律 401。

### POST /api/sessions/:id/attach（接管会话）

按 `session.source` 分流（pi → 指令队列；claude → hub 驱动；codex → 原生 app-server）。

pi 响应 202：`{ "attached": true, "agent": { "sessionId", "pid", "cwd", "online", "capabilities", "lastSeen" } }`。
claude 响应 202：`{ "attached": true, "agent": { "sessionId", "cwd", "online", "driver": "hub", "mirror" } }`。
终端离线（pi）→ 409 `ATTACH_UNAVAILABLE`；claude 外部写入静默窗内 → 409 `ATTACH_UNAVAILABLE`；
驱动并发满 → 409 `DRIVER_LIMIT`；会话不存在 → 404；驱动禁用或归档 Codex → 400 `INVALID_REQUEST`。

Codex 使用相同的 202 响应（driver=hub、mirror=false）；完整 initialize/initialized 与 idle resume 成功才算 attached。版本要求 0.162+（含对应 alpha），旧版或 writer 占用明确报错。`codexBin` 由配置指定；接管期间和准备/释放过程中 parallel HTTP/WS 均返回 409，防止双写。接管成功后若 Codex 协议回显了生效策略，响应附 `effectivePolicy: { approval, sandbox, bypass }`（协议回显归一化；`bypass: true` = approval 为 never，不请求操作审批，沙箱范围独立显示；未回显时字段缺省，客户端按「未知」容错，不得把缺省当成安全档位）。

**`terminal.responsive`（pi 防「假接管」）**：心跳 TTL 是 90s，用户关掉终端后的这 90s 里
`online` 仍为 `true`，此时接管必然变成假接管（消息入队无人取，用户等一分钟才知道、文本还会丢）。
扩展的长轮询上限是 30s，活着就必然每 ≤30s 来一次，所以 server 另记录 poll 活性并下发：

- `responsive: false` = 心跳在但扩展已超 45s（`POLL_TTL_MS`）没来取指令 → `attach` 与 `POST /message`
  均回 409 `ATTACH_UNAVAILABLE`（**在入队前就拒**，不让消息在队列里干等 30s×3 重投）
- **从未 poll 过**（扩展刚启动 / 老版本扩展）按 `true` 宽容，不得误拒接管
- 字段可缺省：老 server 不下发 → 客户端按 `true` 容错（保持历史行为），但**不得自动接管**
  `responsive === false` 的终端（`attachDefaultWorthy` 已加此闸门）
- 客户端收到 `ATTACH_UNAVAILABLE` 或 `command_ack {ok:false}` 时，必须把原文退回离线队列并切回
  📱 平行模式：前者自动重发（server 入队前就拒了 = 明确未投递），后者标**手动**重试
  （无法排除“终端其实执行了、只是回执丢了”，自动重发会重复执行）

Claude 同会话并发 attach 共享一次启动；准备中的接管计入 `maxConcurrent`。detach/dispose 可取消
尚未完成的启动。文件静默窗在准备前与启动进程前各检查一次，默认 3000ms；只能降低并发写入风险，
不能锁住原 TUI 或检测一直未写盘的外部计算。

**`config.claudeDriver.enabled=false`（行为收紧，v0.3）**：server 不构造 claude 驱动
（`claudeDriver=null`），此时 claude 源的 `attach`/`detach`/`message` 与 host-requests 端点
一律 **400 `INVALID_REQUEST`**（message「claude 会话接管未启用」）；前端据此回落 📱 平行模式
（与「旧 server 无此路由」同一条回落路径）。`terminal` 也不再下发（灰显原因文案：
「暂无法接管：server 未启用 claude 接管（需 v0.3+ 且 claudeDriver.enabled）」）。

### POST /api/sessions/:id/detach（退出接管）

响应 200：`{ "attached": false }`。未投递指令取消（回执失败原因）；挂起权限请求一律 deny 收尾。

### POST /api/sessions/:id/message（attach 通道发消息）

请求：`{ "text": "…", "mode": "prompt|steer|followUp", "clientMessageId": "可选幂等键", "images": ["可选，Codex 上传图片引用"] }`
响应 202：`{ "accepted": true, "channel": "attach", "commandId": "cmd-…", "mode": "…" }`。
会话不存在 → 404 `SESSION_NOT_FOUND`（此前误报 409 `ATTACH_REQUIRED`——会话不存在不等于
「需要先接管」，409 会误导调用方补一次 attach 再重试）；已知会话但未 attach → 409 `ATTACH_REQUIRED`；
队列满（pi）→ 409 `ATTACH_QUEUE_FULL`；同 `clientMessageId`
重复提交返回同一 `commandId`（不重复入队）。
`images` 允许为 `null`（老客户端显式表达「无附件」的写法），一律视为未传；仅非 `null` 的非数组值才 400。

注入语义（pi=扩展 API `sendUserMessage`；claude=stdin 注入真用户 turn，docs/CLAUDE_DRIVER.md）：
`prompt`=空闲时发（正忙回执失败原因）、`steer`=插话当前 run 后（claude 实测=工具间隙转向）、
`followUp`=排队到 run 待办结束（空闲时等价立即发）。
Claude 忙时的普通 `prompt` 通过 `command_ack{ok:false,error:...}` 报告失败，HTTP 已返回的 202
只表示受理指令，不表示已写入模型；调用方须消费回执。详情见 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)。

Codex 的 steer 使用当前 expectedTurnId，followUp 在本地等前轮完成再提交；中止保留 app-server，退出接管关闭独立进程释放 writer。GET 详情包含当前轮流式快照，保留 `streaming`/`turnId` 与图片，避免刷新时输出丢失。客户端对账使用函数式更新；历史请求期间到达的 WS 消息/终态优先于旧响应，重复历史请求仅采纳最新一项。Codex 发送超时或失败回执时保留原文和原通道供手动核对，禁止自动回退 exec 或自动重发结果未知的 turn。幂等记录仅限当前 hub 进程与 TTL，不承诺跨重启 exactly-once。

### GET /api/sessions/:id/commands/:commandId（Codex 只读回执）

响应 `{ "state": "pending|accepted|failed|unknown", "error": null|"失败原因" }`。HTTP `/message` 的 202 只表示入队；`accepted` 表示原生 Codex 已受理该输入，不代表模型任务完成。回执在内存保留 10 分钟，最多 2000 条，并按会话隔离；重启/过期为 unknown。客户端在原生回执前保留正文和图片；刷新/重连只查询状态，unknown 保留为手动核对，禁止自动重发。明确未提交的 busy/本地队列取消允许同幂等键重试；已提交但结果未知的请求仅重放原回执，不再次执行。旧 v1 离线条目补全为 Codex 来源后也先转为人工核对。

### host 权限请求（Claude / Codex 手机批权限）

非 bypass 环境下工具需确认时，执行进程（接管驱动或平行 spawn）经 `--permission-prompt-tool` MCP bridge 回连（两路径共用同一审批通道与手机卡片）：

- `POST /api/agents/host-requests`（bridge → server，仅本机回环 + token）：
  请求 `{ "sessionId", "requestId", "toolName", "toolUseId", "input", "description?" }`；
  **挂起**至人工应答/超时后返回 `{ "behavior": "allow|deny", "message" }`（bridge 据此回注
  PermissionResult）。超时/收尾一律 `deny`（**绝不自动 allow**）。
- `GET /api/sessions/:id/host-requests`（手机）→ `{ "requests": HostRequestDto[] }`
  （断线重连兜底拉取，防 WS 丢事件卡死；接管与平行模式均适用）。无审批通道的会话（pi 源，权限在终端里确认）按
  「空列表」语义回落 200 `{ "requests": [] }`，不报 400（只读端点向后兼容；写路径应答仍 400）。
- `POST /api/sessions/:id/host-requests/:requestId`（手机）：body 二选一：`{ "outcome": "allow|deny", "message"? }`（审批卡片）或 `{ "answers": { "<questionId>": ["text", ...] } }`（问答卡片 `kind:"question"`，对应 `item/tool/requestUserInput` / elicitation）
  → `{ "resolved": true, "outcome" }`；未知 → 404 `HOST_REQUEST_NOT_FOUND`；已决 → 409 `HOST_REQUEST_RESOLVED`；问答的未知 questionId / 空答案 → 400 `INVALID_REQUEST`（请求保留可重试）。问答超时/收尾不代答：服务端以 respondError 明确告知模型「用户未回答」
  （已决 id 短期记忆 TTL 约 5 分钟、上限约 200 条，过期/淘汰后回 404）。

`HostRequestDto`：`{ id, sessionId, kind: "permission"|"question", title, detail, toolName?, allowAlways?, createdAt, expiresAt, requestType?, turnId?, itemId?, permissions? }`。

Codex 原生三类 `requestType` 为 commandExecution / fileChange / permissions，复用上述手机列表/应答端点，无 MCP bridge。允许仅限当前操作；permissions 仅返回原请求的子集且 scope=turn。问题/elicitation 未提供选择 UI 时安全拒绝，未知服务请求明确 unsupported；认证刷新不经过手机。超时/中止/退出/崩溃清理审批。serverRequest/resolved 仅表示已清理，不推断为用户允许。
bypassPermissions 环境不产生请求（全自动放行，hub 默认即此档位——默认无审批卡片属预期行为）；headless 无 AskUserQuestion（模型文字化提问）。

### 冲突保护

attach 生效期间同会话 parallel 发送（`POST /prompt` 与 WS `prompt`）一律 409 `ATTACH_ACTIVE`
（覆盖 pi 指令队列 / Claude hub 驱动并集）；`/compact` 同样拒绝。detach 后恢复。
parallel 的 busy 判定覆盖本进程 run、hub 驱动接管与最新文件活动；外部 TUI 忙时三种 mode 均拒绝，
只有本服务自有平行 run 的 steer/followUp 会入本地队列。这些检查不能提供跨进程互斥。
心跳超时（pi 90s）/ 驱动进程退出（claude）attach 自动失效并广播 `attach_state {attached:false}`，
web 自动回落 📱 平行模式。

### pi 平行发送的外部活跃闸门（`EXTERNAL_ACTIVE`）

pi 会话文件是 **append-only + leafId 树**：终端 pi 进程与 server 内 SDK 实例各自维护 leafId，
同时 append 会产生同 parent 分叉（一侧消息在 `selectActiveBranch` 回溯下**静默不可见**）；
版本不一致触发 `migrateToCurrentVersion` → `_rewriteFile()`（`openSync(f,"w")` 截断重写）时，
更会用自己内存的 entries 全量覆盖、**永久抹掉对方已追加的行**。

因此 `POST /prompt`（pi 源）与 `POST /compact` 在受理前多一道闸门，三路信号任一命中即 409
`EXTERNAL_ACTIVE`（三种 mode 一律拒，steer/followUp 对外部进程无处投递），message 为可直接展示的中文原因：

| 信号 | 含义 | 文案导向 |
|---|---|---|
| 终端 pi-command 心跳在线 | 终端进程活着就持有自己的 leafId，即使它此刻空闲 | 引导切 🖥 接管模式 |
| live-feed 60s 内有事件 | 终端在跑但未装 pi-command，无法接管 | 说明等 ~1 分钟或装扩展 |
| 会话文件 mtime 在 60s 静默窗内 | 外部 CLI 在写（无任何扩展信号） | 说明稍后重试 |

**防自锁（实现约束，改动时勿破）**，四条：

1. 本进程实例的**最后活动时刻**不早于文件写入（`mtime <= live.lastUsedMs + 5s 容差`，
   `OWN_WRITE_SLACK_MS`）→ 放行。**不能**用 `live.has(id)` 无条件放行：abort 只中止 run
   不删实例（空闲 10min 才逐出），那段窗口里外部写盘必须能拦住（浏览器实测：驻留实例
   让闸门形同虚设）；也**不能**在 run 进行中拦截：SDK 边跑边 append、mtime 一直新鲜，
   拦了 steer/followUp 就自锁。
2. `statuses` 条目带 `source: "own" | "tail"`，mtime 与登记比较时**只信 `own`**：tail 对
   「只有 user 消息、尚无 assistant 回复」的文件会启发式置 idle 回写，采信它会让闸门在同一
   窗口内先 409 后 202 且消息真被执行（浏览器实测）；且 tail 回写不覆盖本进程权威登记
   （否则 run 进行中被盖掉 running，闸门与状态显示都会错乱）。
3. mtime 判据用 `mtime <= own.at` 比较（own 登记更晚 = 本次写盘是自己造成的）。
4. 额外记录 `SessionManager.open` 可能触发的迁移重写时刻（`ownWrites`）——否则
   **手机新建会话后发第一条消息**会被自己的闸门拦死（createSession 写盘刷新 mtime）。

## 13. 应用锁（app lock，F1 新增）

手机 PWA「打开面板先解锁」：PIN/口令只存 **SHA-256 加盐哈希**（`data/app-lock.json`，
**绝不存明文**），解锁成功发短期令牌（7 天），前端存 localStorage，过期/失效显示解锁屏。

**与 `auth.token` 的关系（两者完全独立）**：
- `auth.token` = **API / WS 鉴权**（可选）；live-feed / 指令通道也使用此共享密钥。
- 应用锁 = **界面解锁与操作门禁**：锁屏时前端不挂载业务页面；服务端对普通业务 HTTP API
  校验解锁令牌（缺失 → 423 `APP_LOCKED`，失效 → 401），WS prompt/abort 同样校验。
  `/api/app-lock/*` 的解锁入口、静态资源及本机机器通道 `/api/agents/*`、`/api/live/*` 豁免全局锁门禁；
  机器通道仍受回环与 token 校验，应用锁自身敏感操作另行验证。
- 浏览器 HTTP 使用 `X-App-Lock-Token`，WS 使用 `lock-token.<token>` 子协议；旧客户端的
  `?lockToken=` 兼容读取。前端不把解锁令牌写入 URL，日志对凭据参数脱敏。
  解锁令牌不能替代 `auth.token`，也不等于重新认证已建立的 WS 订阅。

密钥规则：4-6 位数字 PIN，或 8-128 字符口令（passphrase）。哈希口径：`sha256(salt:secret)`，
salt 随机 16 字节 hex 与记录同存；令牌为 32 字节随机 base64url，server 只存 `sha256(token)`。

### GET /api/app-lock/status

响应 200（**不含 hash/salt/token 等任何凭据字段**）：

```json
{ "configured": true, "webauthn": true, "unlocked": true, "expiresAt": 1770000000000 }
```

`unlocked` = 请求头 `X-App-Lock-Token` 命中未过期令牌；`expiresAt` 仅解锁时返回。

### POST /api/app-lock/setup

请求 `{ "secret": "1234" }` → 201 `{ "ok": true, "token": "…", "expiresAt": 0 }`。
已配置 → 409 `APP_LOCK_EXISTS`；密钥非法 → 400 `INVALID_REQUEST`。

### POST /api/app-lock/unlock

请求 `{ "secret": "…" }` → 200 `{ "ok": true, "token": "…", "expiresAt": 0 }`；
错误密钥 → 401 `APP_LOCK_DENIED`；未配置 → 400 `APP_LOCK_NOT_CONFIGURED`。

### POST /api/app-lock/change

请求 `{ "oldSecret": "…", "newSecret": "…" }` → 200 同 unlock（**令牌轮换，旧令牌作废**）。
旧密钥错误 → 401 `APP_LOCK_DENIED`；新密钥非法 → 400。

### POST /api/app-lock/disable

请求 `{ "oldSecret": "…" }` → 200 `{ "ok": true, "configured": false }`（记录整体作废，
不保留任何凭据/哈希）。旧密钥错误 → 401。

### POST /api/app-lock/webauthn/register/start | finish（可选增强，需 `X-App-Lock-Token`）

`start` → `{ "challengeId", "options": { "publicKey": { "challenge", "rp", "user", "pubKeyCredParams", … } } }`
（challenge/user.id 为 base64url，前端转 ArrayBuffer 调 `navigator.credentials.create`）。
`finish` 请求 `{ "challengeId", "credential": { "id", "publicKey", "clientDataJSON" } }`
（`publicKey` = 浏览器 `response.getPublicKey()` 的 base64url SPKI DER）→ 200 `{ "ok": true, "webauthn": true }`。
server 校验 clientData（type=`webauthn.create`、challenge、origin hostname=rpId）并登记公钥；
未解锁 → 401。浏览器不支持 getPublicKey 时前端隐藏生物识别入口（全走 PIN）。

### POST /api/app-lock/webauthn/login/start | finish

`start` → `{ "challengeId", "options": { "publicKey": { "challenge", "rpId", … } } }`（未启用 → 400）。
`finish` 请求 `{ "challengeId", "credential": { "id", "clientDataJSON", "authenticatorData", "signature" } }`
→ server 验签（ECDSA-P256-SHA256 over `authenticatorData || sha256(clientDataJSON)`，另校验
rpIdHash / userPresent / userVerified / signCount 防克隆）→ 200 发解锁令牌（同 unlock 语义）。

### 错误码（本节新增）

| code | HTTP | 含义 |
|---|---|---|
| `APP_LOCK_EXISTS` | 409 | 已配置（改用 change） |
| `APP_LOCK_NOT_CONFIGURED` | 400 | 未配置 |
| `APP_LOCK_DENIED` | 401 | 密钥错误 / 验签失败 / 挑战过期 |

### 离线消息队列（F1，纯客户端，无新增端点）

发送失败（网络错误/5xx）消息进入本地持久队列（localStorage `agent-hub.offlineQueue.v1`，
刷新/杀 App 不丢）；`online` 事件 + WS 重连自动按序重发（复用既有 `POST /prompt` /
`POST /message` 通道，attach 通道以 `clientMessageId=localId` 幂等）。业务拒绝（4xx）标
手动重试不自动重发。附件/图片随消息入队：已上传存引用路径，未上传存 base64（联网后补
`POST /api/uploads`，§15），base64 持久化上限单图 1MB / 队列 3MB，超限提示并退化为本次页面内暂存。
## ttyd Web 终端（F2：同源反代 /terminal/*）

可选增强：ttyd 已安装（POSIX）时，手机 PWA 提供「真终端」入口（iframe 内嵌同源反代页）。
Windows 不支持（hint：「不支持（WSL 内可用）」）；未安装给安装指引（macOS `brew install ttyd`、
Linux `sudo apt install ttyd`）。与 §12 的「终端接管」是两回事：这里是完整 Web 终端。

### GET /api/terminal/status

返回 §2 的 `terminal` 对象（`TerminalStatusDto`）。只探测不拉起进程。

### POST /api/terminal/session

按需拉起 ttyd 并签发访问 URL（201）：

```json
{ "url": "/terminal/?t=<token>", "expiresAt": "2026-02-18T20:00:00.000Z" }
```

- ttyd 未安装/启动失败 → 503 `TERMINAL_UNAVAILABLE`（message 带安装指引）。
- 应用锁门禁（F1 预留 `terminalUnlocked`）返回 false → 401 `UNAUTHORIZED`。

### POST /api/terminal/stop

回收 ttyd（幂等，`{"stopped": true}`）；server 关闭 / 空闲 30min 也会自动回收。

### 同源反代 /terminal/*（非 REST：HTML/资源/WS）

- `GET/POST /terminal/*` → ttyd 端口（仅 127.0.0.1，随机高端口，随机 Basic 凭证由反代注入，
  浏览器不弹原生认证）。HTML 响应注入 shim：WebSocket URL `/ws` → `/terminal/ws`（避开 hub 的
  /ws 通道）并透传 token；绝对资源路径改写到 `/terminal/` 前缀。
- `WS /terminal/ws`：upgrade 字节流管道到 ttyd `/ws`（同样 token 校验 + 凭证注入）。
- 鉴权：token 能力凭证（`?t=` 查询串）或 `hub-terminal-token` HttpOnly Cookie（Path=/terminal）。
  无效/过期 → 401 信封；ttyd 未运行 → 503。token 校验不过的 upgrade 直接断连。
- 与 SPA 路由 `/terminal`（无斜杠）不冲突：`/terminal` 回前端页面，`/terminal/*` 走反代。
## 14. Token 用量统计（GET /api/usage，pi + codex 源）

pi 会话 JSONL 中每条 assistant 消息的 `message.usage` 记录一次 API 调用的用量，
聚合即逐条求和（坏行 / 缺 usage 字段优雅跳过）。codex 源：rollout JSONL 每条
`token_usage_record` 的 `payload.usage` 记录一次 API 调用用量（input_tokens /
output_tokens / cached_input_tokens / cache_write_input_tokens /
reasoning_output_tokens / total_tokens 映射同名维度，无费用数据 `costTotal` 恒 `null`），
含 `~/.codex/sessions/` 与 `~/.codex/archived_sessions/`（含归档会话）；同一会话跨多个
rollout 分段文件时采样合并为一条会话汇总。claude 源延后。

### GET /api/usage（全局汇总）

```json
{
  "windows": {
    "today":     { "totalTokens": 14085, "input": 1784, "output": 13, "cacheRead": 12288, "cacheWrite": 0, "reasoning": 10, "costTotal": 0 },
    "last7Days": { "totalTokens": 98000, "input": 9000, "output": 800, "cacheRead": 80000, "cacheWrite": 3000, "reasoning": 400, "costTotal": null },
    "all":       { "totalTokens": 260000, "input": 20000, "output": 3000, "cacheRead": 210000, "cacheWrite": 9000, "reasoning": 1200, "costTotal": 12.5 }
  },
  "range": { "days": 30, "usage": { "totalTokens": 260000, "input": 20000, "output": 3000, "cacheRead": 210000, "cacheWrite": 9000, "reasoning": 1200, "costTotal": 12.5 } },
  "sessions": [
    {
      "sessionId": "uuid-1",
      "name": "pi-report-KPI",
      "updatedAt": "2026-02-18T11:58:00.000Z",
      "usage": { "totalTokens": 14085, "input": 1784, "output": 13, "cacheRead": 12288, "cacheWrite": 0, "reasoning": 10, "costTotal": 0 }
    }
  ]
}
```

字段口径：
- `windows.today`：今日（本地时区 0 点起）；`windows.last7Days`：近 7 个自然日（含今日）；
  `windows.all`：全部（含时间戳缺失的采样，此类采样只计入 `all`）
- `range`：仅带 `?days=N` 时返回，最近 N 个自然日（含今日，N 为 1..3650 整数）
- `costTotal`：`cost.total` 求和；数据源全程无 `cost` 字段时为 `null`（`0` 是有效金额，勿混淆）
- `sessions`：仅含有 usage 采样的会话，`updatedAt` 倒序（采样时间与文件 mtime 取新），
  `usage` 为该会话全量汇总（codex 跨分段文件合并）；单文件损坏 / 无采样会话不影响整体

### GET /api/usage?sessionId=（单会话汇总）

```json
{
  "sessionId": "uuid-1",
  "name": "pi-report-KPI",
  "updatedAt": "2026-02-18T11:58:00.000Z",
  "windows": { "today": {}, "last7Days": {}, "all": {} },
  "range": { "days": 7, "usage": {} }
}
```

- 会话存在但无 usage 采样 → 三窗口全 0（`costTotal: null`），仍 200
- `sessionId` 不存在 → 404 `SESSION_NOT_FOUND`
- `?days=` 非法（非 1..3650 整数）→ 400 `INVALID_REQUEST`（错误信封同 §1 约定）

### 前端呈现（口径）

- 工作台「今日概览」：今日 tokens / 近 7 天 tokens；会话列表行内显示该会话 tokens
- 加载失败 / 无数据安静降级（占位或隐藏），不阻塞其它面板

## 15. 文件上传（POST /api/uploads）

chat 输入区上传文件/图片：base64 JSON 落盘到会话 `cwd/.agent-hub-uploads/`，产出可引用路径
（配合 `@path` 引用与 `POST /prompt` 的 `images` 附件，§1/§10）。

### POST /api/uploads

请求（`Content-Type: application/json`，body 上限 14MB）：

```json
{
  "sessionId": "uuid-or-slug（推荐）",
  "cwd": "/abs/path（可选，与 sessionId 均缺省时兜底临时目录）",
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "data": "<base64，不含 data: 前缀>"
}
```

响应 201：

```json
{
  "upload": {
    "name": "report.pdf",
    "path": ".agent-hub-uploads/report.pdf",
    "absPath": "/Users/me/Workspace/demo/.agent-hub-uploads/report.pdf",
    "mimeType": "application/pdf",
    "size": 12345,
    "isImage": false
  }
}
```

说明：
- 落盘目录 `<cwd>/.agent-hub-uploads/`；`name` 清洗（最长 100 字符，空名回退 `upload.bin`），
  重名自动 `name-1.ext`、`name-2.ext`… 去重。
- `path` = 可引用路径：cwd 内为**相对路径**（`.agent-hub-uploads/x.png`，`@` 引用与 prompt
  `images` 用它）；cwd 不可用时兜底临时目录，`path`/`absPath` 为绝对路径。
- **写入范围约束（防任意目录写入）**：带 `sessionId` 时 cwd 取该会话归属目录（不存在 →
  404 `SESSION_NOT_FOUND`）；带 `cwd` 时必须是绝对路径且落在 `workspaceRoot` 或已知会话
  cwd 内（否则 400 `INVALID_CWD`）；`sessionId` 与 `cwd` 均缺省则兜底临时目录
  `<tmpdir>/agent-hub-uploads/`（201 正常落盘，不报 400）。realpath 二次校验防符号链接逃逸
  （越界 → 400 `INVALID_PATH`）。
- 类型白名单：MIME 白名单（image/png、image/jpeg、image/webp、image/gif、image/avif、
  image/bmp、image/svg+xml、text/plain、text/markdown、text/csv、text/html、
  application/json、application/pdf、application/zip、application/x-tar、application/gzip）
  优先；`application/octet-stream`/缺失走扩展名兜底（含常见代码/文本扩展名）；都不命中 →
  415 `UNSUPPORTED_MEDIA_TYPE`。MIME 命中时扩展名以规范值统一（防伪装）。
- `isImage` = MIME 属 image/*（决定 UI 缩略图预览；prompt `images` 仅收图片，非图片 → 415）。
  pi 通过 SDK ImageContent 直接附图；Claude 与 Codex parallel CLI 以文本 `@path` 提示 agent 读文件；Codex attach 通过原生 localImage 发送，
  不应将缩略图已显示理解为 CLI 已直接收到原生图片块。
- 大小上限：单文件 10MB（超出 413 `UPLOAD_TOO_LARGE`）；`data` 非法 base64 / 空文件 →
  400 `INVALID_REQUEST`。

### 错误码（本节新增）

| code | HTTP | 含义 |
|---|---|---|
| `SESSION_NOT_FOUND` | 404 | `sessionId` 不存在 |
| `INVALID_CWD` | 400 | cwd 非法 / 不在 workspaceRoot 或已知会话目录内 |
| `INVALID_PATH` | 400 | 上传路径越界（含符号链接逃逸） |
| `UPLOAD_TOO_LARGE` | 413 | 文件超过 10MB 上限 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 不在 MIME/扩展名白名单 |

### Codex 权限与实时对账补充（2026-10-21）

- `attach_state` 的 Codex 事件可附带 `source: "codex"` 与可选 `effectivePolicy`；老事件缺字段时按未知处理。退出接管清理旧策略。
- Codex 平行与接管共用 `codexDriver.approvalPolicy` / `sandbox`，默认 `never` / `danger-full-access`，也允许显式收紧或 inherit。接管先取得基线，再释放探测进程、以新进程应用不同的策略；最终回显必须符合申请，未申请覆盖的维度不得随之放宽。缺少/不符的回显返回 400 `INVALID_REQUEST`，不发起 turn；准备/释放期仍阻止平行发送。
- `bypass` 只取决于 approval=never；不能把 danger-full-access 沙箱等同于无审批。
- 前端 GET 对账以请求开始时的本地事件版本保护随后到达的消息，消息 timestamp 只用于排序，不充当删除依据。压缩后的下一次 GET 重新建立基线。
