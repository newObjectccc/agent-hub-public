/**
 * ClaudeAdapter 单测（fake spawn，不真跑 claude CLI）：
 * spawn 参数安全集、prompt 分发/排队、WS 事件广播、abort 杀进程、错误收尾。
 */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import { ClaudeAdapter } from "../adapters/claude.js";
import type { ServerEvent } from "../types.js";

const SID = "394b6cea-13f8-44e8-bb03-5cda75fa88b0";
const CWD = "/Users/me/Workspace/demo";

const transcriptLines = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "帮我检查周报 KPI 口径" },
    uuid: "u1",
    timestamp: "2026-09-29T09:17:33.525Z",
    cwd: CWD,
    sessionId: SID,
  }),
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "好的" }] },
    uuid: "a1",
    timestamp: "2026-09-29T09:17:38.821Z",
    cwd: CWD,
    sessionId: SID,
  }),
];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly kills: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(String(signal ?? "SIGTERM"));
    return true;
  }
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: { cwd?: string };
}

let root: string;
let projectsDir: string;
const children: FakeChild[] = [];
const spawnCalls: SpawnCall[] = [];

const spawnFn = ((bin: string, args: string[], opts: { cwd?: string }) => {
  const child = new FakeChild();
  children.push(child);
  spawnCalls.push({ bin, args, opts });
  return child as unknown as ChildProcess;
}) as never;

