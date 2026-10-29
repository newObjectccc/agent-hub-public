/**
 * ClaudeAdapter 单测（fake spawn，不真跑 claude CLI）：
 * spawn 参数安全集、prompt 分发/排队、WS 事件广播、abort 杀进程、错误收尾。
 */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import { ClaudeAdapter } from "../adapters/claude.js";
import type { ClaudeAdapterOptions } from "../adapters/claude.js";
import { ENV_LIVE_TOKEN, ENV_LIVE_URL, ENV_SESSION_ID, PERM_TOOL_FULL_NAME } from "../adapters/claude-host-protocol.js";
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
  opts: { cwd?: string; env?: NodeJS.ProcessEnv };
}

let root: string;
let projectsDir: string;
const children: FakeChild[] = [];
const spawnCalls: SpawnCall[] = [];

const spawnFn = ((bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
  const child = new FakeChild();
  children.push(child);
  spawnCalls.push({ bin, args, opts });
  return child as unknown as ChildProcess;
}) as never;

function makeAdapter(
  emit: (sessionId: string, event: ServerEvent) => void,
  permissionMode?: "bypassPermissions" | "manual" | "inherit",
  extra?: Partial<ClaudeAdapterOptions>,
): ClaudeAdapter {
  return new ClaudeAdapter({
    projectsDir,
    historyFile: join(root, "history.jsonl"),
    emit,
    spawnFn,
    claudeBin: "claude",
    permissionMode,
    ...extra,
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  projectsDir = join(root, "projects");
  const projDir = join(projectsDir, "-Users-me-Workspace-demo");
  await mkdir(projDir, { recursive: true });
  await writeFile(join(projDir, `${SID}.jsonl`), transcriptLines.join("\n") + "\n", "utf8");
  const old = new Date("2026-09-29T09:17:38.821Z");
  await utimes(join(projDir, `${SID}.jsonl`), old, old);
});

beforeEach(() => {
  children.length = 0;
  spawnCalls.length = 0;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("claude adapter: prompt → spawn 安全参数 + 事件广播", () => {
  it("并发恢复同一空闲会话只启动一个进程，另一条明确返回 busy", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const results = await Promise.all([adapter.prompt(SID, "手机一", undefined), adapter.prompt(SID, "手机二", undefined)]);
      assert.equal(spawnCalls.length, 1);
      assert.equal(results.filter((result) => result.accepted).length, 1);
      assert.equal(results.filter((result) => result.busy).length, 1);
    } finally {
      adapter.disposeAll();
    }
  });

  it("异步准备期间中止，准备完成后不会偷偷启动进程", async () => {
    const adapter = makeAdapter(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const find = adapter.findSession.bind(adapter);
    adapter.findSession = async (id) => { await gate; return find(id); };
    try {
      const pending = adapter.prompt(SID, "准备过程中被取消", undefined);
      await adapter.abort(SID);
      release();
      await assert.rejects(pending, /启动已取消/);
      assert.equal(spawnCalls.length, 0);
    } finally {
      release();
      adapter.disposeAll();
    }
  });

  it("进程最后一行没有换行时，错误结果仍会送达客户端", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, event) => events.push(event));
    try {
      await adapter.prompt(SID, "检查最后一行", undefined);
      children[0].stdout.emit("data", JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "最后一行报错" }));
      children[0].emit("close", 0);
      assert.ok(events.some((event) => event.type === "error" && event.message === "最后一行报错"));
      assert.equal(adapter.getStatus(SID), "error");
    } finally {
      adapter.disposeAll();
    }
  });

  it("中止后到达的旧进程缓冲输出不会复活运行态或追加回复", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, event) => events.push(event));
    try {
      await adapter.prompt(SID, "中止测试", undefined);
      await adapter.abort(SID);
      const count = events.length;
      children[0].stdout.emit("data", JSON.stringify({ type: "system", subtype: "init" }) + "\n" + JSON.stringify({ type: "assistant", message: { id: "cancelled", content: [{ type: "text", text: "取消后的旧回复" }] } }) + "\n");
      children[0].emit("close", 0);
      assert.equal(events.length, count);
      assert.equal(adapter.getStatus(SID), "idle");
    } finally {
      adapter.disposeAll();
    }
  });

  it("恢复旧会话及排队续发图片时，用户回显保留图片数据", async () => {
    const events: ServerEvent[] = [];
    const adapter = makeAdapter((_sid, event) => events.push(event));
    const images = [{ path: ".agent-hub-uploads/screenshot.jpg", mimeType: "image/jpeg", data: "aW1hZ2U=" }];
    try {
      await adapter.prompt(SID, "@.agent-hub-uploads/screenshot.jpg 检查截图", undefined, images);
      await adapter.prompt(SID, "接着看图", "followUp", images);
      const users = () => events.filter((event): event is Extract<ServerEvent, { type: "message_end" }> => event.type === "message_end" && event.message.role === "user");
      assert.equal(users().length, 1);
      assert.deepEqual(users()[0].message.images, [{ url: "data:image/jpeg;base64,aW1hZ2U=", alt: images[0].path }]);
      assert.ok(spawnCalls[0].args.includes(SID), "复用原会话 ID");
      children[0].emit("close", 0);
      assert.equal(users().length, 2);
      assert.deepEqual(users()[1].message.images, users()[0].message.images);
      assert.ok(users()[1].message.text.includes(images[0].path));
    } finally {
      adapter.disposeAll();
    }
  });

  it("spawn 参数为安全集（默认 --permission-mode bypassPermissions 最高权限，无危险 flag）", async () => {
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
        "bypassPermissions",
      ]);
      // 危险 flag 红线（与权限档位无关）：不得出现任何危险 flag；档位只走官方 --permission-mode 通道
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

  it("permissionMode=manual 显式下发 --permission-mode manual", async () => {
    const adapter = makeAdapter(() => undefined, "manual");
    try {
      await adapter.prompt(SID, "继续", undefined);
      const { args } = spawnCalls[0];
      const i = args.indexOf("--permission-mode");
      assert.ok(i > 0);
      assert.equal(args[i + 1], "manual");
      assert.ok(!args.includes("--dangerously-skip-permissions"));
    } finally {
      adapter.disposeAll();
    }
  });

  it("permissionMode=inherit 不下发 --permission-mode（沿用用户 settings）", async () => {
    const adapter = makeAdapter(() => undefined, "inherit");
    try {
      await adapter.prompt(SID, "继续", undefined);
      const { args } = spawnCalls[0];
      assert.ok(!args.includes("--permission-mode"));
      assert.ok(!args.includes("--dangerously-skip-permissions"));
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

describe("claude adapter: createSession 空白 transcript + forkSession 复制会话", () => {
  it("createSession 落盘带 isMeta 占位行的空白会话（消息数 0）+ ai-title 名称", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const created = await adapter.createSession(root, "我的 claude 会话");
      assert.equal(created.source, "claude");
      assert.equal(created.cwd, root);
      assert.equal(created.name, "我的 claude 会话");
      assert.equal(created.messageCount, 0);
      assert.ok(created.sessionFile && created.sessionFile.endsWith(`${created.id}.jsonl`));
      // 文件真实存在且只有占位行（isMeta）+ ai-title 行，解析后消息数 0
      const raw = await readFile(created.sessionFile!, "utf8");
      const rows = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].isMeta, true);
      assert.equal(rows[0].sessionId, created.id);
      assert.equal(rows[1].type, "ai-title");
      // 扫描口径：消息数 0、名称/cwd 正确、可被 findSession 命中
      const found = await adapter.findSession(created.id);
      assert.ok(found);
      assert.equal(found.messageCount, 0);
      assert.equal(found.name, "我的 claude 会话");
      // 状态推断回归：新建会话（文件 mtime=now）不得被误判 running（显式 idle 优先）
      assert.equal(found.status, "idle");
    } finally {
      adapter.disposeAll();
    }
  });

  it("createSession cwd 不存在 → INVALID_CWD，不落盘", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      await assert.rejects(
        () => adapter.createSession("/no/such/dir-xyz", "x"),
        (err: unknown) => (err as { code?: string }).code === "INVALID_CWD",
      );
    } finally {
      adapter.disposeAll();
    }
  });

  it("forkSession 复制为新 id：消息数相同、sessionId 已替换、原文件字节不变", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const before = await readFile(join(projectsDir, "-Users-me-Workspace-demo", `${SID}.jsonl`), "utf8");
      const forked = await adapter.forkSession(SID);
      assert.notEqual(forked.id, SID);
      assert.equal(forked.source, "claude");
      assert.equal(forked.cwd, CWD);
      // 消息历史完整继承（与原会话同数）
      const original = await adapter.findSession(SID);
      assert.ok(original);
      assert.equal(forked.messageCount, original.messageCount);
      assert.equal(forked.lastUserMessage, original.lastUserMessage);
      assert.equal(forked.lastAssistantMessage, original.lastAssistantMessage);
      // 新文件每行 sessionId 都是新 id；uuid/parentUuid 消息链原样保留
      const raw = await readFile(forked.sessionFile!, "utf8");
      const rows = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(rows.length > 0);
      for (const row of rows) assert.equal(row.sessionId, forked.id);
      const origRows = before.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.deepEqual(
        rows.map((r) => r.uuid),
        origRows.map((r) => r.uuid),
      );
      // 原会话文件字节不变（只读硬约束）
      const after = await readFile(join(projectsDir, "-Users-me-Workspace-demo", `${SID}.jsonl`), "utf8");
      assert.equal(after, before);
    } finally {
      adapter.disposeAll();
    }
  });

  it("forkSession 新会话（文件 mtime=now）显式登记 idle，不被时间推断误判 running", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const created = await adapter.createSession(root, "待 fork 空会话");
      const forked = await adapter.forkSession(created.id);
      // 状态推断回归：fork 新文件 mtime=now，不登记 idle 会被 60s 时间窗口误判 running
      assert.equal(forked.status, "idle");
      const found = await adapter.findSession(forked.id);
      assert.ok(found);
      assert.equal(found.status, "idle");
    } finally {
      adapter.disposeAll();
    }
  });

  it("forkSession 会话不存在 → SESSION_NOT_FOUND", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      await assert.rejects(
        () => adapter.forkSession("11111111-2222-3333-4444-555555555555"),
        (err: unknown) => (err as { code?: string }).code === "SESSION_NOT_FOUND",
      );
    } finally {
      adapter.disposeAll();
    }
  });
});

