# Codex app-server 驱动：实验记录与接管契约

2026-10-16 修订。官方依据是 [app-server 文档](https://learn.chatgpt.com/docs/app-server)，协议形状另与本机 `0.162.0-alpha.17.2` 导出的 schema 核对。实验台见 [examples/codex-app-server-lab](examples/codex-app-server-lab/)。Claude 对照见 [CLAUDE_DRIVER.md](CLAUDE_DRIVER.md)。

本页区分三种证据：原始真机运行的人工观察、导出 schema 的协议定义、修订实验台的模拟子进程断言。本轮另在自建临时线程完成真实 app-server → 生产驱动 resume → 模型回复 → detach / writer 释放验证，见 [验收记录](acceptance/codex-mvp-2026-10-16.json)。未读取私人线程正文、凭据文件或登录 shell 配置；模拟审批/中断测试与真实最小回复验证分别记录，不能互相替代。

## 结论与边界

1. app-server 提供 `thread/resume`、`turn/start`、原生 `turn/steer`、`turn/interrupt` 和审批 ServerRequest，可以作为 hub 自持会话的驱动接口。列表、搜索、离线历史仍可使用本地 rollout 解析。
2. 本机 PATH `0.143.0` 与桌面内嵌 `0.162.0-alpha.17.2` 存在兼容差异。历史记录中新版 app-server 完成过模型 turn，但新旧 `exec` 都出现过模型 400；因此**不能声称更换二进制已经修复 exec，也不能仅凭 model/list 证明账号可调用模型**。
3. 两个自持 app-server 的写者互斥只说明该测试范围内的行为。它不证明可以接入桌面正在持有的线程、接收桌面进程的事件或镜像桌面 UI。
4. 发生 active-writer 冲突、已提交请求超时或受理状态未知时，必须停止并报告状态；不得自动转入 exec 重试，以免重复 turn 或双写。

## 历史真机观察（尚未用修订脚本复跑）

原始运行环境为 macOS arm64；以下数字与结果保留作后续复测线索。旧脚本主要打印日志，缺少严格断言，部分依靠固定等待时间、复用样本文件或自动选择历史线程；这些观察不能代替当前验收。

| 编号 | 原始观察 | 证据的适用范围 / 待复核点 |
|---|---|---|
| X1 | 两版本可启动 stdio app-server，initialize 约 0.6–1.0s | 完整握手还必须发送 initialized；部分实验接口需显式声明 experimentalApi |
| X1b | thread/list 在 0.143 返回 2 条、0.162 返回 129 条 | 列表不应被视作跨版本完整事实源；分页与过滤条件需保留 |
| X2a | 旧版可 resume legacy；paginated 返回 -32601 | resume 可能占 writer 或更新元数据，不能作为随机私人线程的只读探针 |
| X2b | 新版 app-server 的 turn/completed 为 completed，并返回 PONG 标记 | 新版 app-server 的历史成功，不代表新版 exec 或所有模型可用 |
| X3 | steer 返回同一 turnId，最终回复转向，未观察到后续命令 | 原脚本先固定等待，未可靠证明 steer 时命令仍在执行；新脚本等待匹配 command item/started 后断言 |
| X4 | command requestApproval 的 accept/decline 应答后 turn 可收尾 | 原共享样本文件未清理，拒绝后无文件的证据需以隔离目录重测；fileChange/permissions 未实测 |
| X4b | on-request + read-only 场景中模型直接回复 BLOCKED，没有审批请求 | 单次未触发不是通道不可用；untrusted 也不保证模型一定请求审批，验收必须断言请求确实出现 |
| X5 | interrupt 后出现 interrupted，后续请求可受理 | 原固定等待不能证明中断发生于命令执行中；后续只收到 inProgress 也不等于后续 turn 成功 |
| X6 | 新版的第二个自持进程 resume 返回 active writer；旧版曾允许第二 writer | 只覆盖两个自持进程；新版锁的生命周期、版本组合与桌面持有场景仍需独立验证 |
| X7 | 原 Default mode 未触发 requestUserInput，模型以文字提问 | 这是当时模式的观察，不是协议永久不可用；不得替用户自动选第一项 |
| X8 | 当时 daemon start 因缺 standalone 安装失败 | 没有安装、共享 daemon 或桌面 rejoin 的成功证据；不能推导安装后一定能连接桌面 |
| X9 | 原解析器能读新版 rollout 的消息、工具与 steer 输入 | 曾见 unknown 工具名与空 assistant 气泡；当前改进应另以受控 fixture 验证 |
| X10 | 观察到 tokenUsage、rateLimits、account 更新通知 | 可作后续增强；账号通知与响应只输出白名单元数据，绝不输出 token 或完整正文 |
| X11 | exec 在非 git / 非 trusted cwd 拒收；app-server 可在实验 cwd 起 thread | 通道前置条件不同；不应为排障自动增加绕过检查或放宽权限参数 |

历史冷启还观察到 thread/start 约 1.5–4.7s、内置 MCP 最长约 23s、首 delta 约 14s。适合在一次接管内复用进程；这些数字不是当前版本的延迟承诺。

## 版本兼容：需要受控验证矩阵

| 二进制 | exec（历史记录） | app-server（历史记录） |
|---|---|---|
| 0.143.0 | gpt-6.1-sol / ChatGPT 认证曾返回 400；曾见 models cache 字段不兼容 | 同模型曾返回 400；paginated 与 writer 互斥有缺口 |
| 0.162.0-alpha.17.2 | 同模型也曾返回 400；未证明更换版本可修复 | 曾完成 X2b 等真实 turn；需用修订断言复测 |

要定位根因，必须对“旧 / 新版本 × exec / app-server”四格固定相同 cwd、模型、认证来源、provider 环境与配置，并记录实际返回。版本错配与缓存报错是风险线索，不能据此宣称单一根因。model/list 只描述元数据，不证明账号权限、路由或实际请求成功。

hub 已支持配置 codexBin，并显示所选二进制版本与线程 cliVersion 的差异。桌面内嵌路径可用于明确指定的比较测试，但属于随应用升级可能变化的私有路径。不要自动升级、安装 standalone 或切换二进制来改变用户环境。

## 驱动协议契约

### 进程与握手

```text
<configured codexBin> app-server
env: inherit process.env
transport: stdio (hub proxies events; do not expose a public app-server socket)
initialize {clientInfo, capabilities?: {experimentalApi: true}}
initialized   # notification, after initialize succeeds
```

默认不执行登录 shell；只有用户明确配置环境导入时才加载，且启动 shell 可能运行 rc 的任意副作用。日志、错误和 artifact 使用字段白名单，不记录输入、模型正文、命令正文、stderr 原文、鉴权响应或 ServerRequest 完整参数。禁止通过附加参数绕过审批和沙箱。

app-server 不是所有接口都依赖 experimentalApi。仅在使用明确标为 experimental 的接口时启用该 capability，并对所需方法和版本进行探测。

### 请求

| 用途 | 方法 | 关键参数 / 行为 |
|---|---|---|
| 接管明确选定的线程 | thread/resume | `{threadId, excludeTurns:true, ...explicitOverrides}`；会占 writer，不能随意自动选择历史线程 |
| 新线程 | thread/start | `{cwd, sandbox, approvalPolicy, model?}`；实验只用隔离临时 cwd |
| 发消息 | turn/start | `{threadId, input:UserInput[], effort?, model?, ...}` → `{turn}` |
| 原生运行中插话 | turn/steer | `{threadId, expectedTurnId, input}` → `{turnId}`，必须等于活跃 turn |
| 中止 | turn/interrupt | `{threadId, turnId}`；以匹配 turn/completed 的 interrupted 确认结果 |
| 退订 | thread/unsubscribe | 仅退订；可能存在宽限期，不能把应答视作 writer 已释放。MVP 可关闭每会话子进程释放自身所有权 |
| 历史 | thread/turns/list、thread/items/list | paginated 使用 excludeTurns 后按能力分页；原 0.162 中 items/list 尚返回 -32601，历史可保留 rollout 解析 |
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
| error{willRetry} | 可重试错误不是终态；willRetry:true 时继续等待，不能提前 idle 或触发 exec 重试 |
| serverRequest/resolved | 清理对应卡片，决策结果保持未知，除非客户端已经记录了明确答复 |
| usage、rate limits、account 更新 | 可选增强，使用元数据白名单 |

JSON-RPC 客户端需处理 UTF-8 跨块与无换行尾行；请求表、等待器、行缓冲与事件历史必须有上限。waitFor 以 cursor 和 thread / turn 过滤竞态，已消费历史不能重复命中下一轮。spawn error、close、写入失败、handler 异常或超时都要拒绝等待并清理 timer；异步 handler 必须 await 后应答。未知 ServerRequest 返回 -32601，不能写出 Promise 或无限等待。

### 能力失败与所有权

版本 / 方法不兼容发生于任何 turn 提交前时，可以向用户说明该模式不可用，由用户选择其他模式。active writer 或提交后超时 / 断连代表所有权、受理状态不确定；**不自动转 exec、不自动重放用户消息**。mtime 静默窗只能作附加线索，不能代替锁。第二个自持进程互斥也不能推导桌面接管成功。

command/exec 的 PTY 是独立命令的执行与输入输出通道，不能直接等同于完整 chat 会话投屏或取代现有镜像实现。新版 `codex queue --remote` 可列入独立待测项；当前没有证据证明它能连接用户桌面正在运行的会话。

## 已实现的接管 MVP（2026-10-16）

生产驱动见 `server/src/adapters/codex-driver.ts`、`codex-rpc.ts`、`codex-host-protocol.ts`；不是仅有实验脚本。

- 每个接管会话独立 app-server，版本最低 `0.162`（含对应 alpha）；完整握手与 idle resume 成功后才返回 attached。并发默认 3，准备期也占名额；同会话共享一次启动。旧版本不具备本驱动要求的互斥契约时明确拒绝，不转 exec。
- 原生 `turn/start`、带 expectedTurnId 的 `turn/steer`；followUp 在本地排队，前轮完成后才发送。`prompt` 正忙通过失败回执告知。10 分钟内同 clientMessageId 返回原 commandId；这是进程内幂等，跨 hub 重启不保证。
- abort 使用 `turn/interrupt`，保留进程；清理待办与当前审批。detach / crash / timeout 取消挂起请求并关闭进程释放自身 writer；释放尚未完成时拒绝重新 attach。
- 命令、文件与 permissions 三类原生审批显示手机卡片，刷新后可重新拉取。只允许当前操作；permissions 仅回授原请求的权限子集且 scope 固定 turn。超时、退出、中止全部拒绝；已清理不冒充“用户允许”。
- 审批按 turn 与原生 requestId 共同关联，原生 ID 跨轮复用不会漏卡或批准到另一轮；文件审批展示同轮同 item 的有界 diff，缺少 diff 时明确告知。
- requestUserInput 与 elicitation 尚无交互 UI，明确拒绝/unsupported，模型可改用文字提问。未知服务请求返回协议错误；不把认证刷新或凭据交给手机。
- 已校验的上传图片以 localImage 发送，图片预览保留在回执与重连快照；进行中回复用当前轮快照与 rollout 对账。历史列表/搜索仍扫描本地文件，不依赖 thread/list 的过滤结果。
- 并行通道与接管准备/执行互斥。CLI 返回内容按 UTF-8 增量解码并处理无换行尾帧；准备期取消和外部忙状态均有回归测试。
- 手机接管失败、写者冲突或受理状态不明时保留消息供手动重试，绝不自动改走 exec。Codex 不投屏原桌面窗口；原线程被桌面持有时需先退出原会话再接管。
- 重进时恢复手动接管选择，即使驱动尚未启动也重新握手；握手失败或驱动断开后仍保留接管通道，允许重新点选接管重试。选择平行模式须由用户明确切换。

### 配置与排障

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
    "approvalPolicy": "inherit",
    "sandbox": "inherit"
  }
}
```

`codexBin` 可为 PATH 命令或含空格的绝对路径；`~` 展开，含路径分隔符的相对值按配置目录解析。不执行 shell、不自动升级或改模型。例如本次真机验证明确指定了 macOS 桌面应用内的 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`（0.162.0-alpha.17.2）；这不是跨机器的默认路径。CLI 与接管共用同一设置。`CODEX_HOME` 未设置时会话根为 `~/.codex`。

