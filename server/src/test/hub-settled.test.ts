/**
 * SessionHub 运行收尾（agent_settled 必达）测试：
 * - SDK 正常发 agent_settled → 原样透传，恰好一次
 * - SDK 没发（异常/事件丢失）→ run 结束兜底补 agent_settled + status idle（中止按钮不残留）
 * - abort 中止 → 已收尾，不重复 agent_settled、不把中止变 error
 * - 真实失败 → error 事件 + status error（UI 可恢复）
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSession, AgentSessionEvent, createAgentSession } from "@earendil-works/pi-coding-agent";
import { SessionHub } from "../sessions/hub.js";
import type { ServerEvent } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeSession {
  session: AgentSession;
  emit: (event: AgentSessionEvent) => void;
}

function makeFakeSession(
  promptImpl: () => Promise<void>,
  abortImpl: () => Promise<void> = async () => undefined,
): FakeSession {
  let handler: ((event: AgentSessionEvent) => void) | null = null;
  const session = {
    subscribe: (fn: (event: AgentSessionEvent) => void) => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    isIdle: true,
    prompt: promptImpl,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: abortImpl,
    compact: async () => undefined,
    sessionManager: { getEntries: () => [] },
  } as unknown as AgentSession;
  return { session, emit: (event) => handler?.(event) };
}

function fakeCreate(fake: FakeSession) {
  return (async () => ({ session: fake.session })) as unknown as typeof createAgentSession;
}

describe("SessionHub：agent_settled 必达（中止按钮不残留）", () => {
  let dir: string;
  const events: ServerEvent[] = [];
  const activities: string[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-settled-"));
    const enc = "--tmp-work-demo--";
    await mkdir(join(dir, enc), { recursive: true });
    await writeFile(
      join(dir, enc, "s1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/work-demo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-02-18T10:00:00.000Z",
          message: { role: "user", content: "修复构建", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
        }),
      ].join("\n"),
      "utf8",
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeHub(fake: FakeSession): SessionHub {
    events.length = 0;
    activities.length = 0;
    const hub = new SessionHub(dir, (_id, event) => events.push(event), {
      createAgentSession: fakeCreate(fake),
    });
    hub.onActivity = (_id, activity) => activities.push(activity.kind);
    return hub;
  }

  const settledCount = () => events.filter((e) => e.type === "agent_settled").length;
  const statusSeq = () => events.filter((e) => e.type === "status").map((e) => (e as { status: string }).status);

  it("SDK 未发 agent_settled：run 结束兜底补 agent_settled + status idle", async () => {
    const fake = makeFakeSession(async () => undefined);
    const hub = makeHub(fake);
    const result = await hub.prompt("s1", "你好", undefined);
    assert.equal(result.accepted, true);
    await sleep(30);
    assert.equal(settledCount(), 1, `应兜底 agent_settled，实际 ${JSON.stringify(events)}`);
    assert.deepEqual(statusSeq(), ["running", "idle"]);
    assert.equal(events.at(-1)?.type, "status");
  });

  it("SDK 已发 agent_settled：透传恰好一次，不重复兜底", async () => {
    const fake = makeFakeSession(async () => {
      fake.emit({ type: "agent_settled" } as AgentSessionEvent);
    });
    const hub = makeHub(fake);
    await hub.prompt("s1", "你好", undefined);
    await sleep(30);
    assert.equal(settledCount(), 1, `agent_settled 应恰好一次，实际 ${JSON.stringify(events)}`);
  });

  it("abort 中止：run reject 不报 error、不重复 agent_settled（done 活动照常上报）", async () => {
    let rejectRun: ((err: Error) => void) | null = null;
    const fake = makeFakeSession(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRun = reject;
        }),
      async () => {
        rejectRun?.(new Error("aborted"));
      },
    );
    const hub = makeHub(fake);
    await hub.prompt("s1", "跑很久", undefined);
    await hub.abort("s1");
    await sleep(30);
    assert.equal(settledCount(), 0, `abort 已收尾，不应再发 agent_settled，实际 ${JSON.stringify(events)}`);
    assert.ok(!events.some((e) => e.type === "error"), "中止不得变成红色错误");
    assert.deepEqual(activities, ["done"]);
    assert.deepEqual(statusSeq(), ["running", "idle"]);
  });

  it("真实失败：error 事件 + status error（UI 可恢复），不误发 idle 收尾", async () => {
    const fake = makeFakeSession(async () => {
      throw new Error("模型调用失败");
    });
    const hub = makeHub(fake);
    await hub.prompt("s1", "你好", undefined);
    await sleep(30);
    assert.ok(events.some((e) => e.type === "error"), `失败应报 error，实际 ${JSON.stringify(events)}`);
    assert.deepEqual(statusSeq(), ["running", "error"]);
    assert.equal(settledCount(), 0);
  });
});