describe("claude adapter: renameSession 追加 ai-title 行（mtime 陷阱回归）", () => {
  it("改名追加 ai-title 行（append-only）：name 立即更新（invalidateList）", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const created = await adapter.createSession(root, "旧名字");
      const renamed = await adapter.renameSession(created.id, "新名字");
      assert.equal(renamed.name, "新名字");
      // invalidateList：findSession 立即读到新名，不等 TTL
      assert.equal((await adapter.findSession(created.id))?.name, "新名字");
      // 旧行保留（append-only），最新一条 ai-title 胜出
      const raw = await readFile(created.sessionFile!, "utf8");
      const rows = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(rows.length, 3);
      assert.equal(rows[1].type, "ai-title");
      assert.equal(rows[1].aiTitle, "旧名字");
      assert.equal(rows[2].type, "ai-title");
      assert.equal(rows[2].aiTitle, "新名字");
    } finally {
      adapter.disposeAll();
    }
  });

  it("空串清空名字（显式空 aiTitle 行 → name null）", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const created = await adapter.createSession(root, "要被清掉的名字");
      const renamed = await adapter.renameSession(created.id, "");
      assert.equal(renamed.name, null);
      assert.equal((await adapter.findSession(created.id))?.name, null);
    } finally {
      adapter.disposeAll();
    }
  });

  it("改名会话不存在 → SESSION_NOT_FOUND", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      await assert.rejects(
        () => adapter.renameSession("11111111-2222-3333-4444-555555555555", "x"),
        (err: unknown) => (err as { code?: string }).code === "SESSION_NOT_FOUND",
      );
    } finally {
      adapter.disposeAll();
    }
  });

  it("mtime 陷阱回归：改名写盘刷新 mtime 后不被 60s 时间窗误判 running", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const created = await adapter.createSession(root, "待改名");
      const renamed = await adapter.renameSession(created.id, "改名后的会话");
      assert.equal(renamed.status, "idle", "改名后不得误判 running");
      const found = await adapter.findSession(created.id);
      assert.ok(found);
      assert.equal(found.status, "idle");
    } finally {
      adapter.disposeAll();
    }
  });

  it("mtime 陷阱回归：外部静默会话（无本进程记录、文件老）改名后仍 idle", async () => {
    const adapter = makeAdapter(() => undefined);
    const id = "22222222-3333-4444-5555-666666666666";
    const projDir = join(projectsDir, "-Users-me-Workspace-demo");
    const file = join(projDir, `${id}.jsonl`);
    try {
      const oldIso = new Date(Date.now() - 70_000).toISOString();
      await writeFile(
        file,
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
          uuid: "u-rename-1",
          parentUuid: null,
          sessionId: id,
          timestamp: oldIso,
          cwd: CWD,
        }) + "\n",
        "utf8",
      );
      const old = new Date(Date.now() - 70_000);
      await utimes(file, old, old); // mtime 同步拨老：改名前推断必须是 idle
      const renamed = await adapter.renameSession(id, "外部会话改名");
      assert.equal(renamed.name, "外部会话改名");
      assert.equal(renamed.status, "idle", "改名前推断 idle，写盘刷新 mtime 后不得翻成 running");
    } finally {
      adapter.disposeAll();
      await rm(file, { force: true });
    }
  });
});

