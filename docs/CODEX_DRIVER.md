# Codex 会话接管可行性（app-server 驱动）——实验结论与二期契约草案

> 2026-10-16 真机实测记录 + 二期实现契约草案。实验编号 X1–X9，全部在本机跑通或明确定位阻塞，
> 复现脚本见 [docs/examples/codex-app-server-lab/](examples/codex-app-server-lab/)。
>
> **实测环境**：macOS 26.5.2 / arm64；PATH `codex-cli 0.143.0`；`ChatGPT.app` 内嵌
> `codex-cli 0.162.0-alpha.17.2`；`~/.codex/auth.json` `auth_mode=chatgpt`（`account/updated` 回显
> `planType: "pro"`）；`~/.codex/config.toml` `model="gpt-6.1-sol"` / `approval_policy="never"` /
> `sandbox_mode="danger-full-access"`；`~/.codex/sessions` 129 个 thread（legacy 7 / paginated 122）。
>
> claude 侧的同构文档见 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)（E1–E4 实验 + 已上线驱动契约）。

## 零、结论先行

1. **codex 能做到接管，且协议条件优于 claude**：`turn/steer`（原生运行中插话）、`turn/interrupt`、
   审批 ServerRequest（**不需要 MCP bridge、不需要隐藏 flag**）、`already has an active writer`
   写者互斥锁（claude 侧只有 mtime 静默窗这种线索级防护）。
2. **但你当前的 codex 环境本身是坏的（P0，与接管无关）**：PATH 上的 0.143.0 不认识
   `gpt-6.1-sol`，ChatGPT 账号下所有模型请求返回 400。**现有平行模式（`codex exec resume --json`）
   同样失败** → 现在从手机给任何 codex 会话发消息，都会拿到
   `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.`。
3. **根因是版本错配**：会话由桌面 app 内嵌的 `0.162.0-alpha.17.2` 写出，agent-hub 走 PATH 的
   `0.143.0`。换成 0.162 二进制后，X2b/X3/X4/X5/X6 全部通过（见下）。
4. **二期建议形态**：hub spawn `<codexBin> app-server`（stdio）做**独占接管**，列表/历史继续用自研
   rollout 扫描；`codexBin` 必须可配置。**不要走 `codex remote-control`**（那是 OpenAI 自己的远程通道，
   与 agent-hub「数据不出机器」的定位冲突）。

## 一、实验结论（X1–X9，均已真机实测）

