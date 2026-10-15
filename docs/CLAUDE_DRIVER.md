# Claude Code hub 驱动接管（claude-driver）——实验结论与驱动契约

> Phase 0 实验记录 + 当前实现契约（更新于 2026-10-15）。下方 E1–E4 是 2026-10-14
> 在 claude CLI 2.1.267（macOS）的实验结果，不代表所有 CLI 版本均有相同行为。
> 形态定义见开发计划：attach 期间 hub 为会话持有长驻 `claude -p --resume <id> --input-format stream-json ...` 进程，
> 手机消息 stdin 注入 = 真用户 turn；detach 后回电脑 `claude --resume` 续聊。
> 这是 hub 新建的进程，不是接入或控制原先的 TUI 进程。tmux 仅展示 hub 驱动的输出。

## 一、实验结论（E1–E4，均已真机实测）

### E2 权限应答（go/no-go）——✅ 通道成立

**发现 1（重要）**：裸 CLI stream-json + `--permission-prompts host` **不会**产生 `control_request`。
「host」指 Agent SDK host——裸 CLI 无人应答时权限**自动拒绝**（`tool_result_meta: [{non_execution_kind: "user-rejected"}]`），
错误文案复用 sandbox 路径模板（"was blocked. For security..."），有误导性但本质是「无人批准=拒绝」。

**发现 2**：本次实验可用的应答通道 = **`--permission-prompt-tool`（隐藏 flag）+ 自带 MCP stdio server**：

- 启动参数：`--mcp-config '{"mcpServers":{"permhook":{"command":"node","args":["perm-bridge.mjs"]}}}' --permission-prompt-tool mcp__permhook__permission_prompt`
  （工具名必须全名 `mcp__<server>__<tool>`，裸名报错并列出可用清单）
- **请求形状**（MCP `tools/call`）：

```json
{"method":"tools/call","params":{"name":"permission_prompt","arguments":{
  "tool_name":"Bash",
  "input":{"command":"touch ./e2-probe-4.txt","description":"Create empty file e2-probe-4.txt"},
  "tool_use_id":"call_912c157949824901a878adb8"
}}}
```

- **应答格式**（实验测试的样式中仅此通过）：`content[0].text` 为 JSON 字符串，且 **`message` 字段必填**（allow 时空串）：

```json
{"content":[{"type":"text","text":"{\"behavior\":\"allow\",\"updatedInput\":{...},\"message\":\"\"}"}],"isError":false}
```

- 行为验证：`allow` → 工具执行、turn 继续；`deny` → 工具不执行、模型正常收尾（**不卡死**）、不再重试询问。
- 其余试过的样式（平铺 PermissionResult / 纯 "allow" 文本）报「格式非法」被拒。

**发现 3**：用户机 `~/.claude/settings.json` `permissions.defaultMode: "bypassPermissions"` 时**权限请求根本不产生**（全自动放行）。
即全机 bypass 用户的「缺口 1」不存在；MCP bridge 只服务非 bypass 用户。

**发现 4（边界）**：`--permission-mode manual` 在 init 事件里显示 `permissionMode: "default"`（manual 是 default 的别名）。

### E1 AskUserQuestion ——✅ 结果①：文字化提问

headless 工具列表**不含** AskUserQuestion（它与 ExitPlanMode 同属宿主 UI 工具，不进 `-p` 会话）。
模型被要求使用时明确说明「工具不存在」，转为**文字化提问**（实验中模型甚至声明「我不会替你作答」）。
→ 本次实验中可文字问、文字答，无需额外问题卡片。

### E3/E3b 运行中 stdin 注入时机 ——✅ 预案 B：工具间隙转向（真 steer）

- 单个长工具（12s Bash）运行中注入：工具结束后立即处理新消息（不等 turn 收尾播报）。
- **E3b 多工具场景（决定性）**：三连 Bash 任务，第 1 个工具（sleep 8）结束的间隙注入「Stop...say HELLO-STEER-2」
  → 模型**立刻转向**执行注入消息，后续 TWO/THREE 未执行。
- 结论与官方文档一致（「read between tool calls, never interrupt a running tool」）：
  - **steer = 立即写 stdin**（当前工具结束即转向）；
  - **followUp = 本地队列**，result（turn 结束）后写入；
  - **prompt = 空闲直写；busy → 指令回执失败**。当前 `/message` 先返回 202 和 commandId，
    再发 `command_ack{ok:false,error:"会话正忙…"}`；这与 parallel `/prompt` 的 HTTP 409 不同。

### E4 abort ——✅ control interrupt（进程存活）