`defaultPolicy` 默认 never，只手动接管；可选 active-only / always，但真实占用仍受 native writer 和静默窗检查。归档会话需先在 Codex 中恢复。默认 approvalPolicy / sandbox 为 inherit，不覆盖 Codex 的策略；可显式设置 on-request / untrusted / never，以及 read-only / workspace-write / danger-full-access。手机不会把一次允许升级为永久允许。

`agent-hub doctor` 与 server 启动执行只读版本诊断：解析实际二进制、调用 `--version`，在正常/归档目录有限采样 rollout 头的 cli_version。默认最多 32 个文件、每个 64 KiB、2.5 秒总预算，版本查询 1.5 秒；失败只告警，不读 auth.json、不调用模型、不阻塞服务启动。版本 compatible 只表示数字版本比较没有发现落后，不等于模型、认证或 provider 已验证可用。

本批模拟测试覆盖协议、审批/取消、重复请求、并发/队列、UTF-8/尾帧、进程故障、HTTP/WS 接线、图片与刷新快照。真机最小回复在 0.162.0-alpha.17.2 上通过，包括完整受理回执、预期回复和 writer 释放；新建空 thread 尚未持久化时不能直接 resume，验证先完成一轮自有线程再续接。真实四格矩阵、审批副作用和桌面持有线程仍按下一节单独记录，不用最小回复通过代替完整能力验证。

## 仍需真实验证

| 项目 | 验收要求 |
|---|---|
| 旧 / 新 × exec / app-server | 同配置、同模型、同认证与 provider 来源；真实 turn 终态与返回内容断言 |
| fileChange / permissions 审批 | 参数、用户决策、实际副作用、取消和后续 turn；不能从 command 审批类推 |
| requestUserInput | 模式 / capability 的可用条件；用户答案正确映射，未实现时安全取消 |
| 桌面持有线程 / daemon / queue --remote | 单独获得授权后受控验证；自持进程实验不覆盖该范围 |
| detach 与 writer 释放 | 验证 unsubscribe 宽限期、关闭进程、崩溃后的锁释放和重复 attach |
| Windows / Linux | 当前真实观察仅 macOS；模拟协议断言不等于其他系统真机验证 |

## 复现与当前验收

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

每次运行创建独立临时 cwd 和 result.json；所有实验必须断言相应 turn、工具事件、审批副作用和后续 turn。失败以非零状态退出，finally 关闭所有子进程。默认仅继承 process.env；`CODEX_LAB_LOAD_SHELL_ENV=1` 才会执行登录 shell。完整参数与安全边界见[实验台说明](examples/codex-app-server-lab/README.md)。
