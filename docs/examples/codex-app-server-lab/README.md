# Codex app-server 协议实验台

为 [CODEX_DRIVER.md](../../CODEX_DRIVER.md) 提供可重复的协议断言。原 2026-10-16 真机结果保留在该文档的“历史观察”中；本轮只运行模拟 Node 子进程测试，没有新增真实模型结果。

## 默认安全边界

- probe2 / probe5 默认只读取二进制版本、模型清单、账号模式和线程列表。不会随机 resume 历史线程，不调用 turn/start，不读取 auth.json，不扫描私人 rollout。
- exp 的所有实验必须明确加 `--run`。这表示允许真实模型调用及相应用例的受控操作；x2a 还要求 `--thread <id>`，resume 可能占 writer 或更新线程元数据。
- 每次创建独立临时目录、工作区和 result.json。审批实验只允许与脚本完全一致的一条样本写入命令，检查 cwd / thread / turn，结束后移除样本；accept / decline 反复运行不会共享样本证据。
- 目录只允许位于系统临时目录下；即使设置 CODEX_LAB_DIR / CODEX_LAB_WS，也不能把项目目录当沙箱。子进程 cwd 始终使用该次生成的隔离工作区。
- 默认只继承当前 process.env。`CODEX_LAB_LOAD_SHELL_ENV=1` 才执行登录 shell；这可能执行 rc 副作用。环境值、鉴权响应、输入、模型 / 命令正文、stderr 原文和完整 ServerRequest 不输出到日志或 artifact。
- 未实现的 ServerRequest 明确返回 -32601 并使验收失败；x7 对问答明确返回 unsupported，从不替用户选答案。不会自动扩大权限、启动 daemon、安装 / 升级 Codex、连接桌面会话或转入 exec 重试。

这些限制约束实验脚本。模型本身仍是外部系统，因此真实运行需要用户主动执行 `--run`；模拟测试不会运行模型提示中的命令。

## 文件

| 文件 | 用途 |
|---|---|
| lab.mjs | 可注入 spawn / cwd / env / log 的有界 JSON-RPC harness；完整 initialize + initialized；UTF-8 分块与尾行 flush；异步应答、相关事件等待、进程与 timer 清理 |
| run.mjs | 隔离运行目录、只读探针、字段白名单证据和 finally 关闭进程 |
| env.mjs | 当前进程环境继承；显式 opt-in 的登录 shell provider 环境导入 |
| exp.mjs | x2a / x2b / x3 / x4accept / x4decline / x5 / x6 / x7 的真实断言入口 |
| probe2.mjs / probe5.mjs | 相同只读范围；probe5 保留作不同二进制版本的比较入口 |
| probe6.mjs | 默认同只读探针；`--experimental` 才声明 experimentalApi 并查询实验能力列表 |
| parse-check.mjs | 仅解析 `--rollout` 明确指定的一份文件；只输出计数，不输出消息正文 |
| fixtures/fake-server.mjs | 纯 Node 协议替身；不调用模型、不执行 shell 提示、只在各测试的临时目录制造受控副作用 |
| *.test.mjs | harness 故障注入与 CLI smoke；包括“没有 --run 不启动”“默认探针无 turn / resume”回归 |

## 使用

```bash
# 从仓库根执行。只用模拟子进程，无真实模型调用
node --test docs/examples/codex-app-server-lab/*.test.mjs

cd docs/examples/codex-app-server-lab
node probe2.mjs
CODEX_LAB_BIN=/path/to/another/codex node probe5.mjs
node probe6.mjs --experimental

# 以下会真实调用模型，需用户主动执行
CODEX_LAB_BIN=/path/to/codex node exp.mjs x2b --run
node exp.mjs x3 --run
node exp.mjs x4accept --run
node exp.mjs x4decline --run
node exp.mjs x5 --run
node exp.mjs x6 --run
node exp.mjs x7 --run

# 仅用户明确选定的线程；可能占 writer / 改元数据
node exp.mjs x2a --run --thread <explicit-test-thread-id>

# x2b 的 result.json 提供本次新建线程的 rollout.reference；不自动扫描私人历史
# 需要先构建 server；也可用 CODEX_ROLLOUT_JS 指向明确的解析器产物
node parse-check.mjs --rollout /explicit/path/to/lab-rollout.jsonl
```

成功退出 0；协议 / 断言 / 工具 / 模型 / 超时失败退出 1；缺少 opt-in 或参数错误退出 2。运行开始后的错误也会写入 result.json，并在 finally 中关闭全部自持子进程。未成功创建目录时只能返回安全错误码。