| 编号 | 结论 | 证据 |
|---|---|---|
| **X1** | ✅ `codex app-server`（stdio JSON-RPC 2.0）可直接 spawn 使用，无需 experimental flag | `initialize{clientInfo{name,title,version}}` → `{userAgent,codexHome,platformFamily,platformOs}`，~0.6–1s |
| **X1b** | ⚠️ `thread/list` **不是**全量会话事实源，且强依赖 CLI 版本 | 同一台机、同一批 rollout：0.143 只返回 **2** 条，0.162 返回 **129** 条（`legacy 7 / paginated 122`）。→ 必须保留自研 `codex-rollout.ts` 扫描（列表/搜索/归档/离线） |
| **X2a** | ⚠️ `thread/resume`：legacy 会话成功；paginated 会话在 0.143 直接 `-32601 paginated_threads is not supported yet` | 0.143 resume `legacy` → `status:{type:"idle"}` + 回显 model/approvalPolicy/sandbox；resume `paginated`(cli 0.144.0-alpha.4) → -32601 |
| **X2b** | ✅ 0.162 下 `thread/start` + `turn/start` 完整跑通 | `turn/completed status=completed`、`AGENT-TEXT:["PONG-162"]`；rollout 正常落盘（`response_item`/`world_state`/`turn_context`/`event_msg`，尾行 `task_complete`） |
| **X3** | ✅ **`turn/steer` = 原生运行中插话**：注入当前活跃 turn（**不新建 turn**），当前工具收尾后立刻转向 | 第一条 `sleep 8 && echo ONE` 执行中 steer → 返回 `{turnId: <同一 turn>}`；命令 `status=completed` 后 `agentMessage="HELLO-STEER-3"`，TWO/THREE **未执行**。`expectedTurnId` 是前置校验（不匹配即失败，防错轮） |
| **X4** | ✅ **手机批权限闭环成立，且不需要任何 bridge**：`accept` 真执行、`decline` 不执行且**不卡死** | `approvalPolicy:"untrusted"` 下收到 ServerRequest `item/commandExecution/requestApproval`（params 含 `kind:"command"`/`threadId`/`turnId`/`itemId`/`environmentId:"local"`/`command`）。应答 `{decision:"accept"}` → 文件真写出 `APPROVED-BY-PHONE`、turn `completed`；`{decision:"decline"}` → 文件未创建、模型回 `BLOCKED`、turn 仍 `completed`、进程存活可接下一条 |
| **X4b** | ⚠️ `on-request` 不足以触发审批：模型会自行放弃 | `sandbox:"read-only"` + `approvalPolicy:"on-request"` 下写文件 → **SERVER-REQUESTS (none)**，模型直接回 `BLOCKED`。要稳定产生审批需 `untrusted`（或 `granular{sandbox_approval,request_permissions,...}`） |
| **X5** | ✅ `turn/interrupt` = 干净中止，进程存活 | `sleep 30` 执行中 interrupt → 返回 `{}`，**27ms** 内 `turn/completed status=interrupted`（`error=null`，不是 failed）；紧接 `turn/start` 立即 `inProgress`；进程未退出 |
| **X6** | ✅ **0.162 有协议级写者互斥**；❌ **0.143 没有**（危险） | 0.162：A 持 turn 时 B `thread/resume` → `-32600 thread ... already has an active writer`，B `turn/start` → `-32600 thread not found`，A 不受影响。0.143：B resume **成功**（`status:idle`）、收不到 A 的任何 turn/item 通知、还能对同一 thread `turn/start` **成功** → 两个 writer 并存，协议层不拦 |
| **X7** | ⚠️ `item/tool/requestUserInput` 通道存在但**默认不可用**，模型降级为文字提问（与 claude E1 同结论） | 模型原话：`Do you prefer TypeScript or JavaScript? The request_user_input tool is unavailable in Default mode.` → SERVER-REQUESTS (none)。接管时按「文字问、文字答」实现即可，无需问题卡片 |
| **X8** | ❌ 共享 daemon 形态当前不可用（部署前置条件） | `codex app-server daemon start` → `managed standalone Codex install not found at ~/.codex/packages/standalone/current/codex`，要求 `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`。npm/nvm 安装不满足 → 无法与桌面 app 共享同一 daemon（也就拿不到「真 rejoin 桌面 app 正在跑的 thread」） |
| **X9** | ✅ 自研解析器**向后兼容** 0.162 写出的新 rollout；两处小缺口 | 用 `server/dist/adapters/codex-rollout.js` 解析 0.162 产物：user/assistant 消息、steer 注入的 user 消息、`exec` 工具调用均正确。缺口：① 部分 item 工具名落成 `unknown`；② 出现 `text=""` 的空 assistant 气泡（reasoning/plan 类 item） |
| **X10** | ✅ 意外收获：实时用量与额度事件 | `thread/tokenUsage/updated{tokenUsage.total{totalTokens,inputTokens,cachedInputTokens}}`、`account/rateLimits/updated{rateLimits.primary{usedPercent,windowDurationMins,resetsAt}}`、`account/updated{authMode,planType}` → 现有离线 `/api/usage` 可升级为实时，并做额度告警 |
| **X11** | ⚠️ `codex exec` 通道额外约束（现存平行模式的坑） | 非 git repo 且非 trusted 目录直接拒绝：`Not inside a trusted directory and --skip-git-repo-check was not specified.`（trust 来自 `config.toml` `[projects."<path>"] trust_level="trusted"`）。`app-server` 的 `thread/start` **无此约束**（在未 trust 的 `/tmp/codex-lab/ws` 正常起） |

