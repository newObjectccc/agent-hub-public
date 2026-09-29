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