describe("claude adapter: 会话清单 TTL 缓存（AC1 基准）", () => {
  it("list/find 共享一次全量扫描（TTL + inflight 去重），写路径立即失效", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      const base = adapter.scanCount;
      // 并发 list + find：inflight 去重，只全量扫描一次（GET /api/sessions/:id 一次请求内两次查找同理）
      const [list, found] = await Promise.all([adapter.listSessions(), adapter.findSession(SID)]);
      assert.equal(adapter.scanCount - base, 1, "并发请求共享一次全量解析");
      assert.ok(list.some((s) => s.id === SID));
      assert.ok(found);
      assert.equal(found.status, "idle");
      // TTL 内重复查询零新增扫描（findSession 走缓存 filter）
      await adapter.findSession(SID);
      await adapter.findSession(SID);
      const again = await adapter.listSessions();
      assert.equal(again, list, "TTL 内复用同一次扫描结果");
      assert.equal(adapter.scanCount - base, 1, "TTL 内零新增扫描");
      // 写路径失效缓存：新建会话立即可见（不等 TTL）
      const created = await adapter.createSession(root, "缓存可见性");
      const hit = await adapter.findSession(created.id);
      assert.ok(hit, "写路径 invalidate：立即可见");
      assert.equal(hit.name, "缓存可见性");
    } finally {
      adapter.disposeAll();
    }
  });
});