### 启动成本（决定必须长驻复用，不能每条消息起一个进程）

| 阶段 | 实测 |
|---|---|
| spawn → `initialize` 可用 | 0.6–1.0s |
| `thread/start` 返回 | 1.5–4.7s（含 models cache 加载） |
| 内置 MCP ready（`node_repl` / `cua_repl` / `codex_apps`） | 5s / 5s / **最长 23s** |
| 首条 `turn/start` → 首个 delta | 约 14s（本例含 MCP 冷启；热进程会快很多） |

## 二、P0 环境阻塞（先修这个，否则 codex 源等于半瘫）

**现象**：手机给任何 codex 会话发消息 → `error` 事件 +
`The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.`
（0.143 与 0.162 二进制都报，但 0.162 的 `model/list` 里 `gpt-6.1-sol` 在列，说明 0.143 的模型元数据表太旧）

**旁证**：`codex exec` 还打出 `ERROR codex_models_manager::cache: failed to load models cache: missing field 'base_instructions' at line 139`
→ 0.143 在读 0.162 写的 models cache，字段不兼容。

**三个可选修法（按代价排序）**：
1. 让 hub 的 `codexBin` 指向桌面 app 内嵌二进制（实测有效，X2b/X3/X4/X5/X6 全部通过）：
   `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
   —— 但它是 app 私有路径，随 app 升级变动，需要探测 + 可配置。
2. `codex update`（或重装 npm 包）把 PATH 版本升到 0.162+，与桌面 app 对齐。
3. 官方 standalone 安装（`~/.codex/packages/standalone/current/codex`）—— 顺带解锁 X8 的 daemon 形态。

> agent-hub 侧应做的事：把 `codexBin` 提为配置项（现在硬编码 `options.codexBin ?? "codex"`），
> 并在 `doctor`/启动自检里比对「hub 用的 codex 版本」与「会话文件里的 `cliVersion`」，错配时给显式告警。

## 三、驱动契约草案（二期实现依据）

### spawn（固定安全集）

```
<codexBin> app-server                      # 默认 --listen stdio://
  env: mergeProviderEnvSync(process.env)   # 复用 claude-env.ts：shell rc 的 OPENAI_*/CODEX_* 注入
```

- 禁止：`--dangerously-bypass-approvals-and-sandbox`、任何放宽权限的 `-c` 覆盖；
  `--listen ws://IP:PORT` **绝不对手机直连**（必须由 hub 代理，hub 是唯一持有 app-server 的进程）。
- `codexBin` 可配置（默认 PATH `codex`），并做版本探测（见下「能力探测」）。

### 请求（client → server）

| 用途 | 方法 | 关键参数（实测形状） |
|---|---|---|
| 握手 | `initialize` | `{clientInfo:{name,title,version}}` |
| 接管会话 | `thread/resume` | `{threadId, model?, cwd?, approvalPolicy?, sandbox?, approvalsReviewer?, config?}`；paginated 会话应带 `excludeTurns:true`（见下「历史分页」） |
| 新建会话 | `thread/start` | `{cwd, sandbox:"read-only"\|"workspace-write"\|"danger-full-access", approvalPolicy, model?}` |
| 发消息 | `turn/start` | `{threadId, input:UserInput[], effort?, model?, approvalPolicy?, sandboxPolicy?, outputSchema?}` → `{turn}` |
| **运行中插话** | `turn/steer` | `{threadId, expectedTurnId, input:UserInput[]}` → `{turnId}`（同一 turn） |
| 中止 | `turn/interrupt` | `{threadId, turnId}` → `{}` |
| 退订 | `thread/unsubscribe` | `{threadId}` |
| 历史分页 | `thread/turns/list` | 存在（未 resume 时报 `-32600 thread not loaded`）；`thread/items/list` 在 0.162 仍是 `-32601 not supported yet` |
| 能力探测 | `experimentalFeature/list`、`permissionProfile/list`、`model/list`、`getAuthStatus`、`account/rateLimits/read` | `permissionProfile/list` → `:read-only` / `:workspace` / `:danger-full-access`（可做「手机选权限档位」） |
| 顺带可补齐现有缺口 | `thread/name/set`（重命名，现在 codex 返 400）、`thread/compact/start`（compact 现在仅 pi）、`thread/fork`、`thread/archive`/`unarchive`/`delete`、`thread/rollback`、`skills/list` | — |

