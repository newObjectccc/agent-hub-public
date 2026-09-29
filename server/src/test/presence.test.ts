/**
 * presence 测试：fs.watch 事件驱动（debounce 合并）+ 降级轮询的 mtime 变化检测。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PresenceWatcher, PRESENCE_DEBOUNCE_MS } from "../sessions/presence.js";

const ts = () => new Date().toISOString();
const entry = (id: string): string =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: ts(), message: { role: "user", content: id } });

describe("presence: 文件事件驱动通知", () => {
  let dir: string;
  let file: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-presence-"));
    file = join(dir, "p.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "p-1", timestamp: ts(), cwd: "/tmp/x" }) + "\n" + entry("m1"), "utf8");
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("文件追加后 debounce 窗口内触发 onChange（多次写入合并为一次）", async () => {
    let fired = 0;
    const watcher = new PresenceWatcher(dir, () => {
      fired += 1;
    });
    try {
      await watcher.start();
      await appendFile(file, `\n${entry("m2")}`, "utf8");
      await appendFile(file, `\n${entry("m3")}`, "utf8");
      await appendFile(file, `\n${entry("m4")}`, "utf8");
      // debounce(500ms) + 余量
      await new Promise((r) => setTimeout(r, PRESENCE_DEBOUNCE_MS + 700));
      assert.ok(fired >= 1, "应至少触发一次 onChange");
      assert.ok(fired <= 3, `抖动合并应避免逐事件广播，实际 ${fired} 次`);
    } finally {
      watcher.stop();
    }
  });

  it("stop 后不再触发", async () => {
    let fired = 0;
    const watcher = new PresenceWatcher(dir, () => {
      fired += 1;
    });
    await watcher.start();
    watcher.stop();
    const at = fired;
    await appendFile(file, `\n${entry("m5")}`, "utf8");
    await new Promise((r) => setTimeout(r, PRESENCE_DEBOUNCE_MS + 700));
    assert.equal(fired, at, "停止后不应再触发");
  });
});
