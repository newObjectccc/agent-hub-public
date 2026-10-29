# Codex app-server 驱动：能力与限制

hub 的 Codex 源有两种驱动通道：**接管**（hub 自持 app-server 子进程，持有线程写者锁）与**平行**（`codex exec` 续写）。本页描述驱动的能力边界、权限模型、协议契约与已知限制。官方依据是 [app-server 文档](https://learn.chatgpt.com/docs/app-server)，协议形状另与本机 `0.162.0-alpha.17.2` 导出的 schema 核对。模拟实验台见 [examples/codex-app-server-lab](examples/codex-app-server-lab/)，Claude 对照见 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)。

文中的行为结论来自三类证据：真实运行的人工观察（含手机真机端到端）、导出 schema 的协议定义、实验台模拟子进程断言。模拟断言不能代替真机验证；可复现验收只操作自建临时线程，不应读取私人线程正文、凭据文件或登录 shell 配置。原始错误串按原样保留，便于排障时 grep。

## 能力概述

app-server 提供 `thread/resume`、`turn/start`、原生 `turn/steer`、`turn/interrupt` 和审批 ServerRequest，作为 hub 自持会话的驱动接口；列表、搜索、离线历史使用本地 rollout 解析，不依赖 `thread/list`。

当前实现（生产驱动见 `server/src/adapters/codex-driver.ts`、`codex-rpc.ts`、`codex-host-protocol.ts`，不是仅有实验脚本）：

- 每个接管会话独立 app-server 进程，版本最低 `0.162`（含对应 alpha）；完整握手与 idle resume 成功后才返回 attached。并发默认 3，准备期也占名额；同会话共享一次启动。旧版本不具备本驱动要求的互斥契约时明确拒绝，不回落 exec。
- 原生 `turn/start`、带 expectedTurnId 的 `turn/steer`；followUp 在本地排队，前轮完成后才发送。`prompt` 正忙通过失败回执告知。10 分钟内同 clientMessageId 返回原 commandId；这是进程内幂等，跨 hub 重启不保证。
- abort 使用 `turn/interrupt`，保留进程；清理待办与当前审批。detach / crash / timeout 取消挂起请求并关闭进程释放自身 writer；释放尚未完成时拒绝重新 attach。
- 命令、文件与 permissions 三类原生审批显示手机卡片，刷新后可重新拉取。只允许当前操作；permissions 仅回授原请求的权限子集且 scope 固定 turn。超时、退出、中止全部拒绝；已清理不冒充「用户允许」。
- 审批按 turn 与原生 requestId 共同关联，原生 ID 跨轮复用不会漏卡或批准到另一轮；文件审批展示同轮同 item 的有界 diff，缺少 diff 时明确告知。
- requestUserInput 与 elicitation 走**手机问答卡片**（`kind: "question"`）：逐题选项/自由文本应答，未作答（超时/取消/收尾）明确告知模型未回答、绝不代答；认证刷新或凭据类请求（`account/chatgptAuthTokens/refresh`、`attestation/generate`、未知方法）不上手机、给安全的 unsupported。
- 已校验的上传图片以 localImage 发送（图片路径在驱动内部二次校验，只接受会话上传目录内的真实文件；越界附件降级为文本提示，绝不静默丢），图片预览保留在回执与重连快照；进行中回复用当前轮快照与 rollout 对账。
- 并行通道与接管准备/执行互斥。CLI 返回内容按 UTF-8 增量解码并处理无换行尾帧；准备期取消和外部忙状态均有回归测试。
- 手机接管失败、写者冲突或受理状态不明时保留消息供手动重试，绝不自动改走 exec。Codex 不投屏原桌面窗口；原线程被桌面持有时需先退出原会话再接管。
- 重进时恢复手动接管选择，即使驱动尚未启动也重新握手；握手失败或驱动断开后仍保留接管通道，允许重新点选接管重试。选择平行模式须由用户明确切换。

边界：写者互斥的观测只覆盖两个自持进程的测试范围，不证明可以接入桌面正在持有的线程、接收桌面进程的事件或镜像桌面 UI。发生 active-writer 冲突、已提交请求超时或受理状态未知时，必须停止并报告状态；不得自动转入 exec 重试，以免重复 turn 或双写。`thread/list` 不可靠（不同版本返回条数可从个位数到上百），列表必须自研扫描。

## 接管与平行：行为与权限模型

### 通道差异

接管通道 spawn `<codexBin> app-server`（stdio，hub 代理事件，不暴露公网 socket）；平行通道走 `codex exec`。hub 自身的两条通道在准备与执行期互斥；外部客户端、旧版本或绕过 hub 的写入不在这个保证范围内。

**两通道 env 注入不一致（已知限制）**：接管通道只继承 `process.env`，**不注入 provider env**（预留的 `prepareEnv` 钩子在生产装配处未接线，也没有对应配置开关）；平行通道相反，spawn 时经 `mergeProviderEnvSync` + `prepareProviderEnv`（默认 `loadProviderEnv`）注入登录 shell / settings 里的白名单键（`ANTHROPIC_*` / `CLAUDE_CODE_*` / `OPENAI_*`，**不含 `CODEX_*`**）。后果：把自建网关写在 `~/.zshrc`（`OPENAI_BASE_URL` / `OPENAI_API_KEY`）的用户，**平行能发、接管会失败**——与「手机发消息报 no login」同类的坑，方向相反。计划修法：把 `prepareEnv` 接成 `loadProviderEnv` / `mergeProviderEnvSync` 并做成显式配置项（默认关；开启时向用户说明会执行登录 shell、可能触发 rc 的任意副作用）。当前默认不执行登录 shell（接管通道只继承 `process.env`）。

### 权限策略（approvalPolicy / sandbox）

Hub 的 `codexDriver.approvalPolicy` / `sandbox` 同时控制平行和接管，默认 `never` + `danger-full-access`：免操作审批、完整文件与网络访问。该默认值以当前系统账号与管理员策略为界，与 pi 默认直接执行工具、Claude 默认 `bypassPermissions` 对齐。

- `approvalPolicy` ∈ `inherit` | `never` | `untrusted` | `on-request`
- `sandbox` ∈ `inherit` | `danger-full-access` | `read-only` | `workspace-write`

显式档位既可放宽也可收紧。`inherit` 才不下发覆盖、沿用本机配置；已有显式配置会在升级时保留。权限值拼错、未知/误放字段、非对象配置在监听前报 `CONFIG_INVALID`，不会回落最高权限。

平行路径通过逐进程 `-c approval_policy=...` / `-c sandbox_mode=...` 下发配置；接管先不带覆盖恢复，取得实际基线。需要更换档位时先确认旧 writer 退出、等待文件静默，再创建新 app-server 应用配置。0.162 实测同进程重复 `thread/resume` 会忽略新参数，因此必须重建进程。最终回显须与显式申请相符；未申请覆盖的维度及其细粒度网络/目录/临时目录限制不能顺便放宽。回显缺少或不符就停止，不执行 turn。准备与释放阶段持续占用会话互斥名额。

这两种路径均不改写用户全局 config.toml；策略核对仅取 RPC 回显，不读取凭据文件。模型向用户提问或 MCP elicitation 仍使用手机问答卡片，不因免操作审批而代答。

本机 0.164.0-alpha.11.1 的无模型元数据核对确认，`thread/start` 回显 `never` 与 `dangerFullAccess`；未调用模型或执行工具。该版本已不支持 CLI 启动配置 `untrusted`，使用该旧档位时需核对版本，不能静默降级到其他策略。

官方参数含义见 [CLI 配置覆盖](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 与 [app-server](https://learn.chatgpt.com/docs/app-server)。

### 生效策略回显（effectivePolicy）

接管建立后，`thread/resume` 协议回显的实际生效策略会归一化为 `effectivePolicy`（`approval` / `sandbox` / `bypass` 三字段，kebab-case；取不到的维度记 `"unknown"`），随 attach 202 响应与 `statusFor` 下发：

- `bypass: true` 仅表示生效审批策略为 `never`。文件访问范围与审批是独立维度；`danger-full-access` 不能单独用来判定没有审批。
- 回显缺失时（老版本/驱动未回传）字段不下发，前端按「未知」容错，**不得把缺省当成安全档位**。
- 数据只来自协议回显，绝不读 `~/.codex/config.toml`。

### 生命周期与互斥

- 写者互斥判定以错误码为准（`-32600`，`isWriterConflict()`），文案正则仅作旧版本兜底；能力探测仍只凭版本号推断 writerLock，未真观测锁本身。
- mtime 静默窗（`externalQuietMs`，默认 3s）只作附加线索，不能代替锁；会话文件近期被写入时拒绝接管（「电脑端正在写入该会话」），文件不可核对时保守拒绝。
- detach 关闭子进程释放自身 writer；unsubscribe 可能存在宽限期，不能把应答视作 writer 已释放。
- 归档会话需先在 Codex 中恢复再接管。

## 审批与手机批权限

### 三类审批卡片与验证范围

| 方法 | 协议应答 | 验证范围 |
|---|---|---|
| `item/commandExecution/requestApproval` | `{decision:"accept"\|"acceptForSession"\|"decline"\|"cancel"}` | 受控浏览器 + fake app-server 通过；真实原生审批待验 |
| `item/fileChange/requestApproval` | 同上 | ⚠️ 仅 fake-spawn 单测，真机 0 次 |
| `item/permissions/requestApproval` | `{permissions:<GrantedPermissionProfile>,scope:<PermissionGrantScope>,strictAutoReview?}`，权限子集回授、scope 固定 turn | ⚠️ 仅 fake-spawn 单测，真机 0 次 |

只允许用户明确选择的决策；未支持的形状明确取消或 unsupported，不能伪造授权。现有 [验收记录](acceptance/codex-mvp-2026-10-16.json) 的真实模型链路没有审批请求（hostRequestCount 为 0）；[浏览器验收](acceptance/codex-mvp-2026-10-16/README.md) 的允许、拒绝、刷新恢复和文件副作用均来自受控 fake app-server。不能把这两组记录合并成“手机真实原生审批已验证”。历史人工观察保留为待补证据，真实命令、文件与 permissions 审批分别待验。

### 默认全自动与可选手机审批

默认 `never` + `danger-full-access` 下，命令与文件工具直接执行，不出现操作审批卡片，这是预期行为。显式 `inherit` 时，实际审批取决于本机设置。`on-request` + `read-only` 下模型也可能直接返回 BLOCKED 而不请求审批；单次没有请求不能用来证明审批通道可用。

**为什么是认知风险**：前端文案曾暗示有门禁（「回复与审批将在此同步」，`web/src/api/attach.ts`、`web/src/pages/ChatPage.tsx`），用户看到「审批」会以为危险操作会先问手机；空转配置下**根本不会问**。现在前端通过详情、attach 响应与 WS 读取 effectivePolicy，持续展示实际审批和文件访问范围；never 明确不请求审批，on-request 明确只在模型申请时询问，缺省显示未知，退出/重新接管不沿用旧进程的策略。

**要让「手机批权限」真生效**：可申请 `approvalPolicy: "on-request"`，由模型申请时提示；旧版也可用 `untrusted`（真实原生审批闭环待验，接管会核验实际回显）。`on-request` 不足以稳定触发审批。`hostRequestCount: 0` 只说明那一轮没有审批请求，不能单独证明审批关闭或批准链路可用。

### 交互式请求（手机问答卡片）

`item/tool/requestUserInput`（工具向用户提问）与 `mcpServer/elicitation/request`（MCP 输入收集）在手机端渲染问答卡片（HostRequestCard `kind: "question"`）：`questions` 形如 `{id, header, question, options:[{label, description}]}`（无 options 为自由文本；elicitation 按 `requestedSchema.properties` 映射，enum 转选项），用户逐题作答后提交。协议应答形状为 `{"answers":{"questionId":{"answers":["user text"]}}}`（按问题 id 映射；不能写成 answers 数组），**绝不代用户自动选第一个答案**：超时 / turn 终态 / detach / 取消一律 respondError 明确告知模型「用户未回答」。问题文本过脱敏预览（凭据/秘密不出手机）。`account/chatgptAuthTokens/refresh`、`attestation/generate` 与未知方法仍给安全的 unsupported / 取消结果并收敛状态；不得静默挂起或输出秘密。

## 协议契约要点

### 进程与握手

```text
<configured codexBin> app-server
env: { ...process.env }   # 接管通道不注入 provider env，见「通道差异」
transport: stdio (hub proxies events; do not expose a public app-server socket)
initialize {clientInfo, capabilities?: {experimentalApi: true}}
initialized   # notification, after initialize succeeds
```

app-server 不是所有接口都依赖 experimentalApi。仅在使用明确标为 experimental 的接口时启用该 capability，并对所需方法和版本进行探测。日志、错误和 artifact 使用字段白名单，不记录输入、模型正文、命令正文、stderr 原文、鉴权响应或 ServerRequest 完整参数。禁止通过附加参数绕过审批和沙箱。

### 请求

| 用途 | 方法 | 关键参数 / 行为 |
|---|---|---|
| 接管明确选定的线程 | thread/resume | `{threadId, excludeTurns:true, ...explicitOverrides}`；会占 writer，不能随意自动选择历史线程 |
| 新线程 | thread/start | `{cwd, sandbox, approvalPolicy, model?}`；实验只用隔离临时 cwd |
| 发消息 | turn/start | `{threadId, input:UserInput[], effort?, model?, ...}` → `{turn}` |
| 原生运行中插话 | turn/steer | `{threadId, expectedTurnId, input}` → `{turnId}`，必须等于活跃 turn |
| 中止 | turn/interrupt | `{threadId, turnId}`；以匹配 turn/completed 的 interrupted 确认结果 |
| 退订 | thread/unsubscribe | 仅退订；可能存在宽限期，不能把应答视作 writer 已释放。MVP 可关闭每会话子进程释放自身所有权 |
| 历史 | thread/turns/list、thread/items/list | paginated 使用 excludeTurns 后按能力分页；0.162 中 items/list 尚返回 -32601，历史可保留 rollout 解析 |
| 只读自检 | --version、account/read、model/list、thread/list | account/read 使用 refreshToken:false；旧接口 getAuthStatus 只保留账号模式，永不输出 authToken |
| 可选能力 | experimentalFeature/list、permissionProfile/list | 显式启用需要的实验能力；方法不存在可标为 unsupported，其他协议错误不能伪装成功 |

`UserInput` 文本可写为 `{"type":"text","text":"...","text_elements":[]}`；新版 schema 中 text_elements 默认 `[]`，不是必填。图片等输入应按对应版本 schema 实现，不能仅因存在 localImage 就标记产品已支持。

### ServerRequest：必须应答并保留关联

| 方法 | 协议应答 / 客户端策略 |
|---|---|
| item/commandExecution/requestApproval | `{decision:"accept"\|"acceptForSession"\|"decline"\|"cancel"}`；只允许用户明确选择的决策 |
| item/fileChange/requestApproval | `{decision:"accept"\|"acceptForSession"\|"decline"\|"cancel"}`；基础审批应纳入 MVP |
| item/permissions/requestApproval | `{permissions:<GrantedPermissionProfile>,scope:<PermissionGrantScope>,strictAutoReview?}`；形状依 schema，未支持时明确取消或 unsupported，不能伪造授权 |
| item/tool/requestUserInput | `{"answers":{"questionId":{"answers":["user text"]}}}`，按问题 id 映射；不能写成 answers 数组或自动选第一个答案 |
| mcpServer/elicitation/request、item/tool/call、account/chatgptAuthTokens/refresh、attestation/generate | 未实现时给安全的 unsupported / 取消结果并收敛状态；不得静默挂起或输出秘密 |
| 旧版 execCommandApproval / applyPatchApproval | 如需支持，单独适配旧 schema，不能假定与新版决策形状相同 |

请求必须携带 threadId / turnId / requestId 关联，处理重复决策、超时、进程退出和 serverRequest/resolved。resolved 只证明已回答或已清理，不证明 allow，也不证明命令执行成功；工具完成和 turn 终态需分别确认。

### 通知与状态

| app-server 通知 | hub 行为 |
|---|---|
| thread/started | 线程已加载；读取 thread.status，不能直接映射 running |
| thread/status/changed | idle → idle；active → running；systemError → error；notLoaded 表示未加载 |
| turn/started | 记录当前 turnId，映射 running |
| item/agentMessage/delta | 按 thread / turn / item 合并流式正文；日志只记长度和数量 |
| item/started / item/completed | 工具开始 / 结束；命令开始必须用该事件证明，不能以等待几秒代替 |
| turn/completed | completed / interrupted / failed 才是本轮终态；映射 idle / idle / error，并且一次收敛 settled |
| error{willRetry} | 可重试错误不是终态；willRetry:true 时只记录不下发，留待终态兜底（已实现，见「已知限制」回归项），不能提前 idle 或触发 exec 重试 |
| serverRequest/resolved | 清理对应卡片，决策结果保持未知，除非客户端已经记录了明确答复 |
| usage、rate limits、account 更新 | 可选增强，使用元数据白名单 |

JSON-RPC 客户端需处理 UTF-8 跨块与无换行尾行；请求表、等待器、行缓冲与事件历史必须有上限。waitFor 以 cursor 和 thread / turn 过滤竞态，已消费历史不能重复命中下一轮。spawn error、close、写入失败、handler 异常或超时都要拒绝等待并清理 timer；异步 handler 必须 await 后应答。未知 ServerRequest 返回 -32601，不能写出 Promise 或无限等待。

### 能力失败与所有权

版本 / 方法不兼容发生于任何 turn 提交前时，可以向用户说明该模式不可用，由用户选择其他模式。active writer 或提交后超时 / 断连代表所有权、受理状态不确定；**不自动转 exec、不自动重放用户消息**。

command/exec 的 PTY 是独立命令的执行与输入输出通道，不能直接等同于完整 chat 会话投屏或取代现有镜像实现。新版 `codex queue --remote` 可列入独立待测项；当前没有证据证明它能连接用户桌面正在运行的会话。

## 版本兼容与关键行为差异

### 版本矩阵

本机 PATH `0.143.0` 与桌面内嵌 `0.162.0-alpha.17.2` 存在兼容差异：

| 二进制 | exec（历史记录） | app-server（历史记录） |
|---|---|---|
| 0.143.0 | gpt-6.1-sol / ChatGPT 认证曾返回 400；曾见 models cache 字段不兼容 | 同模型曾返回 400；paginated 与 writer 互斥有缺口 |
| 0.162.0-alpha.17.2 | 同模型也曾返回 400；未证明更换版本可修复 | 曾完成真实 turn（含 PONG 标记）；需用修订断言复测 |

要定位根因，必须对「旧 / 新版本 × exec / app-server」四格固定相同 cwd、模型、认证来源、provider 环境与配置，并记录实际返回。版本错配与缓存报错是风险线索，不能据此宣称单一根因。model/list 只描述元数据，不证明账号权限、路由或实际请求成功。**不能声称更换二进制已经修复 exec，也不能仅凭 model/list 证明账号可调用模型。**

hub 已支持配置 codexBin，并显示所选二进制版本与线程 cliVersion 的差异。桌面内嵌路径可用于明确指定的比较测试，但属于随应用升级可能变化的私有路径。不要自动升级、安装 standalone 或切换二进制来改变用户环境。

### 协议行为实测要点

以下观察来自真实运行与实验台，保留给排障与复测参考（历史脚本缺少严格断言，部分依靠固定等待或复用样本，不能代替当前验收）：

- 两版本均可启动 stdio app-server，initialize 约 0.6–1.0s；完整握手还必须发送 initialized；部分实验接口需显式声明 experimentalApi。
- `thread/list` 跨版本返回条数不稳定（2 vs 129），不应被视作完整事实源；分页与过滤条件需保留。
- 旧版可 resume legacy 线程；paginated 返回 -32601。resume 可能占 writer 或更新元数据，不能作为随机私人线程的只读探针。
- 新版 turn/completed 为 completed 并返回 PONG 标记；历史成功不代表 exec 或所有模型可用。
- steer 返回同一 turnId、最终回复转向；证明「插话发生在命令执行中」需等待匹配 command item/started 后再断言，固定等待不行。
- command requestApproval 的 accept/decline 应答后 turn 可收尾；「拒绝后无副作用」的证据需隔离目录重测（共享样本会污染）。fileChange / permissions 未实测。
- `on-request` + `read-only` 场景中模型可直接回复 BLOCKED、没有审批请求；单次未触发不是通道不可用，验收必须断言请求确实出现。
- interrupt 后出现 interrupted、后续请求可受理；「中断发生于命令执行中」不能靠固定等待证明，后续只收到 inProgress 不等于后续 turn 成功。
- 新版第二个自持进程 resume 同一线程返回 active writer；旧版曾允许第二 writer。只覆盖两个自持进程；锁的生命周期、版本组合与桌面持有场景需独立验证。
- Default mode 未触发 requestUserInput，模型以文字提问；不得替用户自动选第一项。
- daemon start 因缺 standalone 安装失败；没有安装、共享 daemon 或桌面 rejoin 的成功证据，不能推导安装后一定能连接桌面。
- rollout 解析可读新版消息、工具与 steer 输入；曾见 unknown 工具名与空 assistant 气泡（后者已在渲染层与快照层过滤，见「已知限制」）。改进解析器应以受控 fixture 验证。
- 观察到 tokenUsage、rateLimits、account 更新通知（可作增强）；账号通知与响应只输出白名单元数据，绝不输出 token 或完整正文。
- `exec` 在非 git / 非 TUI 信任目录的 cwd 拒收；app-server 可在实验 cwd 起 thread。hub 平行通道以 `--skip-git-repo-check` 豁免该入口防呆（2026-10-23 实测：0.163 下 `Not inside a trusted directory and --skip-git-repo-check was not specified.` 拒收所有非 git 会话消息，config 的 `trust_level` 条目对 exec 无效；用户策略明确为默认信任）。该 flag 只豁免目录检查、不触碰审批/沙箱；`--dangerously-bypass-*` 红线不变。

### 冷启耗时

历史观察：thread/start 约 1.5–4.7s、内置 MCP 最长约 23s、首 delta 约 14s。适合在一次接管内复用进程（长驻 + 预热）；这些数字不是延迟承诺。

### 模型 400 与版本错配（排障）

**现象**：手机给 codex 会话发消息 → `error` 事件 + 原始错误串：

```text
The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.
```

0.143 与 0.162 二进制都出现过该串（0.162 的 `model/list` 里 `gpt-6.1-sol` 在列，说明 0.143 的模型元数据表太旧）。平行模式（`codex exec resume --json`）同样失败。旁证：`codex exec` 还打出

```text
ERROR codex_models_manager::cache: failed to load models cache: missing field 'base_instructions' at line 139
```

即 0.143 在读 0.162 写出的 `~/.codex/models_cache.json`，字段不兼容。

**已确认的兼容风险**：历史会话由桌面 app 内嵌的 `0.162.0-alpha.17.2` 写出（rollout `session_meta.payload.cli_version`），而 hub 当时走 PATH 上的旧版；缓存字段与协议能力存在差异。这不能单独解释模型 400，仍须完成前述四格对照。

**运行时部署选择**（需用户明确选择，不自动安装或升级）：

1. 让 hub 的 `codexBin` 指向已验证所需握手能力的桌面 app 内嵌二进制：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` —— app 私有路径、随 app 升级变动，必须可配置 + 可探测。
2. 按所用安装渠道升级 PATH 二进制；当前驱动要求至少 0.162（含对应 alpha），并核对会话格式与协议兼容性。
3. 官方 standalone 安装（`~/.codex/packages/standalone/current/codex`）可作为另一种安装渠道；daemon 共享与桌面重入仍需独立实测。

hub 二进制不必与桌面 App 的版本号完全相同；0.162 是当前驱动对协议能力设置的最低门槛，不代表该版本能保证模型可用。高于门槛仍须通过握手、权限回显与会话格式检查。

**当前状态（配置与诊断已实现，模型调用仍独立验收）**：

- `codexBin` 是配置项并逐字段校验（`server/src/config.ts` 的 codexBin 校验：非空字符串、拒绝 `\0\r\n`、含路径分隔符或 `~` 走 `expandPath` 按配置目录解析，非法值告警并回落 `codex`）；CLI 平行通道与接管通道共用同一设置（`server/src/index.ts` 装配处）。
- 只读版本诊断落地：`cli/lib/codex-runtime.js`（解析实际二进制 → `--version` → 有限采样 rollout 头 `cli_version`；运行版本低于采样历史版本时告警「请核对 codexBin」），`node cli/check.js` 输出「Codex 运行时 / Runtime (read-only)」段。
- 驱动侧硬门槛：`probeCodexCapabilities` 只认 `>= 0.162`，旧版直接拒绝接管且不回落 exec。
- 版本 compatible 只表示数字版本比较没有发现落后，不等于模型、认证或 provider 已验证可用。

**仍未证明**：换二进制是否修好 `exec`（平行）通道——见上文四格矩阵。

### 新建会话的 session_meta 最小字段集

**问题**：hub 新建 codex 会话时自己写「最小 rollout」文件；早期实现只写一行 `session_meta`（顶层 3 键 `timestamp,type,payload`，payload 7 键），而 codex 0.162 自己写出的 meta 顶层 4 键（多 `ordinal`）、payload 15 键。0.162 的 thread-store 读不懂残缺 meta，接管与平行两条路都发不出第一条消息，原始错误串（文案有误导性——文件并不空，「is empty」实际是 meta 读不出来）：

```text
-32603 failed to read thread: thread-store internal error: failed to read session metadata <file>: rollout at <file> is empty
```

平行通道 `codex exec resume <id> --json` 报完全相同的 -32603（同一 thread-store 读盘路径）。已有老会话不受影响（meta 由 codex 自己写）。早期未暴露是因为 0.143 容忍 7 键 meta——这是升级到 0.162 后暴露的兼容回归（claude 侧同类坑已以 `isMeta` 占位行实测规避，见 `claude.ts`）。

hub 写会话只写 meta 行（名字登记 `session_index.jsonl` 与 idle 状态照常），正文由 codex CLI 落盘。**逐字段实测（真机 0.162，只看 `thread/resume` 结果）**：

| 写入的 `session_meta` 变体 | `thread/resume` 结果 |
|---|---|
| 顶层 3 键 / payload 7 键（旧实现） | ❌ `-32603 ... rollout at <file> is empty` |
| 现状 + 顶层 `ordinal:0` + `history_mode:"legacy"` | ❌ 仍 `-32603 ... is empty` |
| 再加 `cli_version` + `source` + `model_provider` + `runtime_workspace_roots` + `git` | ✅ RESUME-OK（`status.type:"idle"`） |
| 上一行去掉 `cli_version` | ❌ `-32603 ... rollout at <file> is empty` |
| 上一行去掉 `model_provider` | ❌ `-32600 failed to load configuration: Model provider `` not found` |
| 单独去掉 `source` / `runtime_workspace_roots` / `git` / `history_mode` | ✅ 各自都能 RESUME-OK |
| `cli_version` 写旧值 `"0.143.0"` | ✅ RESUME-OK（该字段不做严格版本门） |

**结论（最小必需字段集）**：

- 真必需的只有 **`cli_version`** 与 **`model_provider`**（前者缺失报 -32603 “is empty”，后者缺失报 -32600 “Model provider `` not found”）。
- `ordinal` / `source` / `runtime_workspace_roots` / `git` / `history_mode` 非必需；照真实产物写齐可降低未来版本变挑剔的风险。
- `creator_user_id` / `creator_account_id` / `context_window` 非必需，且 hub **绝不能为填它们去读 `~/.codex/auth.json`**（硬规则 1：不读取、不记录、不回显任何凭据）。
- `history_mode` 若要写就写 `"legacy"`：0.143 与 0.162 都能读 legacy，`paginated` 在 0.143 上会 `-32601 paginated_threads is not supported yet`。
- `cli_version` / `model_provider` 必须来自探测/采样真值（`codexBin --version` + 已有 rollout 头采样），不能写死假值；两者都拿不到时应报错而不是落盘残缺文件。

**当前状态**：`buildCodexNewRollout`（`server/src/adapters/codex-rollout.ts`）已把 `cliVersion`/`modelProvider` 改为必填，真值由 `server/src/adapters/codex-version.ts` 的 `resolveCodexNewSessionMeta()` 探测/采样提供，解析失败则绝不落盘；`session_index.jsonl` 名字登记与 idle 状态登记保留。2026-10-21 的[隔离原生验收](acceptance/codex-reliability-2026-10-21/native-policy.json)已用此构造器创建临时 rollout 并完成跨进程 `thread/resume`；未启动模型。新建后首条消息及 `codex exec resume` 仍待实测。

### thread/start 持久化与跨进程 resume

app-server `thread/start` 新建的 thread **必须先完成一轮 turn 使其持久化**，否则另一个进程 `thread/resume` 报：

```text
no rollout found for thread id <uuid>
```

验收中「先完成一轮使其持久化，再由生产驱动接管」即绕过此坑。代码尚未处理该场景：凡是「建 thread 的进程 ≠ 接管的进程」且中间没跑完一轮的路径（例如 hub 重启后恢复接管、detach 后进程被回收再 attach）都可能撞上它。

## 与 claude 驱动的差异

对照 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)。「协议更强」不等于「已实现」，第三列是当前实现状态。

**codex 更强**

| # | 协议层结论 | 当前实现状态 |
|---|---|---|
| 1 | `turn/steer` 是协议级 + `expectedTurnId` 前置校验；claude 是 stdin 注入靠工具间隙时序 | ✅ 已接（原生 steer；followUp 仍本地排队，前轮完成后才发） |
| 2 | 审批是协议内置 ServerRequest；claude 要靠隐藏 flag `--permission-prompt-tool` + 自带 MCP bridge | ⚠️ 半接：三类卡片（command / fileChange / permissions）已写，真实原生命令、fileChange 与 permissions 审批闭环均待补齐证据；当前通过受控模拟测试 |
| 3 | `turn/interrupt` 有明确的 `status:"interrupted"`；claude 是 `result.subtype:"error_during_execution"` | ✅ 已接（abort 走 `turn/interrupt`，进程存活） |
| 4 | 有协议级写者互斥（`already has an active writer`）；claude 只有 mtime 静默窗 | ✅ 真机已观测：0.162 下第二个进程 resume 同一 thread 返回 `-32600 thread ... already has an active writer`。判定以错误码 `code === -32600`（`isWriterConflict()`）为准，文案正则仅作旧版兜底。能力探测仍只凭版本号推断 writerLock，未真观测锁本身 |
| 5 | 自带 PTY 通道（`command/exec` + `/write` + `/resize` + `/terminate` + `commandExec/outputDelta`）→ 不需要 tmux 投屏 | ❌ 当前未做投屏：attach 一律返回 `mirror:false`（`startDriver()` / `statusFor()`，路由透传）；协议潜力 ≠ 已实现能力（与 claude 默认 `mirror: tmux` 不同） |
| 6 | 真图片输入（`localImage` / `image`），两源平行模式现在都是 `@path` 文本降级 | ✅ 接管通道已用 `localImage` 发已校验的上传图片 |
| 7 | 协议还提供 `thread/name/set`、`thread/compact/start`、`permissionProfile/list`（手机选权限档位） | ❌ 一个都没接（全仓非测试代码 0 命中），详见「未做的增强项」 |

**codex 更弱 / 风险**

1. `app-server` 标 `[experimental]`，协议随版本变（互斥有无、paginated 支持与否、模型表新旧、session_meta 字段容忍度均随版本不同）。
2. `thread/list` 不可靠，列表必须自研扫描。
3. daemon / 共享形态需要 standalone 安装，npm 安装拿不到「与桌面 app 共享同一 thread」。
4. 冷启成本高（内置 MCP 最长 23s），必须长驻 + 预热。
5. `requestUserInput` / elicitation 走手机问答卡片；未作答绝不代答（超时明确告知模型）。
6. Codex 平行与接管、Claude 两条通道默认均全自动；Codex 用 `never` + `danger-full-access`，Claude 用 `bypassPermissions`。可显式收紧或 inherit，本机全局设置不被改写；权限字段错误拒绝启动，操作审批与模型问答分别处理。
7. hub 自己写 rollout 有 meta 兼容坑（见「session_meta 最小字段集」）；claude 侧同类坑已以 `isMeta` 占位行实测规避。
8. 接管通道不注入 provider env、平行通道注入（见「通道差异」）→ 同一会话两通道行为不一致。

## 已知限制

- **provider env 两通道不一致**：接管不注入 provider env（`prepareEnv` 未接线），平行注入白名单 env（不含 `CODEX_*`）。自建网关写在 `~/.zshrc` 的用户平行能发、接管会失败。计划以显式配置项接入（默认关）。
- **新建会话 meta 依赖最小字段集**（`cli_version`、`model_provider`）：修复已落地（解析失败绝不落盘），隔离线程的原生 resume 已通过；首条模型消息与平行通道仍待实测。
- **thread/start 未持久化不能跨进程 resume**：hub 重启恢复接管、detach 后回收再 attach 可能撞上 `no rollout found for thread id`。
- **审批空转**：用户 config.toml 配 never + danger-full-access 时接管后零审批；手机批权限需显式配 `untrusted`；`on-request` 不足以稳定触发。effectivePolicy 的审批与沙箱分开呈现；仅 never 判定为不请求操作审批。
- **requestUserInput / elicitation 走手机问答卡片**：逐题选项/自由文本应答；未作答（超时/取消/收尾）明确告知模型未回答、绝不代答；问题文本脱敏后才下发。
- **冷启成本高**：内置 MCP 最长 23s，需长驻 + 预热。
- **可重试错误不当终态已实现**（`willRetry:true` 不下发假报错），待真机弱网/重连场景回归。
- **空气泡过滤已实现**：验收口径为「不得渲染出空气泡（live 与快照同口径）」——web 层 `isEmptyAssistant` 过滤 + 快照层（`codex-rollout`）过滤；driver 侧 `endItem` 仍可能发 `text:""` 的 message_end，但不会到达 UI。
- **真机验证范围**：command 审批的受控模拟闭环已验证；真实命令、fileChange / permissions 审批分别待验；PTY 投屏未做（`mirror:false`）；桌面持有线程 / daemon / `queue --remote` 未验证。
- **版本差异行为**：`thread/list` 不可靠、paginated -32601、writer 互斥新旧不一、meta 字段容忍度不同——见「版本兼容」。
- **幂等边界**：10 分钟内同 clientMessageId 返回原 commandId；进程内幂等，跨 hub 重启不保证。
- **平台**：真实观察仅 macOS；Windows / Linux 未真机验证（模拟协议断言不等于其他系统真机验证）。

## 未做的增强项

以下协议能力当前 0 处实现（仅文档与实验台提及），不要当作已有能力写进对外文案：

| 项 | 现状（证据） | 影响 |
|---|---|---|
| `thread/name/set` 重命名 | codex 源报错：`SessionRegistry.renameSession` 在 adapter 无 `renameSession` 时抛 `INVALID_REQUEST`「来源 codex 暂不支持重命名会话」（`server/src/adapters/registry.ts`），路由层无实现时兜底 501 | 手机建的 codex 会话改不了名 |
| `thread/compact/start` 手动 compact | 仅 pi：`registry.compact` 在 adapter 无 `compact` 时 400，codex / claude 均无 | 长 codex 会话在手机上无法压缩 |
| 实时 token / 额度 | `thread/tokenUsage/updated`、`account/rateLimits/updated`、`account/updated` 未接入；`/api/usage` 仍是离线解析 rollout（`UsageService` 读文件、按 mtime+size 增量对账） | 用量/额度有延迟，无额度告警 |
| `permissionProfile/list` 手机选权限档位 | 未接：协议「请求」表列为可选能力，但生产代码无调用点 | 手机上不能按会话切权限档位 |

同属未做：PTY 投屏（`mirror:false`）、工具输出流式 `item/commandExecution/outputDelta`、diff 视图 `item/fileChange/*`、计划卡片 `planDelta`、`thread/fork` / `thread/archive` / `thread/rollback` / `skills/list`。

## 仍需真实验证

| 项目 | 验收要求 |
|---|---|
| 新建会话的第一条消息 | meta 修复后，真机分别跑通接管（`thread/resume`）与平行（`codex exec resume`）两条路；并验证「建 thread 的进程 ≠ 接管的进程」且未完成过一轮的场景 |
| 旧 / 新 × exec / app-server | 同配置、同模型、同认证与 provider 来源；真实 turn 终态与返回内容断言 |
| fileChange / permissions 审批 | 参数、用户决策、实际副作用、取消和后续 turn；不能从 command 审批类推（当前真机 0 次，仅 fake-spawn 单测） |
| 写者互斥的错误码判定 | `-32600 already has an active writer` 已真机观测，判定已改为先判错误码、文案正则降为兜底；仍需回归：旧版本（无错误码或码不同）走文案兜底时的 409 归类 |
| 可重试错误不当终态 | `willRetry:true` 不得下发 `PROMPT_FAILED`（已实现）；真机复测弱网/重连场景，确认手机无假报错且真实失败原因不被吞 |
| 空气泡回归 | 验收口径「不得渲染出空气泡（live 与快照同口径）」（已实现）；回归确认 text="" 且无 toolCalls 的 message_end 不到达前端 |
| requestUserInput / elicitation | 手机问答卡片渲染、用户答案正确映射（双层 answers 形状）、未作答超时 respondError 不代答、问题文本脱敏 |
| 桌面持有线程 / daemon / queue --remote | 单独获得授权后受控验证；自持进程实验不覆盖该范围 |
| detach 与 writer 释放 | 验证 unsubscribe 宽限期、关闭进程、崩溃后的锁释放和重复 attach |
| Windows / Linux | 当前真实观察仅 macOS |

## 配置与排障

在 `config/hub.config.json` 中配置，样例见 `config/hub.config.example.json`：

```json
{
  "codexBin": "codex",
  "codexDriver": {
    "enabled": true,
    "defaultPolicy": "never",
    "maxConcurrent": 3,
    "idleDetachMs": 1800000,
    "externalQuietMs": 3000,
    "approvalPolicy": "never",
    "sandbox": "danger-full-access"
  }
}
```

`codexBin` 可为 PATH 命令或含空格的绝对路径；`~` 展开，含路径分隔符的相对值按配置目录解析。不执行 shell、不自动升级或改模型。真机验证时可明确指定 macOS 桌面应用内的 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`（0.162.0-alpha.17.2）；这不是跨机器的默认路径。CLI 与接管共用同一设置。`CODEX_HOME` 未设置时会话根为 `~/.codex`。

`defaultPolicy` 不控制工具权限；Codex 产品默认仍为平行继续，手动选择后才接管。工具默认 `approvalPolicy: "never"` + `sandbox: "danger-full-access"`，可改 `untrusted` / `on-request` 与 `read-only` / `workspace-write`，或显式 `inherit`。手机上的单次允许不会升级为永久允许。

`agent-hub doctor` 与 server 启动执行只读版本诊断：解析实际二进制、调用 `--version`，在正常/归档目录有限采样 rollout 头的 cli_version。默认最多 32 个文件、每个 64 KiB、2.5 秒总预算，版本查询 1.5 秒；历史 I/O 一旦超时即停止余下采样并标记受限，超时后才取得的句柄仍会释放。失败只告警，不读 auth.json、不调用模型、不阻塞服务启动。版本 compatible 只表示数字版本比较没有发现落后，不等于模型、认证或 provider 已验证可用。

## 复现与验收

```bash
# 在仓库根运行；只启动模拟 Node 子进程，不调用 Codex 模型
node --test docs/examples/codex-app-server-lab/*.test.mjs

cd docs/examples/codex-app-server-lab
node probe2.mjs                           # 只读：版本、账号模式、模型、线程列表
CODEX_LAB_BIN=/path/to/codex node probe5.mjs
node probe6.mjs --experimental            # 显式实验能力列表

# 以下需要用户主动 --run，会调用真实模型；完整矩阵尚未复跑
CODEX_LAB_BIN=/path/to/codex node exp.mjs x2b --run
node exp.mjs x3 --run
node exp.mjs x4accept --run                # 隔离样本的明确允许决策
node exp.mjs x4decline --run
node exp.mjs x5 --run
node exp.mjs x6 --run                     # 仅两个自持进程
node exp.mjs x7 --run                     # 不代答用户问题
node exp.mjs x2a --run --thread <explicit-id> # 可能占 writer / 改元数据
```

每次运行创建独立临时 cwd 和 result.json；所有实验必须断言相应 turn、工具事件、审批副作用和后续 turn。失败以非零状态退出，finally 关闭所有子进程。默认仅继承 process.env；`CODEX_LAB_LOAD_SHELL_ENV=1` 才会执行登录 shell。完整参数与安全边界见[实验台说明](examples/codex-app-server-lab/README.md)。验收产物见 [docs/acceptance/](acceptance/)。