`UserInput` 形状（`text_elements` **必填**，缺了会报参数错）：

```json
{"type":"text","text":"...","text_elements":[]}
{"type":"localImage","path":"/abs/path.png","detail":"..."}   // 真传图，替代现在的 @path 文本降级
{"type":"image","url":"https://..."}
{"type":"skill","name":"...","path":"..."}   {"type":"mention","name":"...","path":"..."}
```

### 应答（server → client 的 ServerRequest，**必须回**，否则 turn 挂住）

| 方法 | 应答 |
|---|---|
| `item/commandExecution/requestApproval` | `{decision:"accept"\|"acceptForSession"\|"decline"\|"cancel"}`（另有 `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment`） |
| `item/fileChange/requestApproval` | `{decision:"accept"\|"acceptForSession"\|"decline"\|"cancel"}` |
| `item/permissions/requestApproval` | `{permissions:<GrantedPermissionProfile>, scope:<PermissionGrantScope>, strictAutoReview?}`（**形状未实测**，X4 只覆盖 command 类） |
| `item/tool/requestUserInput` | `{answers:[...]}`（**默认模式下不会触发**，见 X7） |
| `mcpServer/elicitation/request` / `item/tool/call` / `account/chatgptAuthTokens/refresh` / `attestation/generate` | 未实测；hub 至少要能**识别并安全拒绝/透传**，不能静默吞掉 |
| 旧版兼容 | `execCommandApproval` / `applyPatchApproval`（0.143 命名空间仍在协议里） |

### 事件（notification）→ 现有契约 WS 事件映射

| app-server 通知 | 映射到（`docs/API_CONTRACT.md` §4） |
|---|---|
| `thread/started`、`thread/status/changed{active}`、`turn/started` | `status:"running"` |
| `item/agentMessage/delta{itemId,delta}` | `message_start`（懒开）+ `text_delta` |
| `item/started`（工具类）/ `item/completed`（工具类） | `tool_start` / `tool_end` |
| `item/completed{item.type:"agentMessage"}` | `message_end` |
| `turn/completed{turn.status}` | `completed`→`status:"idle"`；`interrupted`→`idle`；`failed`→`error`；统一补 `agent_settled` |
| `error{error.message,willRetry}` | `error` 事件（每轮至多一条） |
| `serverRequest/resolved{threadId,requestId}` | `host_request_resolved`（电脑端已批准 → 手机卡片自动消失，天然对齐） |
| `thread/tokenUsage/updated`、`account/rateLimits/updated`、`account/updated` | 新增：实时用量/额度（现 `/api/usage` 为离线解析） |
| `mcpServer/startupStatus/updated`、`skills/changed`、`deprecationNotice`、`warning` | 日志/诊断，不进 chat 流 |
| `item/commandExecution/outputDelta`、`item/fileChange/*`、`planDelta`、`reasoning*`、`turnDiffUpdated` | 可选增强（工具输出流式、diff 视图、计划卡片） |

### 能力/版本探测（必须做，协议是 experimental）

启动时依次：`initialize` → `getAuthStatus` → `model/list` → `experimentalFeature/list` →
（可选）`app-server daemon version`。据结果决定：可用模型清单（避免 X2 那种 400）、
是否支持 paginated resume、是否挂 bridge 之外的审批形状。**任何一步失败都要能回落到现有
`codex exec resume --json` 平行模式**，并把原因下发给前端灰显文案（对齐 claude 的
`attachDisabledReason`）。