- **control interrupt（采用）**：stdin 发
  `{"type":"control_request","request_id":"req-xxx","request":{"subtype":"interrupt"}}`
  → 立即回执 `{"type":"control_response","response":{"subtype":"success","request_id":"req-xxx","response":{"still_queued":[]}}}`
  （`interrupt_receipt_v1` 能力），turn 以 `result.subtype: "error_during_execution"` 收尾，**驱动进程存活可接下一条**。
- SIGINT：turn 同样中止收尾，但**进程一并退出**（仅作崩溃兜底，不作 abort 通道）。

## 二、驱动契约（Phase 1 实现依据）

### spawn 参数（固定安全集）

```
claude -p --resume <session-id>
  --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages
  --permission-prompts host                                  # 非 bypass 时
  --permission-prompt-tool mcp__permhook__permission_prompt   # 非 bypass 时
  --mcp-config <perm-bridge 配置>                              # 非 bypass 时
  [--permission-mode <resolved>]                               # 见下
```

禁止出现：`--dangerously-skip-permissions` / `--allowedTools` / `--bare`（bare 不绑 socket/无 hooks）。
bridge 选择按用户级 settings → 项目 settings → 项目本地 settings 合并 `permissions`，后者覆盖前者，
未声明的字段继续继承；最终 `permissions.defaultMode` 为 `bypassPermissions` 时可不挂 bridge，
其余情况挂 bridge 走手机批权限。实际工具许可由 CLI 加载的配置决定，hub 不额外添加绕过权限的 flag。

### stdin 消息（真用户 turn）

```json
{"type":"user","message":{"role":"user","content":"<text>"}}
```

多条顺序写入即多轮（同进程、同 session_id、transcript 同文件追加——已实测）。

### stdout 事件（节选，完整流走既有 ClaudeStreamTranslator）

| type/subtype | 含义 |
|---|---|
| `system/init` | 启动握手；进程就绪不代表已有 turn 运行 |
| `system/thinking_tokens` | CLI 的思考进度；当前 chat 翻译器不将其作为 thinking 正文 |
| `assistant` | 文本/thinking/tool_use 分块；当前 chat 提取文本和工具，跳过 thinking |
| `user`（tool_result） | 工具结果 |
| `system/permission_denied` | 自动拒绝（非 bridge 通道的硬拦截） |
| `control_response` | interrupt 回执 |
| `result` | 本轮结束：先翻译为 idle/error 与 `agent_settled`，再处理 followUp；进程仍可存活，下一轮重新发 running |

### abort

stdin `{"type":"control_request","request_id":"<req-id>","request":{"subtype":"interrupt"}}`。

### 生命周期

- 同 session 并发 attach 共用一次启动，正在准备的接管也计入 `maxConcurrent`。
  detach/dispose 可取消准备中的启动，不会在用户退出后再拉起进程。
- 准备环境前及 spawn 前各检查一次文件静默窗，捕获准备期间的新写入；这不是进程锁。
- 空闲进程保持 idle；写入用户消息立即置 running，`result` 收尾才结束本轮。
  `runStatusFor` 将实际状态提供给列表/详情，错误收尾保持 error。
- stdout 使用 UTF-8 安全的 JSONL reader，允许跨 chunk 字符与 JSON 分块，退出时处理最后一条无换行记录。
  无效的 JSON 值（null/数组/标量）忽略；流式 assistant 沿用原生 `message.id` 与历史/工具回填对账。
- detach SIGTERM→2s SIGKILL；崩溃先收尾未完成消息及本轮，再发 `attach_state{attached:false}` 与错误。
- server 重启不自动恢复 attach（web 走既有校正回落 parallel）。
- 空闲自动 detach（默认 30min）；turn 进行中不 detach。

## 三、已知限制

1. **接管期间勿在电脑原 TUI 窗口输入**（无法进程级互斥，双写防护靠 busy 判定 + mtime 静默窗）。
2. 裸 CLI 无 control 权限协议（那是 SDK host 的）；权限走 MCP permission-prompt-tool bridge。
3. 非 bypass 环境下 sandbox 路径硬拦截仍存在（error 文案有误导，实为 permission 拒绝模板）。
4. `--permission-mode manual` ≡ `default`。
5. Claude 平行模式只向本服务持有的 run 排队（steer/followUp 均在进程结束后执行）；
   未接管的外部终端忙时三种模式均返回 409 `SESSION_BUSY`，不会接受无人消费的队列。
6. 外部进程运行状态依赖文件活动推断，长时间无写盘仍在思考时可能判断不准。接管不会停止原 TUI，
   也不会把新消息显示到那个窗口；切回原 TUI 前先 detach。
7. 旧会话即使原终端已关闭也可以从手机续聊。打开页面可能按策略准备接管，但不会自动发送历史任务。
   server 重启不会自动恢复执行；关闭 PWA 不等于 abort。

## 四、实现落点（速查）

