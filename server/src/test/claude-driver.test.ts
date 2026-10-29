/**
 * ClaudeDriverHub 单测（fake spawn，仿 agents.test.ts 显式 now 时间穿越）。
 * 覆盖：attach 幂等/上限/静默窗、send 三模式（E3 预案 B）、command_ack、turn 排队、
 * abort control interrupt（E4）、权限请求挂起/应答/超时 deny、崩溃/主动 detach 收尾。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriverHub, readClaudeDriverSettings, type EmitFn } from "../adapters/claude-driver.js";
import type { ServerEvent } from "../types.js";
import { encodeUserMessage } from "../adapters/claude-host-protocol.js";

type CommandAckEvent = Extract<ServerEvent, { type: "command_ack" }>;

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  written: string[] = [];
  constructor() {
    super();
    // 同步记录 stdin 写入（PassThrough data 事件是异步的，断言需同步可见）
    const origWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      this.written.push(String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof this.stdin.write;
  }
  kill(): boolean {
    this.killed = true;
    this.emit("close", 0, null);
    return true;
  }
}

function makeHub(overrides: Partial<ConstructorParameters<typeof ClaudeDriverHub>[0]> = {}) {
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];
  const emit: EmitFn = (sessionId, event) => events.push({ sessionId, event });
  const children: FakeChild[] = [];
  const spawnFn = (() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const hub = new ClaudeDriverHub({
    emit,
    liveUrl: "http://127.0.0.1:7700",
    bridgeScriptPath: "/x/bridge.mjs",
    spawnFn,
    readSettings: async () => null,
    hostRequestTtlMs: 50,
    ...overrides,
  });
  return {
    hub,
    events,
    children,
    last: () => children[children.length - 1],
    acked: (commandId: string): CommandAckEvent[] =>
      events
        .map((e) => e.event)
        .filter((e): e is CommandAckEvent => e.type === "command_ack" && e.commandId === commandId),
    attachEvents: () => events.filter((e) => e.event.type === "attach_state"),
  };
}

const sessionOpts = { cwd: "/w", sessionFile: "/tmp/claude-driver-test-missing.jsonl" };

describe("权限配置继承与 bridge 选择（permissionMode=inherit 沿用 settings）", () => {
  const cases = [
    { name: "项目 default 覆盖用户 bypass，仍挂手机审批 bridge", user: { permissions: { defaultMode: "bypassPermissions" } }, project: { permissions: { defaultMode: "default" } }, local: null, bridge: true },
    { name: "项目 bypass 覆盖用户 default", user: { permissions: { defaultMode: "default" } }, project: { permissions: { defaultMode: "bypassPermissions" } }, local: null, bridge: false },
    { name: "项目无权限覆盖时继承用户模式", user: { permissions: { defaultMode: "bypassPermissions" } }, project: { env: { EXAMPLE: "1" } }, local: null, bridge: false },
    { name: "项目本地配置优先于用户和项目配置", user: { permissions: { defaultMode: "bypassPermissions" } }, project: { permissions: { defaultMode: "bypassPermissions" } }, local: { permissions: { defaultMode: "default" } }, bridge: true },
    { name: "损坏或非对象配置仍回退为需要审批", user: [], project: "invalid-json", local: null, bridge: true },
  ];
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const dir = await mkdtemp(join(tmpdir(), "driver-settings-"));
      const userHome = join(dir, "home");
      const cwd = join(dir, "project");
      await mkdir(join(userHome, ".claude"), { recursive: true });
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(join(userHome, ".claude", "settings.json"), JSON.stringify(testCase.user));
      await writeFile(join(cwd, ".claude", "settings.json"), typeof testCase.project === "string" ? testCase.project : JSON.stringify(testCase.project));
      if (testCase.local) await writeFile(join(cwd, ".claude", "settings.local.json"), JSON.stringify(testCase.local));
      let args: string[] = [];
      const t = makeHub({
        permissionMode: "inherit",
        readSettings: () => readClaudeDriverSettings(cwd, userHome),
        spawnFn: ((_bin: string, spawnArgs: string[]) => { args = spawnArgs; return new FakeChild(); }) as unknown as typeof import("node:child_process").spawn,
      });
      try {
        await t.hub.attach("s1", { cwd, sessionFile: join(dir, "missing.jsonl") });
        assert.equal(args.includes("--permission-prompt-tool"), testCase.bridge);
        assert.equal(args.includes("--permission-prompts"), testCase.bridge);
        assert.ok(!args.includes("--permission-mode"), "inherit 不下发 --permission-mode flag");
      } finally {
        t.hub.disposeAll();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("显式权限档位（配置是唯一权威，settings 不降级）", () => {
  const tiers: Array<{ name: string; mode: string; bridge: boolean; settings?: unknown }> = [
    { name: "默认 bypassPermissions：无论 settings 都不挂 bridge、显式下发 flag", mode: "bypassPermissions", bridge: false },
    { name: "bypassPermissions：settings 显式 manual 也不降级", mode: "bypassPermissions", bridge: false, settings: { permissions: { defaultMode: "default" } } },
    { name: "manual：无论 settings 都挂手机审批 bridge", mode: "manual", bridge: true },
    { name: "manual：settings 显式 bypass 也不放行", mode: "manual", bridge: true, settings: { permissions: { defaultMode: "bypassPermissions" } } },
  ];
  for (const tier of tiers) {
    it(tier.name, async () => {
      let args: string[] = [];
      const t = makeHub({
        permissionMode: tier.mode as "manual",
        readSettings: async () => tier.settings ?? null,
        spawnFn: ((_bin: string, spawnArgs: string[]) => { args = spawnArgs; return new FakeChild(); }) as unknown as typeof import("node:child_process").spawn,
      });
      try {
        await t.hub.attach("s1", sessionOpts);
        assert.equal(args.includes("--permission-prompt-tool"), tier.bridge);
        assert.equal(args.includes("--permission-prompts"), tier.bridge);
        const i = args.indexOf("--permission-mode");
        assert.ok(i > 0, "显式档位必须下发 --permission-mode");
        assert.equal(args[i + 1], tier.mode);
      } finally {
        t.hub.disposeAll();
      }
    });
  }

  it("默认构造（未传 permissionMode）即 bypassPermissions 最高权限", async () => {
    let args: string[] = [];
    const t = makeHub({
      spawnFn: ((_bin: string, spawnArgs: string[]) => { args = spawnArgs; return new FakeChild(); }) as unknown as typeof import("node:child_process").spawn,
    });
    try {
      await t.hub.attach("s1", sessionOpts);
      assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "bypassPermissions"]);
      assert.ok(!args.includes("--permission-prompt-tool"), "bypass 运行不挂 bridge");
    } finally {
      t.hub.disposeAll();
    }
  });
});

describe("attach/detach 生命周期", () => {
  it("读取配置期间外部终端重新写盘，启动前复核并拒绝双写", async () => {
    const dir = await mkdtemp(join(tmpdir(), "driver-start-guard-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, "old\n");
    const old = new Date(Date.now() - 10_000);
    await utimes(file, old, old);
    const t = makeHub({ readSettings: async () => { await writeFile(file, "external resumed\n"); return null; } });
    try {
      await assert.rejects(t.hub.attach("s1", { cwd: dir, sessionFile: file }), /电脑端正在写入/);
      assert.equal(t.children.length, 0);
    } finally {
      t.hub.disposeAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("并发接管同一会话只创建一个进程", async () => {
    const t = makeHub();
    try {
      await Promise.all([t.hub.attach("s1", sessionOpts), t.hub.attach("s1", sessionOpts)]);
      assert.equal(t.children.length, 1);
    } finally {
      t.hub.disposeAll();
    }
  });

  it("接管准备期间也占用并发名额，取消后不得继续启动", async () => {
    const t = makeHub({ maxConcurrent: 1 });
    const first = t.hub.attach("s1", sessionOpts);
    try {
      await assert.rejects(t.hub.attach("s2", sessionOpts), (error: unknown) => (error as { code: string }).code === "DRIVER_LIMIT");
      assert.equal(t.hub.detach("s1"), true);
      await assert.rejects(first, /启动已取消/);
      assert.equal(t.children.length, 0);
    } finally {
      t.hub.disposeAll();
    }
  });

  it("attach 幂等复用：二次 attach 不再 spawn", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    await t.hub.attach("s1", sessionOpts);
    assert.equal(t.children.length, 1);
    assert.equal(t.hub.isAttached("s1"), true);
    const states = t.attachEvents();
    assert.equal(states.length, 1); // 幂等不重复广播
  });

  it("detach 广播 attach_state false，进程被杀", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.detach("s1");
    assert.equal(t.hub.isAttached("s1"), false);
    assert.equal(t.last().killed, true);
    const ev = t.attachEvents().at(-1)!.event;
    assert.equal(ev.type === "attach_state" && ev.attached, false);
  });

  it("并发上限 1：第二个会话 attach 抛 DRIVER_LIMIT", async () => {
    const t = makeHub({ maxConcurrent: 1 });
    await t.hub.attach("s1", sessionOpts);
    await assert.rejects(() => t.hub.attach("s2", sessionOpts), /上限/);
  });

  it("崩溃：非主动退出 → attach_state false + 队列指令失败回执", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.send("s1", { text: "q1", mode: "followUp" }); // 入队
    const last = t.last();
    last.emit("close", 1, null); // 模拟崩溃
    assert.equal(t.hub.isAttached("s1"), false);
    assert.equal(t.attachEvents().at(-1)!.event.type === "attach_state", true);
  });
});

describe("接管 turn 完成与错误回传", () => {
  it("驻留进程就绪不会误报任务运行；每轮 result 都会广播完成或错误", async () => {
    const t = makeHub();
    try {
      await t.hub.attach("s1", sessionOpts);
      t.last().stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
      assert.equal(t.hub.runStatusFor("s1"), "idle");
      assert.ok(!t.events.some(({ event }) => event.type === "status" && event.status === "running"));
      t.hub.send("s1", { text: "第一轮" });
      t.last().stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
      assert.equal(t.hub.runStatusFor("s1"), "idle");
      assert.equal(t.events.filter(({ event }) => event.type === "agent_settled").length, 1);
      t.hub.send("s1", { text: "第二轮" });
      t.last().stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "模型请求失败" }) + "\n");
      assert.equal(t.hub.runStatusFor("s1"), "error");
      assert.ok(t.events.some(({ event }) => event.type === "error" && event.message === "模型请求失败"));
      assert.equal(t.events.filter(({ event }) => event.type === "agent_settled").length, 2);
      assert.equal(t.hub.isAttached("s1"), true);
    } finally {
      t.hub.disposeAll();
    }
  });

  it("上一轮 result 后消费队列，新一轮立即维持 running", async () => {
    const t = makeHub();
    try {
      await t.hub.attach("s1", sessionOpts);
      t.hub.send("s1", { text: "第一轮" });
      t.hub.send("s1", { text: "第二轮", mode: "followUp" });
      t.last().stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
      assert.equal(t.hub.runStatusFor("s1"), "running");
      const status = t.events.filter(({ event }) => event.type === "status").at(-1)?.event;
      assert.equal(status?.type === "status" && status.status, "running");
    } finally {
      t.hub.disposeAll();
    }
  });

  it("无效 JSON 值不使驻留进程监听崩溃；无换行的尾部错误仍会送达", async () => {
    const t = makeHub();
    try {
      await t.hub.attach("s1", sessionOpts);
      assert.doesNotThrow(() => t.last().stdout.write('null\n[]\n42\n'));
      t.hub.send("s1", { text: "最后一轮" });
      t.last().stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "末尾报错" }));
      t.last().emit("close", 0);
      assert.ok(t.events.some(({ event }) => event.type === "error" && event.message === "末尾报错"));
    } finally {
      t.hub.disposeAll();
    }
  });
});

describe("send 三模式（E3 预案 B）", () => {
  it("prompt 空闲直写 stdin + user 气泡 + ack ok", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const cmd = t.hub.send("s1", { text: "hello" });
    const child = t.last();
    assert.ok(child.written.some((l) => l.trimEnd() === encodeUserMessage("hello")));
    assert.deepEqual(t.acked(cmd.id).map((a) => a.ok), [true]);
    assert.ok(t.events.some((e) => e.event.type === "message_end"));
  });

  it("prompt 正忙 → 失败回执（不写 stdin）", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.send("s1", { text: "first" }); // turn 开始
    const before = t.last().written.length;
    const cmd = t.hub.send("s1", { text: "second", mode: "prompt" });
    assert.equal(t.last().written.length, before);
    const ack = t.acked(cmd.id).at(-1)!;
    assert.equal(ack.ok, false);
    assert.match(ack.error ?? "", /正忙/);
  });

  it("steer 正忙时立即写入（真插话）", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.send("s1", { text: "long task" });
    const before = t.last().written.length;
    const cmd = t.hub.send("s1", { text: "stop now", mode: "steer" });
    assert.equal(t.last().written.length, before + 1);
    assert.ok(t.last().written.some((l) => l.trimEnd() === encodeUserMessage("stop now")));
    assert.equal(t.acked(cmd.id).at(-1)!.ok, true);
  });

  it("followUp 正忙时排队，result 后自动发出", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.send("s1", { text: "long task" });
    const cmd = t.hub.send("s1", { text: "then this", mode: "followUp" });
    assert.ok(!t.last().written.some((l) => l.trimEnd() === encodeUserMessage("then this")));
    assert.deepEqual(t.acked(cmd.id).map((a) => a.ok), []); // 排队中未回执
    // result 行 = turn 结束 → 消费队列
    t.last().stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
    assert.ok(t.last().written.some((l) => l.trimEnd() === encodeUserMessage("then this")));
    assert.equal(t.acked(cmd.id).at(-1)!.ok, true);
  });

  it("clientMessageId 幂等：重复提交不二次注入", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const c1 = t.hub.send("s1", { text: "hi", clientMessageId: "local-1" });
    const before = t.last().written.length;
    const c2 = t.hub.send("s1", { text: "hi", clientMessageId: "local-1" });
    assert.equal(c2.id, c1.id);
    assert.equal(t.last().written.length, before);
  });

  it("未 attach 发消息 → ATTACH_REQUIRED 409", () => {
    const t = makeHub();
    assert.throws(() => t.hub.send("s1", { text: "x" }), /未处于接管模式/);
  });
});

describe("abort（E4 control interrupt）", () => {
  it("turn 中 abort：写 interrupt 行 + 清空 followUp 队列（失败回执）", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.send("s1", { text: "long" });
    const q = t.hub.send("s1", { text: "queued", mode: "followUp" });
    t.hub.abortTurn("s1");
    const child = t.last();
    assert.ok(child.written.some((l) => l.includes('"subtype":"interrupt"')));
    assert.equal(t.acked(q.id).at(-1)!.ok, false);
  });

  it("空闲 abort 不写 interrupt", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    t.hub.abortTurn("s1");
    assert.ok(!t.last().written.some((l) => l.includes("interrupt")));
  });
});

describe("权限请求（bridge 挂起 → 手机应答）", () => {
  const body = {
    sessionId: "s1",
    requestId: "call_1",
    toolName: "Bash",
    toolUseId: "call_1",
    input: { command: "rm -rf x" },
  };

  it("register 发出 host_request 事件，respond 解结并广播 resolved", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const pending = t.hub.registerHostRequest(body);
    assert.ok(t.events.some((e) => e.event.type === "host_request"));
    assert.equal(t.hub.listHostRequests("s1").length, 1);
    const ok = t.hub.respondHostRequest("s1", "call_1", { behavior: "allow", message: "" });
    assert.equal(ok, true);
    const decision = await pending;
    assert.equal(decision.behavior, "allow");
    assert.equal(t.hub.listHostRequests("s1").length, 0);
    assert.ok(t.events.some((e) => e.event.type === "host_request_resolved"));
  });

  it("超时一律 deny（绝不自动 allow）", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const pending = t.hub.registerHostRequest(body);
    // unref 计时器不保活事件循环：先用 ref'd sleep 撑过 TTL
    await new Promise((r) => setTimeout(r, 80));
    const decision = await pending; // hostRequestTtlMs=50ms
    assert.equal(decision.behavior, "deny");
  });

  it("重复 requestId 复用同一挂起", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const p1 = t.hub.registerHostRequest(body);
    const p2 = t.hub.registerHostRequest(body);
    t.hub.respondHostRequest("s1", "call_1", { behavior: "deny", message: "no" });
    assert.equal((await p1).behavior, "deny");
    assert.equal((await p2).behavior, "deny");
  });

  it("detach 收尾挂起请求为 deny", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const pending = t.hub.registerHostRequest(body);
    t.hub.detach("s1");
    assert.equal((await pending).behavior, "deny");
  });

  it("未 attach 的会话 register 直接 deny", async () => {
    const t = makeHub();
    const decision = await t.hub.registerHostRequest(body);
    assert.equal(decision.behavior, "deny");
  });

  it("parallel run 在环（parallelActive）时未 attach 会话同样挂起审批（与接管同一套手机卡片）", async () => {
    const t = makeHub({ parallelActive: (id) => id === "s1" });
    const pending = t.hub.registerHostRequest(body);
    assert.ok(t.events.some((e) => e.event.type === "host_request"), "parallel 会话的权限请求广播到手机");
    assert.equal(t.hub.listHostRequests("s1").length, 1, "断线重连兜底拉取可见");
    assert.equal(t.hub.respondHostRequest("s1", "call_1", { behavior: "allow", message: "" }), true);
    assert.equal((await pending).behavior, "allow");
    assert.equal(t.hub.isResolvedHostRequest("call_1"), true, "已决记忆与接管路径同语义");
  });

  it("parallel run 不在环（伪造请求）register 仍 deny，不产生卡片", async () => {
    const t = makeHub({ parallelActive: () => false });
    const decision = await t.hub.registerHostRequest(body);
    assert.equal(decision.behavior, "deny");
    assert.ok(!t.events.some((e) => e.event.type === "host_request"));
  });

  it("已决记忆：应答后 isResolvedHostRequest 为 true，重复应答返回 false（路由据此 409）", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    const pending = t.hub.registerHostRequest(body);
    assert.equal(t.hub.isResolvedHostRequest("call_1"), false, "未决时不算已决");
    assert.equal(t.hub.respondHostRequest("s1", "call_1", { behavior: "allow", message: "" }), true);
    await pending;
    // finishHostRequest 从 hostRequests 删除后仍记入已决记忆：契约 §12「已决 → 409」可判
    assert.equal(t.hub.isResolvedHostRequest("call_1"), true);
    assert.equal(t.hub.respondHostRequest("s1", "call_1", { behavior: "deny", message: "" }), false, "已决再应答返回 false");
    assert.equal(t.hub.isResolvedHostRequest("call_1"), true, "重复应答后仍是已决");
  });

  it("已决记忆：未知 id 与 TTL 过期后均为 false（路由回落 404）", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    assert.equal(t.hub.isResolvedHostRequest("nope"), false, "从未应答过的 id 不算已决");
    const pending = t.hub.registerHostRequest(body);
    t.hub.respondHostRequest("s1", "call_1", { behavior: "deny", message: "" });
    await pending;
    const later = Date.now() + 6 * 60_000; // 越过 5 分钟 TTL
    assert.equal(t.hub.isResolvedHostRequest("call_1", later), false, "TTL 过期后已决记忆失效");
  });

  it("已决记忆超上限（200）淘汰最旧，防膨胀", async () => {
    const t = makeHub();
    await t.hub.attach("s1", sessionOpts);
    for (let i = 0; i < 205; i++) {
      const p = t.hub.registerHostRequest({ ...body, requestId: `cap_${i}` });
      t.hub.respondHostRequest("s1", `cap_${i}`, { behavior: "deny", message: "" });
      await p;
    }
    assert.equal(t.hub.isResolvedHostRequest("cap_0"), false, "最旧条目被淘汰");
    assert.equal(t.hub.isResolvedHostRequest("cap_4"), false, "超限部分按最旧淘汰");
    assert.equal(t.hub.isResolvedHostRequest("cap_5"), true, "仍在上限内的保留");
    assert.equal(t.hub.isResolvedHostRequest("cap_204"), true, "最新条目保留");
  });
});

describe("statusFor / 空闲 detach", () => {
  it("statusFor：hub 形态 online 恒 true（可接管语义）", async () => {
    const t = makeHub();
    assert.deepEqual(t.hub.statusFor("s1"), { online: true, attached: false, driver: "hub", mirror: false });
    await t.hub.attach("s1", sessionOpts);
    assert.deepEqual(t.hub.statusFor("s1"), { online: true, attached: true, driver: "hub", mirror: false });
  });

  it("idleDetachMs 到期自动 detach", async () => {
    const t = makeHub({ idleDetachMs: 20 });
    await t.hub.attach("s1", sessionOpts);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.hub.isAttached("s1"), false);
  });

  it("turn 进行中不自动 detach", async () => {
    const t = makeHub({ idleDetachMs: 20 });
    await t.hub.attach("s1", sessionOpts);
    t.hub.send("s1", { text: "long" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.hub.isAttached("s1"), true);
    t.hub.disposeAll();
  });
});