### 历史分页（paginated 会话）

0.162 对全量 hydration 发 `deprecationNotice`：
> Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.

但 `thread/items/list` 尚未实现（`-32601`）。→ 二期策略：**历史继续走自研 rollout 解析**
（X9 已验证兼容），app-server 只用于驱动；`thread/resume` 带 `excludeTurns:true` 降低接管延迟。

## 四、与 claude 驱动的差异

**codex 更强**
1. `turn/steer` 是协议级 + `expectedTurnId` 前置校验；claude 是 stdin 注入靠工具间隙时序（E3b）。
2. 审批是协议内置 ServerRequest；claude 要靠隐藏 flag `--permission-prompt-tool` + 自带 MCP bridge。
3. `turn/interrupt` 有明确的 `status:"interrupted"`；claude 是 `result.subtype:"error_during_execution"`。
4. **有写者互斥**（`already has an active writer`）；claude 只有 mtime 静默窗（明确写着「不是进程锁」）。
5. 自带 PTY 通道（`command/exec` + `/write` + `/resize` + `/terminate` + `commandExec/outputDelta`）→
   不需要 tmux 投屏那一套（`claude-mirror.ts` / `cli/mirror.js` 可省）。
6. 真图片输入（`localImage`/`image`），claude/codex 现在都是 `@path` 文本降级。
7. 白捡 `thread/name/set`、`thread/compact/start`、`permissionProfile/list`（手机选权限档位）。

**codex 更弱 / 风险**
1. `app-server` 标 `[experimental]`，协议随版本变（本机就同时存在 0.143 与 0.162 两套行为：
   互斥有无、paginated 支持与否、模型表新旧）。
2. `thread/list` 不可靠（X1b：2 vs 129），列表必须自研扫描。
3. daemon/共享形态需要 standalone 安装（X8），npm 安装拿不到「与桌面 app 共享同一 thread」。
4. 冷启成本高（内置 MCP 最长 23s），必须长驻 + 预热。
5. `requestUserInput` 默认不可用（X7）。

## 五、已知限制

1. **跨进程互斥只在同版本 app-server 内成立**：0.143 完全不拦（X6）。hub 与桌面 app 各自 spawn
   自己的 app-server 时，若两边版本不一致，仍可能双写 → 除协议锁外，**保留 claude 那套 busy 判定 +
   mtime 静默窗 + 409 `ATTACH_ACTIVE`** 作为第二道防线。
2. hub 接管期间，桌面 app 对同一会话的操作会被 `active writer` 拒绝（这是正确的接管语义，
   但要在前端说清楚，否则用户以为 app 坏了）。
3. 你当前 `approval_policy="never"` + `sandbox_mode="danger-full-access"` → **不会产生任何审批请求**
   （X4b 同源现象）。要让「手机批权限」有意义，接管时需覆盖为 `untrusted` 或 `granular` 并收紧
   sandbox。这是**收紧**（不违反「不传更宽松 flag」的安全口径），但改变了用户既定策略 →
   必须做成配置项（`codexDriver.approvalPolicy` / `sandbox`），默认沿用用户配置、不偷偷改。
4. `codex exec` 通道要求 cwd 是 git repo 或 trusted project（X11）；`app-server` 不要求。
   两条通道行为不一致，前端错误提示要分开。
5. server 重启不恢复接管（与 claude 同）；关闭 PWA ≠ abort。

## 六、实现落点与分期