## 用例的断言

| 用例 | 必须证明 |
|---|---|
| x2a | 只 resume 指定 threadId、返回明确线程状态、unsubscribe 应答；随后关闭进程。此用例不证明桌面 rejoin |
| x2b | 匹配 turn/started 与 turn/completed completed、PONG 标记、无命令调用、本次新建线程 rollout 非空 |
| x3 | 先观察同一 thread / turn 的长命令 item/started，且未完成；steer 返回相同 turnId；终态 completed、标记正确、后两条命令未开始、未新建 turn |
| x4accept / x4decline | 确实收到本轮的精确样本命令审批；接受后精确文件内容与命令成功 / 拒绝后没有文件；本轮 completed，后续 turn 完整 completed |
| x5 | 先观察本轮长命令正在执行，再 interrupt；本轮 interrupted 且无终态错误，后续 turn 完整 completed |
| x6 | A 长命令正在执行时，B resume 明确返回 active-writer 冲突，A 仍在执行；中止 A 后 interrupted。B 若被旧版本放行则立即失败，绝不继续发第二个 turn |
| x7 | 确实观察到本轮 requestUserInput、明确回 unsupported、没有代答或副作用，本轮 completed。未触发提问时验收失败；这表示没有证明该能力，不代表协议永久不可用 |

长命令里的 sleep 只是建立可控制的执行窗口；脚本绝不用固定等待时间判断命令已开始。终态按 threadId、turnId 和提交前 cursor 关联。willRetry 错误通知、thread/started、serverRequest/resolved 或下一轮仅返回 inProgress 都不算完成证明。

## 配置

| 环境变量 | 默认 / 说明 |
|---|---|
| CODEX_LAB_BIN | PATH 中的 codex；不同版本 / 通道的行为必须分别验证 |
| CODEX_LAB_MODEL | 不覆盖配置；model/list 中存在也不代表实际账号权限 |
| CODEX_LAB_POLICY | x4 默认 untrusted；只允许 untrusted / on-request；没有触发审批则断言失败 |
| CODEX_LAB_DIR | 系统临时目录下 agent-hub-codex-lab；每次追加随机 run 子目录 |
| CODEX_LAB_WS | 可选的 workspace 容器，必须在 CODEX_LAB_DIR 内；每次另建随机工作区 |
| CODEX_LAB_TIMEOUT_MS | 180000；只接受 50–600000 毫秒 |
| CODEX_LAB_LOAD_SHELL_ENV | 默认关闭；仅值 1 才执行登录 shell，值不打印 |
| CODEX_ROLLOUT_JS | 相对脚本定位的 server/dist/adapters/codex-rollout.js；自定义路径相对当前工作目录 |

为防止通过附加参数扩大权限，脚本不再接受 CODEX_LAB_ARGS。协议测试可通过 AppServer 的 spawn / args 注入一个受控替身；真实实验只配置明确的二进制、模型和收紧权限。

## Harness 与证据格式

```js
const server = new AppServer({ cwd, env, bin, spawn, log }).start();
try {
  await server.initialize();
  const after = server.cursor;
  const { turn } = await server.request("turn/start", { threadId, input: [text("...")] });
  const event = await server.waitFor("turn/completed", {
    threadId, turnId: turn.id, after, timeoutMs: 180000,
  });
  // assert event.params.turn.status against the intended result
} finally {
  await server.close();
}
```

waitFor 默认只匹配调用后事件；用捕获的 after 允许提交之后、响应之前的竞态事件。匹配历史保留 params，默认消费，已消费事件不会再误中下一轮；turn / item 字符串方法必须传 threadId 和 turnId。超时直接 reject，绝不返回 null 冒充成功。历史、字节数、delta 文本、请求、等待器和服务端应答都有上限。

result.json 包含 schemaVersion、case、passed / failed、每项断言、受控副作用元数据、终态和安全事件摘要。正文只在有界内存里供断言使用；真实 item/agentMessage/delta 按 thread / turn / item 合并，日志不打印 delta。已丢弃历史时，需要证明“没有发生”的用例必须失败，避免将缺少证据写成通过。

临时目录与机器证据会保留供复查；审批样本会移除。真实 `--run` 新建的线程还可能写入 Codex 自身会话存储；脚本不会删除、归档或改名任何既有会话。清理本次产物前先依据 artifact 确认范围。
