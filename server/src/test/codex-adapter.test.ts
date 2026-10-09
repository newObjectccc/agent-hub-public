/**
 * CodexAdapter 资源治理回归（OOM 审计 P2-4）：
 * - statuses 无 TTL → 镜像 hub.ts/claude.ts STATE_TTL 30min sweep：
 *   TTL 内显式状态优先（新建 idle 不被时间推断误判 running）；过期即清，状态随文件 mtime 自愈。
 * - fileCache 无淘汰 → LruMap 限容：get 刷新位次、set 逐出最久未用，扫描数百文件不无上界驻留。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CodexAdapter, FILE_CACHE_MAX, LruMap } from "../adapters/codex.js";

const CWD = "/Users/me/Workspace/demo";

function uuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

function rolloutContent(sid: string, ts0: string): string {
  return [
    JSON.stringify({
      timestamp: ts0,
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: sid, id: sid, timestamp: ts0, cwd: CWD, originator: "codex-tui", cli_version: "0.143.0" },
    }),
    JSON.stringify({
      timestamp: ts0,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `hi ${sid}` }] },
    }),
  ].join("\n") + "\n";
}

describe("LruMap：fileCache 限容（P2-4）", () => {
  it("set 超上限逐出最久未用；get 命中刷新位次", () => {
    const m = new LruMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    assert.equal(m.size, 3);
    m.set("d", 4); // 逐出 a（最久未用）
    assert.deepEqual([...m.keys()], ["b", "c", "d"]);

    assert.equal(m.get("b"), 2); // 命中刷新位次 → b 最近用
    m.set("e", 5); // 逐出 c（此时最久未用）
    assert.deepEqual([...m.keys()], ["d", "b", "e"]);
    assert.equal(m.size, 3);
  });

  it("边界：覆盖已有 key 刷新位次不增尺寸；上限 1 只留最新", () => {
    const m = new LruMap<string, number>(1);
    m.set("a", 1);
    m.set("a", 2);
    assert.equal(m.size, 1);
    assert.equal(m.get("a"), 2);
    m.set("b", 3);
    assert.deepEqual([...m.keys()], ["b"]);
    assert.equal(m.get("a"), undefined, "被逐出的 key 读不到");
  });
});

describe("CodexAdapter：fileCache LRU + statuses TTL sweep（P2-4）", () => {
  let base: string;
  let sessionsDir: string;
  let sessionIndexFile: string;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-hub-codex-lru-"));
    sessionsDir = join(base, "sessions");
    sessionIndexFile = join(base, "session_index.jsonl");
    const dayDir = join(sessionsDir, "2026", "05", "27");
    await mkdir(dayDir, { recursive: true });
    // 5 个 rollout 会话文件（> fileCacheMax=2）
    for (let i = 0; i < 5; i += 1) {
      const ts0 = `2026-05-27T05:3${i}:12.687Z`;
      await writeFile(join(dayDir, `rollout-2026-05-27T05-3${i}-12-${uuid(i)}.jsonl`), rolloutContent(uuid(i), ts0), "utf8");
    }
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("fileCache 超上限即逐出（多轮全量扫描不无上界驻留）", async () => {
    const adapter = new CodexAdapter({
      sessionsDir,
      sessionIndexFile,
      emit: () => undefined,
      fileCacheMax: 2,
    });
    try {
      const items = await adapter.listSessions();
      assert.equal(items.length, 5);
      assert.ok(adapter.fileCacheSize > 0, "未变文件快照已入缓存");
      assert.ok(adapter.fileCacheSize <= 2, `fileCache 驻留 ${adapter.fileCacheSize} 超上限 2`);

      // 写路径 invalidate 后再全量扫描：仍受上限约束
      await adapter.createSession(base, "new");
      await adapter.listSessions();
      assert.ok(adapter.fileCacheSize <= 2, `二轮扫描后驻留 ${adapter.fileCacheSize} 超上限 2`);
    } finally {
      adapter.disposeAll();
    }
  });

  it("默认上限常量合理（生产口径 FILE_CACHE_MAX）", () => {
    assert.ok(FILE_CACHE_MAX > 0);
  });

  it("statuses TTL：TTL 内显式状态优先，过期即清回落时间推断（镜像 hub.ts STATE_TTL sweep）", async () => {
    const adapter = new CodexAdapter({
      sessionsDir,
      sessionIndexFile,
      emit: () => undefined,
    });
    try {
      const created = await adapter.createSession(base, "ttl-demo");
      // 新文件 mtime 新鲜：无显式登记会被时间推断误判 running；登记后为 idle
      assert.equal((await adapter.findSession(created.id))?.status, "idle", "显式 idle 压制时间推断");

      // TTL 内清扫：条目保留
      adapter.sweep(Date.now() + CodexAdapter.STATE_TTL_MS - 60_000);
      assert.equal((await adapter.findSession(created.id))?.status, "idle", "TTL 内保留显式状态");

      // 过期清扫：条目删除 → 回落 inferExternalStatus（文件 mtime 新鲜 → running）
      adapter.sweep(Date.now() + CodexAdapter.STATE_TTL_MS + 60_000);
      assert.equal((await adapter.findSession(created.id))?.status, "running", "过期即清，状态随文件 mtime 自愈");
    } finally {
      adapter.disposeAll();
    }
  });
});