describe("claude adapter: statuses TTL 清扫（外部 `claude --resume` 写盘状态自愈）", () => {
  it("显式 idle 登记超过 STATE_TTL 后被清扫，外部写 transcript 后状态随 mtime 自愈为 running", async () => {
    const adapter = makeAdapter(() => undefined);
    const id = "55555555-6666-7777-8888-999999999999";
    const projDir = join(projectsDir, "-Users-me-Workspace-demo");
    const file = join(projDir, `${id}.jsonl`);
    try {
      const oldIso = new Date(Date.now() - 70_000).toISOString();
      await writeFile(
        file,
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
          uuid: "u-ttl-1",
          parentUuid: null,
          sessionId: id,
          timestamp: oldIso,
          cwd: CWD,
        }) + "\n",
        "utf8",
      );
      const old = new Date(Date.now() - 70_000);
      await utimes(file, old, old);
      // server 侧改名登记 idle（mtime 陷阱防护）
      const renamed = await adapter.renameSession(id, "TTL 自愈");
      assert.equal(renamed.status, "idle");
      // 外部 `claude --resume` 持续写 transcript（mtime 刷新）：own 登记压制期间仍是 idle（bug 现场）
      await appendFile(
        file,
        JSON.stringify({
          type: "assistant",
          message: { id: "msg_ttl", role: "assistant", content: [{ type: "text", text: "外部 CLI 的持续输出" }] },
          uuid: "a-ttl-1",
          timestamp: new Date().toISOString(),
          cwd: CWD,
          sessionId: id,
        }) + "\n",
        "utf8",
      );
      assert.equal((await adapter.findSession(id))?.status, "idle", "未过期的 own 登记压制时间推断（bug 现场）");
      // TTL 清扫后无 own 记录：按文件 mtime 新鲜推断 running——状态自愈
      adapter.sweep(Date.now() + ClaudeAdapter.STATE_TTL_MS + 1_000);
      assert.equal((await adapter.findSession(id))?.status, "running", "TTL 过期清扫后状态随外部写盘自愈为 running");
      // 未过期条目不被清扫（刚登记的 idle 保留）
      const created = await adapter.createSession(root, "未过期");
      adapter.sweep(Date.now() + 1_000);
      assert.equal((await adapter.findSession(created.id))?.status, "idle", "TTL 内的登记不被清扫");
    } finally {
      adapter.disposeAll();
      await rm(file, { force: true });
    }
  });
});

