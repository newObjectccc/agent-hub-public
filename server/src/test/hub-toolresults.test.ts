/**
 * SessionHub live.toolResults 限容回归（OOM 审计 P2-6）：
 * 单 run 数千工具调用 × preview 文本原全量驻留（message_start 才 clear）。
 * 上限 SessionHub.TOOL_RESULTS_MAX=200：保留最近 200 条工具结果 preview，
 * 被逐出的老 callId 在 message_end 折叠时降级为无 preview（status pending）。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSession, AgentSessionEvent, createAgentSession } from "@earendil-works/pi-coding-agent";
import { SessionHub } from "../sessions/hub.js";
import type { ServerEvent } from "../types.js";

interface FakeRec {
  emit: (event: AgentSessionEvent) => void;
}

/** 假 createAgentSession：只保留事件出口，供直接驱动 handleSdkEvent */
function fakeCreate(created: FakeRec[]): typeof createAgentSession {
  return (async () => {
    let handler: ((event: AgentSessionEvent) => void) | null = null;
    const rec: FakeRec = {
      emit: (event) => handler?.(event),
    };
    const session = {
      subscribe: (fn: (event: AgentSessionEvent) => void) => {
        handler = fn;
        return () => {
          handler = null;
        };
      },
      get isIdle() {
        return true;
      },
      prompt: async () => undefined,
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
      compact: async () => undefined,
      dispose: () => undefined,
      sessionManager: { getEntries: () => [] },
    } as unknown as AgentSession;
    created.push(rec);
    return { session };
  }) as unknown as typeof createAgentSession;
}

function toolCallBlock(id: string): Record<string, unknown> {
  return { type: "toolCall", id, name: "bash", arguments: {} };
}

function toolEnd(id: string, text: string): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "bash",
    args: {},
    result: { content: [{ type: "text", text }] },
    isError: false,
  } as unknown as AgentSessionEvent;
}

function assistantEnd(callIds: string[]): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: Date.now(),
      content: callIds.map(toolCallBlock),
    },
  } as unknown as AgentSessionEvent;
}

describe("SessionHub：live.toolResults 限容（P2-6）", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-toolres-"));
    const enc = "--tmp-work-demo--";
    await mkdir(join(dir, enc), { recursive: true });
    await writeFile(
      join(dir, enc, "s0.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "s0", timestamp: "2026-02-18T09:00:00.000Z", cwd: "/tmp/work-demo" }),
        JSON.stringify({
          type: "message",
          id: "u0",
          parentId: null,
          timestamp: "2026-02-18T10:00:00.000Z",
          message: { role: "user", content: "hi", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
        }),
      ].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("数千工具调用只留最近 TOOL_RESULTS_MAX 条 preview，更早的折叠为无 preview", async () => {
    const created: FakeRec[] = [];
    const events: ServerEvent[] = [];
    const hub = new SessionHub(dir, (_id, event) => events.push(event), { createAgentSession: fakeCreate(created) });
    try {
      await hub.ensureLive("s0");
      const rec = created[0];
      const total = SessionHub.TOOL_RESULTS_MAX + 50;
      const callIds = Array.from({ length: total }, (_, i) => `c${i}`);
      for (const id of callIds) rec.emit(toolEnd(id, `r${id}`));
      events.length = 0;
      rec.emit(assistantEnd(callIds));

      const end = events.find((e): e is Extract<ServerEvent, { type: "message_end" }> => e.type === "message_end");
      assert.ok(end, "应有 message_end");
      const toolCalls = end.message.toolCalls ?? [];
      assert.equal(toolCalls.length, total);
      // 边界：第 50 条（c49）被逐出，第 51 条（c50）保留
      assert.equal(toolCalls[total - SessionHub.TOOL_RESULTS_MAX - 1].resultPreview, null, "窗口外最旧一条被逐出");
      assert.equal(toolCalls[total - SessionHub.TOOL_RESULTS_MAX - 1].status, "pending");
      assert.equal(toolCalls[total - SessionHub.TOOL_RESULTS_MAX].resultPreview, "rc50", "窗口边界第一条保留 preview");
      assert.equal(toolCalls[total - SessionHub.TOOL_RESULTS_MAX].status, "done");
      // 最新的保留
      assert.equal(toolCalls[total - 1].resultPreview, `rc${total - 1}`);
      // 其余被逐出的也无 preview
      assert.equal(toolCalls[0].resultPreview, null);
      assert.equal(toolCalls[0].status, "pending");
    } finally {
      hub.disposeAll();
    }
  });

  it("边界：恰好 TOOL_RESULTS_MAX 条全部保留（上限只裁超出部分）", async () => {
    const created: FakeRec[] = [];
    const events: ServerEvent[] = [];
    const hub = new SessionHub(dir, (_id, event) => events.push(event), { createAgentSession: fakeCreate(created) });
    try {
      await hub.ensureLive("s0");
      const rec = created[0];
      const callIds = Array.from({ length: SessionHub.TOOL_RESULTS_MAX }, (_, i) => `d${i}`);
      for (const id of callIds) rec.emit(toolEnd(id, `r${id}`));
      events.length = 0;
      rec.emit(assistantEnd(callIds));
      const end = events.find((e): e is Extract<ServerEvent, { type: "message_end" }> => e.type === "message_end");
      const toolCalls = (end?.message.toolCalls ?? []);
      assert.equal(toolCalls.length, SessionHub.TOOL_RESULTS_MAX);
      assert.ok(toolCalls.every((t) => t.resultPreview !== null && t.status === "done"), "满窗口不裁");
    } finally {
      hub.disposeAll();
    }
  });

  it("message_start 清空后重新积累（沿用原生命周期，限容不改变折叠语义）", async () => {
    const created: FakeRec[] = [];
    const events: ServerEvent[] = [];
    const hub = new SessionHub(dir, (_id, event) => events.push(event), { createAgentSession: fakeCreate(created) });
    try {
      await hub.ensureLive("s0");
      const rec = created[0];
      rec.emit(toolEnd("old", "rold"));
      rec.emit({
        type: "message_start",
        message: { role: "assistant", timestamp: Date.now() },
      } as unknown as AgentSessionEvent);
      rec.emit(toolEnd("new", "rnew"));
      events.length = 0;
      rec.emit(assistantEnd(["old", "new"]));
      const end = events.find((e): e is Extract<ServerEvent, { type: "message_end" }> => e.type === "message_end");
      const toolCalls = end?.message.toolCalls ?? [];
      assert.equal(toolCalls[0].resultPreview, null, "message_start 前的旧结果已清（无 preview）");
      assert.equal(toolCalls[1].resultPreview, "rnew");
    } finally {
      hub.disposeAll();
    }
  });
});
