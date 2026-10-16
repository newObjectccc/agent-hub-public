# codex app-server 实验台（X1–X11 复现脚本）

这里是 [docs/CODEX_DRIVER.md](../../CODEX_DRIVER.md) 里那份「codex 能不能做接管」结论的**原始实验台**。
2026-10-16 在本机跑完，脚本原样保留，方便：

- 升级 codex 后重跑一遍看协议是否变了（`app-server` 官方标注 `[experimental]`，**一定会变**）；
- 补测文档「七、待补测」里被挡住的项（fileChange/permissions 审批、requestUserInput 开关、daemon 共享 rejoin）；
- 体检自研 rollout 解析器对新版 codex 产物的兼容性。

## 脚本清单

| 文件 | 作用 |
|---|---|
| `lab.mjs` | app-server JSON-RPC harness：长驻子进程、请求 id 表、超时、ServerRequest 应答钩子、事件精简时间线（连续 `agentMessage/delta` 自动合并计数，不打印全文） |
| `env.mjs` | 从登录 shell 取 `OPENAI_*`/`CODEX_*`/`ANTHROPIC_*`/`CLAUDE_CODE_*` 注入子进程（复刻 `server/src/adapters/claude-env.ts`）。**只传值、不打印值**，日志里只输出键名 |
| `exp.mjs` | 主实验：`x2a`(resume 兼容面) `x2b`(真 turn) `x3`(steer) `x4accept`/`x4decline`(审批) `x5`(interrupt) `x6`(双进程互斥) `x7`(requestUserInput) |
| `probe2.mjs` | 版本/认证/模型清单、`thread/list` 全量翻页、legacy vs paginated resume |
| `probe5.mjs` | 指定二进制（桌面 app 内嵌的新版 codex）下的完整体检：auth → models → threads → resume → 真 turn |
| `probe6.mjs` | 能力探测：`experimentalFeature/list`、`permissionProfile/list`、`thread/turns/list`、`thread/items/list` |
| `parse-check.mjs` | 用 `server/dist/adapters/codex-rollout.js` 解析指定日期的 rollout，检查消息/工具/steer 注入是否被正确提取（X9） |

## 用法

```bash
# 1) 环境体检（不调模型，不花钱）
node probe2.mjs
CODEX_LAB_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" node probe5.mjs

# 2) 协议实验（会真实调用模型，花钱；沙箱 cwd 固定在 /tmp/codex-lab/ws）
export CODEX_LAB_BIN=/path/to/codex      # 缺省用 PATH 上的 codex
node exp.mjs x2b                          # 最小真 turn
node exp.mjs x3                           # 运行中 steer
node exp.mjs x4accept                     # 审批 → 允许（真执行命令）
node exp.mjs x4decline                    # 审批 → 拒绝（不卡死）
node exp.mjs x5                           # interrupt
node exp.mjs x6                           # 双 app-server 进程互斥
node exp.mjs x7                           # requestUserInput

# 3) 解析兼容性体检（需要 server 已构建：pnpm --filter @agent-hub/server build）
node parse-check.mjs 2026/10/16
```

### 可调环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `CODEX_LAB_BIN` | `codex` | 用哪个 codex 二进制。**本机 PATH 是 0.143.0，桌面 app 内嵌 0.162.0-alpha.17.2，两者行为差异很大**（互斥有无、paginated 支持、模型表新旧） |
| `CODEX_LAB_MODEL` | 不传（用 `~/.codex/config.toml` 的 `model`） | 覆盖模型；模型名不在 `model/list` 里会 400 |
| `CODEX_LAB_POLICY` | `untrusted` | X4 的 `approvalPolicy`；`on-request` 下模型常常自行放弃、不产生审批请求 |
| `CODEX_LAB_ARGS` | 空 | 追加 app-server 启动参数，用 `\|` 分隔，例：`-c\|preferred_auth_method="apikey"` |
| `CODEX_LAB_DIR` / `CODEX_LAB_WS` | `/tmp/codex-lab` / `/tmp/codex-lab/ws` | 沙箱根与实验 cwd |
| `CODEX_ROLLOUT_JS` | `../../../server/dist/adapters/codex-rollout.js` | `parse-check.mjs` 用哪个解析器产物 |

## 安全边界（改脚本时请守住）

1. **cwd 永远在沙箱**（`/tmp/codex-lab/ws`），不指向任何项目工作区；X4 的 accept 分支会真执行命令，
   prompt 里只允许写 `lab-approval.txt`。
2. **不传任何放宽权限的 flag**：不出现 `--dangerously-bypass-approvals-and-sandbox`；
   `approvalPolicy`/`sandbox` 只允许**收紧**（实验里用 `untrusted` + `workspace-write`/`read-only`）。
3. **不打印凭据**：`env.mjs` 只输出键名；`auth.json` 只读结构不读值。
4. **不碰 daemon / remote-control**：`codex app-server daemon start` 需要 standalone 安装（会改你的
   codex 安装方式），`codex remote-control` 是 OpenAI 自己的远程通道（与「数据不出机器」冲突）。
   两者都只在文档里记录，脚本不调用。
5. 实验会在 `~/.codex/sessions/` 下留下真实 rollout（新 thread），需要时用
   `codex delete <id>` 或直接删对应文件清理。