| 组件 | 位置 |
|---|---|
| 驱动进程管理 | `server/src/adapters/claude-driver.ts`（ClaudeDriverHub） |
| 协议纯函数 | `server/src/adapters/claude-host-protocol.ts` |
| 权限 MCP bridge | `integrations/claude-perm-bridge/bridge.mjs` |
| tmux 投屏 | `server/src/adapters/claude-mirror.ts` + `cli/mirror.js` |
| 防双写 | `server/src/adapters/claude.ts` isEffectivelyBusy + attach 静默窗 |
| 路由 | `server/src/routes.ts` attach/detach/message 分流 + host-requests 端点 |
| 前端 | `web/src/components/HostRequestCard.tsx`、`web/src/api/attach.ts`、ChatPage 默认策略 |

配置（`hub.config.json` `claudeDriver` 段，逐字段校验、非法回默认）：

- `enabled`（默认 `true`）：总开关。**`false` = 不构造 ClaudeDriverHub**（`claudeDriver` 为
  null），claude 接管路由（attach / detach / message / host-requests）一律 400
  `INVALID_REQUEST`「claude 会话接管未启用」，前端回落 📱 parallel；`terminal` 也不下发。
- `defaultPolicy: active-only|always|never`（默认 `active-only`）：智能默认接管策略，
  **下发通道 = `terminal.defaultPolicy`**（`GET /api/sessions` 与 `GET /api/sessions/:id` 的
  `terminal` 字段，pi/claude 双通道均带；老 server 缺省 → 前端按 `active-only` 容错）。
  语义：`active-only`=Claude 的 `status=running` 或 `lastDrivenBy=terminal` 时尝试接管，
  因此最后由终端驱动的空闲会话也可能默认接管；pi 要求扩展在线。
  `always`=打开即尝试接管；`never`=只手动。手动 pin 优先，实际启动仍受开关、静默窗和并发上限约束。
- `idleDetachMs`（默认 30min）：空闲自动 detach（`0` = 永不；turn 进行中不 detach）。
- `maxConcurrent`（默认 3）：并发驱动上限，含准备中的启动（超出 409 `DRIVER_LIMIT`）。
- `mirror: tmux|off`（默认 `tmux`）：终端投屏（无 tmux 自动降级 off）。
- `externalQuietMs`（默认 3000）：准备前与 spawn 前分别检查 sessionFile 静默窗；
  近期写入返回 409 `ATTACH_UNAVAILABLE`。mtime 只是外部活动线索，不提供进程级互斥。

## 五、回归验收清单

以下是当前实现需要覆盖的场景。E1–E4 的真机结论只适用于上方标明的实验环境；
自动化验证记录见 [CHANGELOG.md](../CHANGELOG.md)。

2026-10-15 使用实际 web 构建产物与模拟数据补查六档视口（320/360/390/430/768/1024）、
导航跳转、图片加载、权限详情与拒绝交互；均无页面横向溢出，权限按钮高度 44px。
390px 页面截图：[浅色](screenshots/claude-v03-390-light.png) / [深色](screenshots/claude-v03-390-dark.png)。

1. 打开活跃 claude 会话（电脑刚跑过）→ 自动接管 + 轻提示 + `tmux attach -t hub-<id8>` 可观看
2. 手机发消息 → 执行、transcript 追加、投屏实时显示
3. 运行中插话（steer）→ 当前工具结束后立即转向（E3b 语义）
4. 权限卡片：非 bypass 环境触发工具确认 → 手机允许 → 执行；拒绝 → 模型正常继续（不卡死）
5. 提问：模型文字化提问，手机文字回答（无 AskUserQuestion 卡死）
6. abort → turn 中止（error_during_execution 收尾），会话可继续发消息
7. detach → 投屏 pane 打印 resume 提示；电脑 `claude --resume <id>` 无缝接回
8. 双开冲突：attach 期间 parallel 发送 409 ATTACH_ACTIVE；外部 TUI 活跃时 parallel 三种 mode 均 409 busy；准备前/启动前静默窗拒绝
9. 手机刷新/断线重连 → 未决权限卡仍在（GET host-requests 兜底）
10. server 重启 → attach 态消失、回落 parallel、历史无损
11. hub 平行 run 忙时 steer/followUp 含图片队列在 close 后消费；abort 取消队列及尚未完成的启动
12. 接管进程 init 后保持 idle；发送后 running；成功/失败 result 分别变 idle/error；后续排队任务重新 running
13. assistant 单条消息结束后工具仍可继续；5s 状态补查不提前结束任务，旧查询不覆盖新一轮
14. 中文字符与 JSON 跨 stdout chunk、无换行尾行、重复 attach/并发上限/准备中取消均有回归覆盖
15. 刷新后 assistant ID 与历史一致，工具结果回填同一消息；图片尺寸提示不进入用户气泡；匹配上传引用的成功 Read 才恢复旧图预览
