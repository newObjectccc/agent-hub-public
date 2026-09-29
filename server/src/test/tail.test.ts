/**
 * live tail 测试：非本进程会话的文件变化 → message_end 推送 + running/idle 状态推断。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ServerEvent } from "../types.js";
import { inferExternalStatus, SessionTailManager } from "../sessions/tail.js";

const ts = () => new Date().toISOString();

function entry(id: string, role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: ts(),
    message: { role, content: text },
  });
}

describe("tail: 文件追加 → message_end 推送 + 状态推断", () => {
  let dir: string;
  let file: string;
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-tail-"));
    file = join(dir, "sess.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "tail-1", timestamp: ts(), cwd: "/tmp/demo" }),
        entry("m1", "user", "hello"),
        entry("m2", "assistant", "world"),
      ].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquire 后文件追加的新消息被推送为 message_end，并推 running", async () => {
    const manager = new SessionTailManager((sessionId, event) => {
      events.push({ sessionId, event });
    });
    try {
      manager.acquire("tail-1", file);
      // 等初始快照完成
      await new Promise((r) => setTimeout(r, 300));

      await appendFile(file, `\n${entry("m3", "user", "new message")}`, "utf8");
      // 轮询间隔 2s + 余量
      await new Promise((r) => setTimeout(r, 2600));

      const ends = events.filter((e) => e.event.type === "message_end");
      assert.equal(ends.length, 1, `应推送 1 条 message_end，实际 ${ends.length}`);
      const msg = (ends[0].event as { message: { id: string; role: string } }).message;
      assert.equal(msg.id, "m3");
      assert.equal(msg.role, "user");

      const statuses = events.filter((e) => e.event.type === "status").map((e) => (e.event as { status: string }).status);
      assert.ok(statuses.includes("running"), `应推 running，实际 ${JSON.stringify(statuses)}`);
    } finally {
      manager.stopAll();
    }
  });

  it("release 后不再推送（ref 计数归零停止）", async () => {
    const before2 = events.length;
    const manager = new SessionTailManager((sessionId, event) => {
      events.push({ sessionId, event });
    });
    try {
      manager.acquire("tail-1", file);
      manager.acquire("tail-1", file);
      manager.release("tail-1");
      // 等初始快照完成再追加，否则新消息会被并入快照（测试时序，非实现问题）
      await new Promise((r) => setTimeout(r, 300));
      await appendFile(file, `\n${entry("m4", "assistant", "after release ref1")}`, "utf8");
      await new Promise((r) => setTimeout(r, 2600));
      // ref 还有 1，应仍推送
      assert.ok(events.length > before2, "ref>0 时应继续推送");

      manager.release("tail-1"); // 归零停止
      const at = events.length;
      await appendFile(file, `\n${entry("m5", "user", "after stop")}`, "utf8");
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(events.length, at, "停止后不应再推送");
    } finally {
      manager.stopAll();
    }
  });

  it("inferExternalStatus：60 秒内活动 = running（覆盖工具间思考间隙），否则 idle", () => {
    const now = Date.now();
    assert.equal(inferExternalStatus(now - 1000, now), "running");
    assert.equal(inferExternalStatus(now - 20_000, now), "running");
    assert.equal(inferExternalStatus(now - 70_000, now), "idle");
  });
});

describe("tail: detach 强制停（live 接管场景）", () => {
  it("detach 后不再推送，即使 ref 未归零", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail2-"));
    const file = join(dir, "s.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "tail-2", timestamp: ts(), cwd: "/tmp/x" }) + "\n" + entry("n1", "user", "hi"), "utf8");
    const got: ServerEvent[] = [];
    const manager = new SessionTailManager((_sid, ev) => got.push(ev));
    try {
      manager.acquire("tail-2", file);
      manager.acquire("tail-2", file); // ref=2
      await new Promise((r) => setTimeout(r, 300));
      manager.detach("tail-2"); // 模拟会话转 live
      const at = got.length;
      await appendFile(file, `\n${entry("n2", "assistant", "should not appear")}`, "utf8");
      await new Promise((r) => setTimeout(r, 2600));
      assert.equal(got.length, at, "detach 后不应再推送");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tail: 回复落盘后的短静默 → agent_settled（中止按钮及时消失）", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function setup(): Promise<{ dir: string; file: string; got: Array<{ sessionId: string; event: ServerEvent }>; manager: SessionTailManager }> {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-tail3-"));
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "tail-3", timestamp: ts(), cwd: "/tmp/demo" }),
        entry("u1", "user", "帮我修构建"),
      ].join("\n"),
      "utf8",
    );
    const got: Array<{ sessionId: string; event: ServerEvent }> = [];
    // 注入小轮询/短静默窗口（生产默认 2s 轮询 / 3s 回复静默 / 60s 活动窗口）
    const manager = new SessionTailManager((sessionId, event) => got.push({ sessionId, event }), {
      pollMs: 100,
      idleAfterReplyMs: 200,
      idleAfterMs: 60_000,
    });
    manager.acquire("tail-3", file);
    await sleep(250); // 初始快照
    return { dir, file, got, manager };
  }

  it("assistant 回复落盘 + 短静默 → agent_settled + status idle（不再等 60s）", async () => {
    const { dir, file, got, manager } = await setup();
    try {
      await appendFile(file, `\n${entry("a1", "assistant", "构建修好了")}`, "utf8");
      await sleep(900);
      const types = got.map((e) => e.event.type);
      assert.ok(types.includes("message_end"), `应推回复 message_end，实际 ${JSON.stringify(types)}`);
      assert.ok(types.includes("agent_settled"), `回复落盘短静默应推 agent_settled，实际 ${JSON.stringify(types)}`);
      // 顺序：agent_settled → status idle（与 SessionHub 一致）
      const settleAt = got.findIndex((e) => e.event.type === "agent_settled");
      const idleAt = got.findIndex((e) => e.event.type === "status" && (e.event as { status: string }).status === "idle");
      assert.ok(settleAt >= 0 && idleAt > settleAt, `顺序应为 settled→idle，实际 ${JSON.stringify(got.map((e) => e.event.type))}`);
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("user 消息落盘不走短静默（工具间思考仍用长窗口，不误判 idle）", async () => {
    const { dir, file, got, manager } = await setup();
    try {
      await appendFile(file, `\n${entry("u2", "user", "继续")}`, "utf8");
      await sleep(900);
      const types = got.map((e) => e.event.type);
      assert.ok(types.includes("message_end"));
      assert.ok(!types.includes("agent_settled"), `user 落盘不应触发短静默 settle，实际 ${JSON.stringify(types)}`);
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("回复落盘 settle 后新一轮落盘 → 重新 running 并可再次 settle（多段/多轮不卡死）", async () => {
    const { dir, file, got, manager } = await setup();
    try {
      await appendFile(file, `\n${entry("a1", "assistant", "第一轮完成")}`, "utf8");
      await sleep(700);
      assert.equal(got.filter((e) => e.event.type === "agent_settled").length, 1);

      await appendFile(file, `\n${entry("a2", "assistant", "第二轮完成")}`, "utf8");
      await sleep(900);
      const types = got.map((e) => e.event.type);
      const settled = types.filter((t) => t === "agent_settled").length;
      assert.equal(settled, 2, `两轮回复各自 settle，实际 ${JSON.stringify(types)}`);
      const lastRunning = types.lastIndexOf("status");
      assert.ok(lastRunning > types.indexOf("agent_settled"), "第二轮应重新推 running");
    } finally {
      manager.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