describe("claude adapter: rename 状态快照实时 mtime（listCache 陈旧竞态回归）", () => {
  it("快照用实时 mtime 现算：陈旧 listCache 不得把真实 running 错误快照成 idle", async () => {
    const adapter = makeAdapter(() => undefined);
    const id = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const projDir = join(projectsDir, "-Users-me-Workspace-demo");
    const file = join(projDir, `${id}.jsonl`);
    try {
      const oldIso = new Date(Date.now() - 70_000).toISOString();
      await writeFile(
        file,
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
          uuid: "u-race-1",
          parentUuid: null,
          sessionId: id,
          timestamp: oldIso,
          cwd: CWD,
        }) + "\n",
        "utf8",
      );
      const old = new Date(Date.now() - 70_000);
      await utimes(file, old, old);
      const cached = await adapter.findSession(id); // 建立 listCache（此刻文件老）
      assert.equal(cached?.status, "idle");
      // 外部 `claude --resume` 写盘（真实 running），listCache 未失效（≤5s 陈旧窗口竞态）
      await appendFile(
        file,
        JSON.stringify({
          type: "assistant",
          message: { id: "msg_race", role: "assistant", content: [{ type: "text", text: "外部输出" }] },
          uuid: "a-race-1",
          timestamp: new Date().toISOString(),
          cwd: CWD,
          sessionId: id,
        }) + "\n",
        "utf8",
      );
      const renamed = await adapter.renameSession(id, "竞态改名");
      assert.equal(renamed.status, "running", "快照必须基于写盘前实时 mtime：不得用陈旧缓存压制真实 running");
    } finally {
      adapter.disposeAll();
      await rm(file, { force: true });
    }
  });
});

describe("claude adapter: forkSession 尾部残行丢弃（读到半行不带进新文件）", () => {
  it("尾部写到一半的残行被丢弃，新文件每行都是完整 JSON", async () => {
    const adapter = makeAdapter(() => undefined);
    const id = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const projDir = join(projectsDir, "-Users-me-Workspace-demo");
    const file = join(projDir, `${id}.jsonl`);
    let forkedFile = "";
    try {
      const good = JSON.stringify({
        type: "user",
        message: { role: "user", content: "完整行" },
        uuid: "u-half-1",
        parentUuid: null,
        sessionId: id,
        timestamp: new Date().toISOString(),
        cwd: CWD,
      });
      // 尾部残行（外部写到一半）：旧实现「损坏行原样保留」会把半行带进 fork 文件
      await writeFile(file, `${good}\n{"type":"assistant","message":{"role":"assi`, "utf8");
      const forked = await adapter.forkSession(id);
      forkedFile = forked.sessionFile!;
      const raw = await readFile(forkedFile, "utf8");
      const rows = raw.trim().split("\n");
      assert.equal(rows.length, 1, "尾部残行被丢弃，只保留完整行");
      for (const row of rows) {
        assert.doesNotThrow(() => JSON.parse(row), `新文件每行都必须是完整 JSON: ${row.slice(0, 40)}`);
      }
      assert.equal((JSON.parse(rows[0]) as { sessionId: string }).sessionId, forked.id, "完整行 sessionId 已替换");
    } finally {
      adapter.disposeAll();
      await rm(file, { force: true });
      if (forkedFile !== "") await rm(forkedFile, { force: true });
    }
  });
});