function makeAdapter(emit: (sessionId: string, event: ServerEvent) => void): ClaudeAdapter {
  return new ClaudeAdapter({
    projectsDir,
    historyFile: join(root, "history.jsonl"),
    emit,
    spawnFn,
    claudeBin: "claude",
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  projectsDir = join(root, "projects");
  const projDir = join(projectsDir, "-Users-me-Workspace-demo");
  await mkdir(projDir, { recursive: true });
  await writeFile(join(projDir, `${SID}.jsonl`), transcriptLines.join("\n") + "\n", "utf8");
});

beforeEach(() => {
  children.length = 0;
  spawnCalls.length = 0;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("claude adapter: prompt → spawn 安全参数 + 事件广播", () => {
  it("spawn 参数为安全集（--resume/--output-format stream-json/--permission-mode manual，无 bypass）", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, ev) => events.push(ev));
    try {
      const result = await adapter.prompt(SID, "继续", undefined);
      assert.equal(result.accepted, true);
      assert.equal(spawnCalls.length, 1);
      const { bin, args, opts } = spawnCalls[0];
      assert.equal(bin, "claude");
      assert.deepEqual(args, [
        "-p",
        "继续",
        "--resume",
        SID,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "manual",
      ]);
      // 安全红线：不得出现任何提权/放行参数
      assert.ok(!args.includes("--dangerously-skip-permissions"));
      assert.ok(!args.includes("--allowedTools"));
      assert.ok(!args.includes("--allowed-tools"));
      assert.ok(!args.includes("--fork-session"));
      assert.equal(opts.cwd, CWD);

      // 合成 user 消息（-p 不回显 prompt）
      const userEnd = events.find((e) => e.type === "message_end") as { message: { role: string; text: string } };
      assert.ok(userEnd);
      assert.equal(userEnd.message.role, "user");
      assert.equal(userEnd.message.text, "继续");
      assert.equal(adapter.isLive(SID), true);
      assert.equal(adapter.getStatus(SID), "running");

      // 流事件 → 契约事件
      const child = children[0];
      child.stdout.emit(
        "data",
        [
          JSON.stringify({ type: "system", subtype: "init", session_id: SID, cwd: CWD }),
          JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_X", role: "assistant", content: [] } } }),
          JSON.stringify({
            type: "assistant",
            message: { id: "msg_X", role: "assistant", content: [{ type: "text", text: "收到，继续排查" }] },
            uuid: "a9",
            timestamp: "2026-09-29T13:00:00.000Z",
          }),
          JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
          JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "收到，继续排查", session_id: SID }),
          "",
        ].join("\n"),
      );
      const typesAfterStream = events.map((e) => e.type);
      assert.ok(typesAfterStream.includes("text_delta") || typesAfterStream.includes("message_end"));
      const assistantEnd = events.filter((e) => e.type === "message_end").at(-1) as {
        message: { role: string; text: string };
      };
      assert.equal(assistantEnd.message.role, "assistant");
      assert.equal(assistantEnd.message.text, "收到，继续排查");
      assert.ok(typesAfterStream.includes("agent_settled"));

      // 正常退出：不再重复 agent_settled
      const settledBefore = events.filter((e) => e.type === "agent_settled").length;
      child.emit("close", 0);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(events.filter((e) => e.type === "agent_settled").length, settledBefore);
      assert.equal(adapter.isLive(SID), false);
      assert.equal(adapter.getStatus(SID), "idle");
    } finally {
      adapter.disposeAll();
    }
  });

  it("正忙 + mode 缺省 → busy；steer → 排队到当前 run 结束后自动发送", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, ev) => events.push(ev));
    try {
      await adapter.prompt(SID, "第一条", undefined);
      const busy = await adapter.prompt(SID, "第二条", undefined);
      assert.equal(busy.busy, true);
      const busyExplicit = await adapter.prompt(SID, "第二条", "prompt");
      assert.equal(busyExplicit.busy, true);

      const queued = await adapter.prompt(SID, "排队的第三条", "followUp");
      assert.equal(queued.accepted, true);
      assert.equal(queued.mode, "followUp");
      assert.equal(spawnCalls.length, 1); // 排队不立即 spawn

      children.at(-1)?.emit("close", 0);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(spawnCalls.length, 2, "run 结束后应自动发送排队消息");
      assert.equal(spawnCalls[1].args[1], "排队的第三条");
    } finally {
      adapter.disposeAll();
    }
  });

  it("abort：SIGTERM 杀进程 + agent_settled + 清空排队（幂等）", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, ev) => events.push(ev));
    try {
      await adapter.prompt(SID, "会被中止", undefined);
      const queued = await adapter.prompt(SID, "排队的", "steer");
      assert.equal(queued.accepted, true);
      const child = children.at(-1)!;

      await adapter.abort(SID);
      assert.deepEqual(child.kills, ["SIGTERM"]);
      assert.ok(events.some((e) => e.type === "agent_settled"));
      assert.equal(adapter.getStatus(SID), "idle");

      // 进程收尾后队列已清空，不再 spawn
      child.emit("close", null);
      await new Promise((r) => setTimeout(r, 50));
      const spawnCount = spawnCalls.length;
      await adapter.abort(SID); // 幂等：无运行不抛
      assert.equal(spawnCalls.length, spawnCount);
    } finally {
      adapter.disposeAll();
    }
  });

  it("spawn 失败/异常退出：error 事件 + status error，不崩", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, ev) => events.push(ev));
    try {
      await adapter.prompt(SID, "会失败", undefined);
      const child = children.at(-1)!;
      child.stderr.emit("data", "claude: command not found");
      child.emit("close", 127);
      await new Promise((r) => setTimeout(r, 50));
      const err = events.find((e) => e.type === "error") as { code: string; message: string };
      assert.ok(err, "应有 error 事件");
      assert.equal(err.code, "PROMPT_FAILED");
      assert.match(err.message, /claude: command not found/);
      assert.ok(events.some((e) => e.type === "agent_settled"), "失败也要恢复 UI");
      assert.equal(adapter.getStatus(SID), "error");
    } finally {
      adapter.disposeAll();
    }
  });

  it("不存在的会话 id → SESSION_NOT_FOUND(404)；text 空 → INVALID_REQUEST", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      await assert.rejects(
        () => adapter.prompt("00000000-0000-4000-8000-000000000000", "hi", undefined),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "SESSION_NOT_FOUND");
          assert.equal((err as { statusCode: number }).statusCode, 404);
          return true;
        },
      );
      await assert.rejects(
        () => adapter.prompt(SID, "   ", undefined),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "INVALID_REQUEST");
          return true;
        },
      );
      await assert.rejects(
        () => adapter.prompt(SID, "hi", "bogus-mode"),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "INVALID_REQUEST");
          return true;
        },
      );
    } finally {
      adapter.disposeAll();
    }
  });

  it("listSessions 返回 source: claude 的列表项（真实目录扫描）", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const sessions = await adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, SID);
      assert.equal(sessions[0].source, "claude");
      assert.equal(sessions[0].cwd, CWD);
      assert.equal(sessions[0].lastUserMessage, "帮我检查周报 KPI 口径");
      assert.equal(sessions[0].lastAssistantMessage, "好的");
    } finally {
      adapter.disposeAll();
    }
  });
});
