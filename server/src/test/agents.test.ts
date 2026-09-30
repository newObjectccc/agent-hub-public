/**
 * AgentCommandHub 单测（E3 双模式：心跳/在线判定、attach/detach、指令队列、
 * 长轮询唤醒、回执幂等、重复保护、超时重投、TTL 过期、离线自动失效）。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  AgentCommandHub,
  HEARTBEAT_TTL_MS,
  MAX_ATTEMPTS,
  MAX_QUEUE,
  type AckResult,
} from "../agents.js";
import type { ServerEvent } from "../types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Recorder {
  hub: AgentCommandHub;
  events: Array<{ sessionId: string; event: ServerEvent }>;
}

function makeHub(options: { ackTimeoutMs?: number; commandTtlMs?: number } = {}): Recorder {
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];
  const hub = new AgentCommandHub((sessionId, event) => events.push({ sessionId, event }), options);
  return { hub, events };
}

function acked(events: Array<{ sessionId: string; event: ServerEvent }>, commandId: string): AckResult | null {
  for (const { event } of events) {
    if (event.type === "command_ack" && event.commandId === commandId) {
      return { commandId, ok: event.ok, error: event.error, at: 0 };
    }
  }
  return null;
}

describe("AgentCommandHub: 心跳与在线判定", () => {
  it("心跳注册 + 90s TTL：窗口内在线，超时离线", () => {
    const { hub } = makeHub();
    const t0 = 1_000_000;
    hub.heartbeat({ sessionId: "s1", pid: 123, cwd: "/tmp/demo", capabilities: ["message"] }, t0);
    assert.equal(hub.isOnline("s1", t0 + HEARTBEAT_TTL_MS), true);
    assert.equal(hub.isOnline("s1", t0 + HEARTBEAT_TTL_MS + 1), false);
    assert.deepEqual(hub.statusFor("s1", t0 + 1000), { online: true, attached: false });
  });

  it("非法心跳（缺 sessionId）拒绝；续期刷新 lastSeen", () => {
    const { hub } = makeHub();
    assert.throws(() => hub.heartbeat({ sessionId: "" }, 1), /sessionId 非法/);
    hub.heartbeat({ sessionId: "s1" }, 1000);
    hub.heartbeat({ sessionId: "s1" }, 90_000);
    assert.equal(hub.isOnline("s1", 90_000 + HEARTBEAT_TTL_MS - 1), true);
    assert.equal(hub.isOnline("s1", 90_000 + HEARTBEAT_TTL_MS + 1), false);
  });
});

describe("AgentCommandHub: attach / detach", () => {
  it("终端离线 attach 拒绝（ATTACH_UNAVAILABLE）；在线成功并广播 attach_state", () => {
    const { hub, events } = makeHub();
    assert.throws(() => hub.attach("s1", 1000), /终端 pi 不在线/);
    hub.heartbeat({ sessionId: "s1", pid: 7 }, 1000);
    const info = hub.attach("s1", 1100);
    assert.equal(info.pid, 7);
    assert.equal(hub.isAttached("s1", 1100), true);
    assert.deepEqual(events[0], {
      sessionId: "s1",
      event: { type: "attach_state", attached: true, terminalOnline: true },
    });
  });

  it("attach 后心跳超时自动失效（懒判定 + sweep 兜底），未 ack 指令取消", () => {
    const { hub, events } = makeHub();
    hub.heartbeat({ sessionId: "s1" }, 1000);
    hub.attach("s1", 1000);
    const cmd = hub.enqueue("s1", { text: "hi", mode: "steer" }, 1100);
    // 90s 后无心跳：isAttached 自动失效
    assert.equal(hub.isAttached("s1", 1000 + HEARTBEAT_TTL_MS + 1), false);
    assert.equal(hub.isAttached("s1", 1000 + HEARTBEAT_TTL_MS + 1), false);
    const cancel = acked(events, cmd.id);
    assert.equal(cancel?.ok, false);
    assert.match(cancel?.error ?? "", /指令取消/);
  });

  it("detach 清空队列并广播 attach_state:false；未投递指令给失败回执", () => {
    const { hub, events } = makeHub();
    const t = Date.now();
    hub.heartbeat({ sessionId: "s1" }, t);
    hub.attach("s1", t);
    const cmd = hub.enqueue("s1", { text: "hi", mode: "followUp" }, t);
    assert.equal(hub.detach("s1"), true);
    assert.equal(hub.isAttached("s1"), false);
    const cancel = acked(events, cmd.id);
    assert.equal(cancel?.ok, false);
    assert.match(cancel?.error ?? "", /已退出接管模式/);
    const last = events[events.length - 1];
    assert.deepEqual(last.event, { type: "attach_state", attached: false, terminalOnline: true });
  });
});

describe("AgentCommandHub: 指令队列与投递", () => {
  it("入队→短轮询投递→回执完成（含 command_ack 广播与 attempts 计数）", async () => {
    const { hub, events } = makeHub();
    hub.heartbeat({ sessionId: "s1" }, 1000);
    hub.attach("s1", 1000);
    const cmd = hub.enqueue("s1", { text: "你好", mode: "steer" }, 1100);
    assert.equal(cmd.mode, "steer");
    assert.equal(cmd.attempts, 0);

    const batch = await hub.poll("s1", 0, 1100);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].id, cmd.id);
    assert.equal(batch[0].attempts, 1);

    const result = hub.ack("s1", cmd.id, true, undefined, 1200);
    assert.equal(result?.ok, true);
    assert.deepEqual(acked(events, cmd.id), { commandId: cmd.id, ok: true, error: null, at: 0 });
    // ack 幂等：重复 ack 返回首条结果
    assert.equal(hub.ack("s1", cmd.id, false, "再次"), result);
    assert.deepEqual(await hub.poll("s1", 0, 1300), []);
  });

  it("长轮询挂起，enqueue 即唤醒（低延迟投递）", async () => {
    const { hub } = makeHub();
    hub.heartbeat({ sessionId: "s1" }, Date.now());
    hub.attach("s1", Date.now());
    const pending = hub.poll("s1", 5_000);
    await sleep(10);
    const cmd = hub.enqueue("s1", { text: "wake", mode: "prompt" });
    const started = Date.now();
    const batch = await pending;
    assert.equal(batch.length, 1);
    assert.equal(batch[0].id, cmd.id);
    assert.ok(Date.now() - started < 1000, "唤醒应在秒级内完成");
  });

  it("未 attach 入队拒绝（ATTACH_REQUIRED）；mode 非法拒绝；clientMessageId 幂等", () => {
    const { hub } = makeHub();
    assert.throws(() => hub.enqueue("s1", { text: "x" }), /未处于接管模式/);
    hub.heartbeat({ sessionId: "s1" }, 1000);
    hub.attach("s1", 1000);
    assert.throws(() => hub.enqueue("s1", { text: "x", mode: "nextTurn" }, 1100), /mode 必须是/);
    assert.throws(() => hub.enqueue("s1", { text: "  " }, 1100), /text 必须是非空字符串/);

    const first = hub.enqueue("s1", { text: "hi", mode: "steer", clientMessageId: "c-1" }, 1100);
    const again = hub.enqueue("s1", { text: "hi", mode: "steer", clientMessageId: "c-1" }, 1200);
    assert.equal(again.id, first.id, "同 clientMessageId 不重复入队");
  });

  it("队列上限保护（50）与未 ack 不重复入队计数", () => {
    const { hub } = makeHub();
    hub.heartbeat({ sessionId: "s1" }, 1000);
    hub.attach("s1", 1000);
    for (let i = 0; i < MAX_QUEUE; i += 1) {
      hub.enqueue("s1", { text: `msg-${i}`, mode: "followUp" }, 1100);
    }
    assert.throws(() => hub.enqueue("s1", { text: "overflow", mode: "followUp" }, 1100), /队列已满/);
  });
});

describe("AgentCommandHub: 超时重投与过期保护", () => {
  it("投递后未回执 → 同 commandId 重投（attempts+1），超上限丢弃并失败回执", async () => {
    const { hub, events } = makeHub({ ackTimeoutMs: 15 });
    hub.heartbeat({ sessionId: "s1" }, Date.now());
    hub.attach("s1", Date.now());
    const cmd = hub.enqueue("s1", { text: "retry", mode: "steer" });
    const first = await hub.poll("s1", 0);
    assert.equal(first[0].attempts, 1);
    await sleep(40);
    const second = await hub.poll("s1", 0);
    assert.equal(second.length, 1);
    assert.equal(second[0].id, cmd.id, "重投同 id（扩展按 id 幂等防重复注入）");
    assert.equal(second[0].attempts, 2);
    await sleep(40);
    const third = await hub.poll("s1", 0);
    assert.equal(third[0].attempts, MAX_ATTEMPTS);
    await sleep(40);
    assert.deepEqual(await hub.poll("s1", 0), [], "超过投递上限不再重投");
    const final = acked(events, cmd.id);
    assert.equal(final?.ok, false);
    assert.match(final?.error ?? "", /回执超时/);
  });

  it("队列 TTL 过期丢弃（失败回执 + 不再投递）", () => {
    const { hub, events } = makeHub({ commandTtlMs: 10 });
    hub.heartbeat({ sessionId: "s1" }, 1000);
    hub.attach("s1", 1000);
    const cmd = hub.enqueue("s1", { text: "stale", mode: "prompt" }, 1100);
    void hub.poll("s1", 0, 1200).then(() => undefined);
    const drop = acked(events, cmd.id);
    assert.equal(drop?.ok, false);
    assert.match(drop?.error ?? "", /超时未投递/);
    assert.equal(hub.isAttached("s1", 1200), true);
  });
});