describe("claude adapter: D8 防双写（busy 判定加固）", () => {
  it("外部终端忙时不能谎报排队成功，也不创建永远无人消费的队列", async () => {
    const id = "d8e00000-0000-4000-8000-000000000002";
    const file = join(projectsDir, "-Users-me-Workspace-demo", `${id}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "user", message: { content: "外部任务" }, uuid: "external-u", sessionId: id, cwd: CWD, timestamp: new Date().toISOString() }) + "\n");
    const adapter = makeAdapter(() => undefined);
    try {
      for (const mode of ["followUp", "steer"]) {
        await assert.rejects(adapter.prompt(id, "排队消息", mode), (error: unknown) =>
          (error as { code: string }).code === "SESSION_BUSY" && /无法.*排队/.test((error as Error).message));
      }
      assert.equal(spawnCalls.length, 0);
    } finally {
      adapter.disposeAll();
      await rm(file, { force: true });
    }
  });

  it("本轮结束后外部终端重新写盘，旧 idle 与列表缓存都不能放行双写", async () => {
    const adapter = makeAdapter(() => undefined);
    const file = join(projectsDir, "-Users-me-Workspace-demo", `${SID}.jsonl`);
    try {
      await adapter.prompt(SID, "本地本轮", undefined);
      children[0].emit("close", 0);
      await adapter.findSession(SID);
      const next = new Date(Date.now() + 100);
      await appendFile(file, JSON.stringify({ type: "user", message: { content: "电脑端继续" }, uuid: "external-new", sessionId: SID, cwd: CWD, timestamp: next.toISOString() }) + "\n");
      await utimes(file, next, next);
      const result = await adapter.prompt(SID, "手机并发", undefined);
      assert.equal(result.busy, true);
      assert.equal(spawnCalls.length, 1);
    } finally {
      adapter.disposeAll();
      await writeFile(file, transcriptLines.join("\n") + "\n");
      const old = new Date("2026-09-29T09:17:38.821Z");
      await utimes(file, old, old);
    }
  });

  it("接管期间 API 状态随实际 turn 变化，不依据刚写过的文件猜测", async () => {
    let status: "running" | "idle" | "error" = "idle";
    const adapter = new ClaudeAdapter({ projectsDir, historyFile: join(root, "history.jsonl"), emit: () => undefined, spawnFn, driverStatus: () => status });
    try {
      for (const next of ["running", "idle", "error"] as const) {
        status = next;
        assert.equal(adapter.getStatus(SID), next);
        assert.equal((await adapter.findSession(SID))?.status, next);
      }
    } finally {
      adapter.disposeAll();
    }
  });

  it("driverBusy（hub 驱动接管中）→ prompt 回 busy，不 spawn", async () => {
    const adapter = new ClaudeAdapter({
      projectsDir,
      historyFile: join(root, "history.jsonl"),
      emit: () => undefined,
      spawnFn,
      claudeBin: "claude",
      driverBusy: () => true,
    });
    try {
      const result = await adapter.prompt(SID, "双写?", undefined);
      assert.equal(result.busy, true);
      assert.equal(spawnCalls.length, 0);
    } finally {
      adapter.disposeAll();
    }
  });

  it("外部活动新鲜（updatedAt 新鲜 = 终端 TUI 正在写）→ prompt 回 busy，不 spawn", async () => {
    const sid = "d8e00000-0000-4000-8000-000000000001";
    const fresh = new Date().toISOString();
    const projDir = join(projectsDir, "-Users-me-Workspace-demo");
    await writeFile(
      join(projDir, `${sid}.jsonl`),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "外部会话正在跑" },
        uuid: "u1",
        timestamp: fresh,
        cwd: CWD,
        sessionId: sid,
      }) + "\n",
      "utf8",
    );
    const adapter = makeAdapter(() => undefined);
    try {
      const result = await adapter.prompt(sid, "双写?", undefined);
      assert.equal(result.busy, true);
      assert.equal(spawnCalls.length, 0);
    } finally {
      adapter.disposeAll();
      await rm(join(projDir, `${sid}.jsonl`), { force: true });
    }
  });

  it("外部静默（updatedAt 陈旧）→ 正常发送；own settled idle 不误伤", async () => {
    // SID fixture 内容时间为 2026-09-29（陈旧）：应照常 spawn
    const adapter = makeAdapter(() => undefined);
    try {
      const result = await adapter.prompt(SID, "继续", undefined);
      assert.equal(result.accepted, true);
      assert.equal(spawnCalls.length, 1);
    } finally {
      adapter.disposeAll();
    }
  });
});

describe("claude adapter: parallel 审批通道（非 bypass 档位挂 MCP bridge，手机批/拒）", () => {
  const fakeRegistry = (): {
    cancelled: Array<{ sessionId: string; message: string; outcome?: string }>;
    hostRequests: { cancelSession: (sessionId: string, message: string, outcome?: string) => void };
  } => {
    const cancelled: Array<{ sessionId: string; message: string; outcome?: string }> = [];
    return {
      cancelled,
      hostRequests: {
        cancelSession: (sessionId: string, message: string, outcome?: string) => {
          cancelled.push({ sessionId, message, outcome });
        },
      },
    };
  };

  it("manual 档位：挂 permission-prompt-tool bridge + 回连 env（与接管路径同一审批通道）", async () => {
    const { hostRequests } = fakeRegistry();
    const adapter = makeAdapter(() => undefined, "manual", {
      hostRequests,
      bridgeScriptPath: "/x/bridge.mjs",
      liveUrl: "http://127.0.0.1:7700",
      liveToken: "tok",
    });
    try {
      await adapter.prompt(SID, "需要确认的任务", undefined);
      const { args, opts } = spawnCalls[0];
      assert.ok(args.includes("--permission-prompts"), "挂权限应答通道");
      assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], PERM_TOOL_FULL_NAME);
      const mcpConfig = args[args.indexOf("--mcp-config") + 1];
      assert.ok(mcpConfig.includes("bridge.mjs"), "mcp-config 指向 bridge 脚本");
      assert.equal(opts.env?.[ENV_SESSION_ID], SID, "bridge 回连需会话 id");
      assert.equal(opts.env?.[ENV_LIVE_URL], "http://127.0.0.1:7700");
      assert.equal(opts.env?.[ENV_LIVE_TOKEN], "tok");
    } finally {
      adapter.disposeAll();
    }
  });

  it("默认 bypassPermissions：不挂 bridge（最高权限全自动、无人审批）", async () => {
    const adapter = makeAdapter(() => undefined, "bypassPermissions", {
      hostRequests: fakeRegistry().hostRequests,
      bridgeScriptPath: "/x/bridge.mjs",
    });
    try {
      await adapter.prompt(SID, "全自动任务", undefined);
      const { args, opts } = spawnCalls[0];
      assert.ok(!args.includes("--permission-prompt-tool"), "bypass 不挂 bridge");
      assert.ok(!args.includes("--mcp-config"));
      assert.equal(opts.env?.[ENV_SESSION_ID], undefined);
    } finally {
      adapter.disposeAll();
    }
  });

  it("inherit：保守挂 bridge（沿用 settings 的 bypass 用户不产生请求，空转无害）且不下发 flag", async () => {
    const adapter = makeAdapter(() => undefined, "inherit", {
      hostRequests: fakeRegistry().hostRequests,
      bridgeScriptPath: "/x/bridge.mjs",
    });
    try {
      await adapter.prompt(SID, "沿用 settings", undefined);
      const { args } = spawnCalls[0];
      assert.ok(!args.includes("--permission-mode"), "inherit 不下发档位 flag");
      assert.ok(args.includes("--permission-prompt-tool"), "非显式 bypass 一律挂 bridge 兜底");
    } finally {
      adapter.disposeAll();
    }
  });

  it("run 结束：挂起权限请求 cancelSession deny 收尾（手机卡片同步消失，不等 TTL）", async () => {
    const { cancelled, hostRequests } = fakeRegistry();
    const adapter = makeAdapter(() => undefined, "manual", {
      hostRequests,
      bridgeScriptPath: "/x/bridge.mjs",
    });
    try {
      await adapter.prompt(SID, "任务", undefined);
      assert.equal(cancelled.length, 0, "run 中不收尾");
      children[0].emit("close", 0, null);
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].sessionId, SID);
    } finally {
      adapter.disposeAll();
    }
  });

  it("abort：立即 cancelSession，不等进程退出", async () => {
    const { cancelled, hostRequests } = fakeRegistry();
    const adapter = makeAdapter(() => undefined, "manual", {
      hostRequests,
      bridgeScriptPath: "/x/bridge.mjs",
    });
    try {
      await adapter.prompt(SID, "任务", undefined);
      await adapter.abort(SID);
      assert.equal(cancelled.length, 1, "abort 立即收尾挂起审批");
      assert.equal(cancelled[0].sessionId, SID);
    } finally {
      adapter.disposeAll();
    }
  });

  it("hasActiveRun：run 中 true，结束后 false（driver 权限守卫据此放行 parallel 审批）", async () => {
    const adapter = makeAdapter(() => undefined);
    try {
      assert.equal(adapter.hasActiveRun(SID), false);
      await adapter.prompt(SID, "任务", undefined);
      assert.equal(adapter.hasActiveRun(SID), true);
      children[0].emit("close", 0, null);
      assert.equal(adapter.hasActiveRun(SID), false);
    } finally {
      adapter.disposeAll();
    }
  });
});