| 阶段 | 内容 | 落点 |
|---|---|---|
| **P0（先修，与接管无关）** | `codexBin` 提为配置项 + 版本错配自检告警；`codex exec` 失败原因透传到手机（现在只有笼统 error）；补 X9 两处解析缺口（`unknown` 工具名、空 assistant 气泡） | `server/src/adapters/codex.ts`、`server/src/config.ts`、`codex-rollout.ts`、`cli/check.js` |
| **P1（接管 MVP）** | spawn `app-server`（stdio）长驻 + JSON-RPC 客户端（请求 id 表 / 超时 / 断线重连）；`thread/resume(excludeTurns)` + `turn/start` + `turn/interrupt`；事件映射到既有契约 WS 事件；attach/detach/message/host-requests 路由摘掉 codex 的 400；前端摘掉 codex 灰显 | 新增 `server/src/adapters/codex-driver.ts`、`codex-host-protocol.ts`；改 `routes.ts`、`registry.ts`、`web/src/api/attach.ts` |
| **P1.5（审批上手机）** | `item/commandExecution|fileChange|permissions/requestApproval` → 现有 `host_request` 通道 + `HostRequestCard` 扩四类卡片（命令 / 改文件 / 权限档 / 提问）；`serverRequest/resolved` → `host_request_resolved` | `web/src/components/HostRequestCard.tsx`、`web/src/pages/ChatPage.tsx` |
| **P2（增强）** | `turn/steer` 真插话（替换现在的排队降级）；`localImage` 真传图；`thread/name/set` 补重命名、`thread/compact/start` 补压缩；实时 token/额度；PTY 投屏替代 tmux；`permissionProfile/list` 手机选权限档 | 同上 + `web/src/chat/messageStream.ts` |
| **不做** | `codex remote-control`（OpenAI 自己的远程通道，与「数据不出机器」冲突）；`--listen ws://` 直连手机 | — |

## 七、待补测（本次被环境或优先级挡住）

| 项 | 缺什么 |
|---|---|
| `item/fileChange/requestApproval`、`item/permissions/requestApproval` 的真实 params 与应答 | X4 只触发了 command 类；需要构造改文件越权 / 需要权限档提升的场景 |
| `requestUserInput` 的开启方式 | X7 显示「Default mode 不可用」；需查 `experimentalFeature/list` 里对应 flag（本次未逐条比对）或 personality 配置 |
| X8 daemon 共享 rejoin | 需要 standalone 安装（`~/.codex/packages/standalone/current/codex`），会改变你的 codex 安装方式，未擅自执行 |
| 接管正在被**桌面 app** 持有的 thread | 需要桌面 app 里有一个活跃会话；本次只用两个自持进程验证了互斥语义 |
| 断线重连 / app-server 崩溃后的状态收敛 | 未注入故障 |
| Windows / Linux 上的 app-server 行为 | 本次仅 macOS arm64 |

## 八、复现

```bash
cd docs/examples/codex-app-server-lab
node probe2.mjs                                  # 版本/auth/模型/resume 兼容面
CODEX_LAB_BIN=/path/to/codex node exp.mjs x2b    # 真 turn（会调用模型，花钱）
CODEX_LAB_BIN=/path/to/codex node exp.mjs x3     # steer
CODEX_LAB_BIN=/path/to/codex node exp.mjs x4accept   # 审批 accept（x4decline 同理）
CODEX_LAB_BIN=/path/to/codex node exp.mjs x5     # interrupt
CODEX_LAB_BIN=/path/to/codex node exp.mjs x6     # 双进程互斥
CODEX_LAB_POLICY=untrusted ...                   # 覆盖审批策略
CODEX_LAB_MODEL=gpt-5.5 ...                      # 覆盖模型（默认用 config.toml 的）
```

安全说明：`env.mjs` 复刻 `server/src/adapters/claude-env.ts` 的做法，从登录 shell 取
`OPENAI_*`/`CODEX_*`/`ANTHROPIC_*`/`CLAUDE_CODE_*` 注入子进程，**只传值不打印值**（日志里只输出键名）。
所有实验 cwd 固定在 `/tmp/codex-lab/ws`（沙箱内自建 git repo），不触碰任何项目工作区。
