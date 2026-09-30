/**
 * pi-command 扩展纯函数测试（指令→注入映射、URL/body 构造、幂等执行结果）。
 * 不启动 pi 运行期、不发网络请求——扩展本体的故障静默行为由真机验证覆盖。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_LIVE_URL,
  ackBody,
  ackUrl,
  commandsUrl,
  executeCommand,
  heartbeatBody,
  heartbeatUrl,
  planInjection,
  resolveBaseUrl,
  type AgentCommandLike,
  type InjectOptions,
} from "./command.js";

describe("pi-command: URL / body 构造", () => {
  it("base 归一（默认 127.0.0.1:7700，尾斜杠去除）", () => {
    assert.equal(resolveBaseUrl(undefined), DEFAULT_LIVE_URL);
    assert.equal(resolveBaseUrl(""), DEFAULT_LIVE_URL);
    assert.equal(resolveBaseUrl("http://127.0.0.1:7711/"), "http://127.0.0.1:7711");
  });

  it("三端点路径与查询参数", () => {
    assert.equal(heartbeatUrl("http://127.0.0.1:7711/"), "http://127.0.0.1:7711/api/agents/heartbeat");
    assert.equal(ackUrl(undefined), `${DEFAULT_LIVE_URL}/api/agents/ack`);
    assert.equal(
      commandsUrl(undefined, "sess-1", 25000),
      `${DEFAULT_LIVE_URL}/api/agents/commands?sessionId=sess-1&wait=25000`,
    );
  });

  it("heartbeat body 带 pid/cwd/capabilities；ack body 截断 error", () => {
    const body = heartbeatBody("sess-1", "/tmp/demo");
    assert.equal(body.sessionId, "sess-1");
    assert.equal(body.cwd, "/tmp/demo");
    assert.equal(typeof body.pid, "number");
    assert.deepEqual(body.capabilities, ["message", "steer", "followUp"]);
    const ack = ackBody("sess-1", "cmd-1", false, "x".repeat(600));
    assert.equal(ack.ok, false);
    assert.equal((ack.error as string).length, 500);
  });
});

describe("pi-command: planInjection（指令 → pi.sendUserMessage 调用）", () => {
  it("steer → deliverAs steer（插话当前 run）", () => {
    const plan = planInjection({ kind: "message", text: "改个方向", mode: "steer" }, () => false);
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.equal(plan.mode, "steer");
      assert.deepEqual(plan.call.options, { deliverAs: "steer", expandPromptTemplates: true });
      assert.equal(plan.call.content, "改个方向");
    }
  });

  it("followUp → deliverAs followUp（排队）", () => {
    const plan = planInjection({ kind: "message", text: "排队消息", mode: "followUp" }, () => true);
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.deepEqual(plan.call.options, { deliverAs: "followUp", expandPromptTemplates: true });
    }
  });

  it("prompt：空闲时直接发（无 deliverAs），正忙时拒绝并给原因", () => {
    const idle = planInjection({ kind: "message", text: "新消息", mode: "prompt" }, () => true);
    assert.equal(idle.ok, true);
    if (idle.ok) {
      assert.deepEqual(idle.call.options, { expandPromptTemplates: true });
    }
    const busy = planInjection({ kind: "message", text: "新消息", mode: "prompt" }, () => false);
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.match(busy.error, /prompt 模式仅空闲时可发/);
  });

  it("非法指令：未知 kind / 未知 mode / 缺 text / isIdle 抛错按正忙处理", () => {
    assert.equal(planInjection({ kind: "shutdown", text: "x" }, () => true).ok, false);
    assert.equal(planInjection({ kind: "message", text: "x", mode: "nextTurn" }, () => true).ok, false);
    assert.equal(planInjection({ kind: "message", text: "   " }, () => true).ok, false);
    const throwing = planInjection({ kind: "message", text: "x", mode: "prompt" }, () => {
      throw new Error("stale ctx");
    });
    assert.equal(throwing.ok, false);
    if (!throwing.ok) assert.match(throwing.error, /仅空闲时可发/);
  });

  it("mode 缺省按 prompt 处理", () => {
    const plan = planInjection({ kind: "message", text: "hi" }, () => true);
    assert.equal(plan.ok, true);
    if (plan.ok) assert.equal(plan.mode, "prompt");
  });
});

describe("pi-command: executeCommand（注入 + 结果回执内容）", () => {
  const collect = (): { calls: Array<{ content: string; options: InjectOptions }>; deps: { sendUserMessage: (c: string, o: InjectOptions) => void; isIdle: () => boolean } } => {
    const calls: Array<{ content: string; options: InjectOptions }> = [];
    return {
      calls,
      deps: {
        sendUserMessage: (content, options) => {
          calls.push({ content, options });
        },
        isIdle: () => true,
      },
    };
  };

  it("成功注入 → ok=true 且调用参数与计划一致", () => {
    const { calls, deps } = collect();
    const outcome = executeCommand({ id: "cmd-1", kind: "message", text: "你好", mode: "steer" }, deps);
    assert.deepEqual(outcome, { commandId: "cmd-1", ok: true, error: null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].content, "你好");
    assert.deepEqual(calls[0].options, { deliverAs: "steer", expandPromptTemplates: true });
  });

  it("注入抛错 → ok=false 带原因；缺 id → 失败；非 message → 失败", () => {
    const boom = executeCommand({ id: "cmd-2", kind: "message", text: "x", mode: "steer" }, {
      sendUserMessage: () => {
        throw new Error("Agent is already processing");
      },
      isIdle: () => true,
    });
    assert.equal(boom.ok, false);
    assert.match(boom.error ?? "", /already processing/);

    const noId = executeCommand({ kind: "message", text: "x", mode: "steer" }, collect().deps);
    assert.deepEqual(noId, { commandId: "", ok: false, error: "指令缺少 id" });

    const badKind = executeCommand({ id: "cmd-3", kind: "compact", text: "x" }, collect().deps);
    assert.equal(badKind.ok, false);
  });
});
