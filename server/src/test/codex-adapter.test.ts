/**
 * CodexAdapter 资源治理回归（OOM 审计 P2-4）：
 * - statuses 无 TTL → 镜像 hub.ts/claude.ts STATE_TTL 30min sweep：
 *   TTL 内显式状态优先（新建 idle 不被时间推断误判 running）；过期即清，状态随文件 mtime 自愈。
 * - fileCache 无淘汰 → LruMap 限容：get 刷新位次、set 逐出最久未用，扫描数百文件不无上界驻留。
 *
 * createSession 版本 meta 链（P0：codex 0.162 读不懂缺 cli_version/model_provider 的
 * 合成 session_meta，两条 resume 路都 -32603）：
 * - 探测成功 → 写入探测版本；TTL 内复用缓存不重复 spawn
 * - 探测失败但采样到 → 写入采样版本/provider
 * - 两者都失败 → 抛 HubError 且**不落盘残缺文件**（不污染会话列表）
 * 测试一律伪造 spawn，绝不真跑 codex 二进制。
 */
import { strict as assert } from "node:assert";
import type { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { CodexAdapter, FILE_CACHE_MAX, LruMap } from "../adapters/codex.js";
import { ErrorCodes, HubError } from "../errors.js";

const CWD = "/Users/me/Workspace/demo";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean { return true; }
}

/**
 * 伪造 spawnFn：只应答 `--version` 探测（mode=ok 回版本号并退出 0；mode=fail 退出 1）。
 * 其它 args 返回永不发声的子进程（本文件的用例不跑 prompt 流程）。
 */
function fakeVersionSpawn(mode: "ok" | "fail", version = "0.162.0"): { spawnFn: typeof spawn; probeCalls: () => number } {
  let probes = 0;
  const spawnFn = ((_bin: string, args: string[]) => {
    const child = new FakeChild();
    if (args[0] === "--version") {
      probes += 1;
      setImmediate(() => {
        if (mode === "ok") {
          child.stdout.write(`codex-cli ${version}\n`);
          child.emit("close", 0);
        } else {
          child.emit("close", 1);
        }
      });
    }
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { spawnFn, probeCalls: () => probes };
}

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
    const fake = fakeVersionSpawn("ok");
    const adapter = new CodexAdapter({
      sessionsDir,
      sessionIndexFile,
      emit: () => undefined,
      fileCacheMax: 2,
      spawnFn: fake.spawnFn,
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
      spawnFn: fakeVersionSpawn("ok").spawnFn,
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

describe("createSession 版本 meta 链（P0：codex 0.162 必需 cli_version/model_provider，缺失两条 resume 路都 -32603）", () => {
  const tmpDirs: string[] = [];
  after(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });
  async function workspace(): Promise<{ dir: string; sessionsDir: string; sessionIndexFile: string }> {
    const dir = await mkdtemp(join(tmpdir(), "agent-hub-codex-meta-"));
    tmpDirs.push(dir);
    return { dir, sessionsDir: join(dir, "sessions"), sessionIndexFile: join(dir, "session_index.jsonl") };
  }

  /** rollout 首行 session_meta 的 payload（断言落盘形状用） */
  async function firstLinePayload(file: string): Promise<Record<string, unknown>> {
    const first = (await readFile(file, "utf8")).split("\n")[0];
    const row = JSON.parse(first) as { type: string; ordinal: number; payload: Record<string, unknown> };
    assert.equal(row.type, "session_meta");
    assert.equal(row.ordinal, 0);
    return row.payload;
  }

  /** 递归收集目录下全部文件（ENOENT → 空）：断言「失败不落盘」用 */
  async function collectFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(join(dir, entry.name));
        else out.push(join(dir, entry.name));
      }
    };
    await walk(root);
    return out;
  }

  it("探测成功 → 写入探测到的版本/注入 provider；TTL 内复用缓存不重复 spawn --version", async () => {
    const { dir, sessionsDir, sessionIndexFile } = await workspace();
    const fake = fakeVersionSpawn("ok", "0.162.0-alpha.17.2");
    const adapter = new CodexAdapter({
      sessionsDir, sessionIndexFile, emit: () => undefined, spawnFn: fake.spawnFn, modelProvider: "azure",
    });
    try {
      const created = await adapter.createSession(dir);
      const payload = await firstLinePayload(created.sessionFile);
      assert.equal(payload.cli_version, "0.162.0-alpha.17.2", "写入探测到的真实版本，绝不写死假值");
      assert.equal(payload.model_provider, "azure");
      assert.equal(fake.probeCalls(), 1);
      // hub 自己的列表层立刻认得这个新会话
      assert.equal((await adapter.findSession(created.id))?.id, created.id);

      const second = await adapter.createSession(dir);
      assert.equal((await firstLinePayload(second.sessionFile)).cli_version, "0.162.0-alpha.17.2");
      assert.equal(fake.probeCalls(), 1, "第二次新建走 TTL 缓存，不再 spawn");
    } finally {
      adapter.disposeAll();
    }
  });

  it("探测失败 → 采样已有会话首行回落：写入采样版本与 provider", async () => {
    const { dir, sessionsDir, sessionIndexFile } = await workspace();
    // 已有会话（日期树布局）：带 cli_version + model_provider 的真实产物形态首行
    await mkdir(join(sessionsDir, "2026", "10", "08"), { recursive: true });
    const existingSid = uuid(9);
    await writeFile(
      join(sessionsDir, "2026", "10", "08", `rollout-2026-10-08T10-00-00-${existingSid}.jsonl`),
      rolloutContent(existingSid, "2026-10-08T10:00:00.000Z")
        .replace('"cli_version":"0.143.0"', '"cli_version":"0.159.0-alpha.3","model_provider":"azure"'),
      "utf8",
    );
    const fake = fakeVersionSpawn("fail");
    const adapter = new CodexAdapter({ sessionsDir, sessionIndexFile, emit: () => undefined, spawnFn: fake.spawnFn });
    try {
      const created = await adapter.createSession(dir);
      const payload = await firstLinePayload(created.sessionFile);
      assert.equal(payload.cli_version, "0.159.0-alpha.3", "探测失败 → 采样回落");
      assert.equal(payload.model_provider, "azure", "provider 来自同一趟采样（不读 config.toml，守凭据口径）");
      assert.ok(fake.probeCalls() >= 1);
    } finally {
      adapter.disposeAll();
    }
  });

  it("探测与采样都失败 → 抛 HubError 且不落盘残缺文件；失败不缓存（瞬态故障不永久拒绝）", async () => {
    const { dir, sessionsDir, sessionIndexFile } = await workspace();
    const fake = fakeVersionSpawn("fail");
    const adapter = new CodexAdapter({ sessionsDir, sessionIndexFile, emit: () => undefined, spawnFn: fake.spawnFn });
    try {
      await assert.rejects(
        adapter.createSession(dir),
        (error: unknown) =>
          error instanceof HubError && error.code === ErrorCodes.INTERNAL && error.statusCode === 503 &&
          /无法探测 codex 版本/.test(error.message),
      );
      // 关键：不留任何 codex 读不懂的残缺 rollout（连日期目录都不建），会话列表不被污染
      assert.deepEqual(await collectFiles(sessionsDir), [], "失败必须发生在任何写盘之前");
      // 失败不缓存：第二次新建重新探测（仍然失败，但证明未被负缓存钉死）
      await assert.rejects(adapter.createSession(dir), (error: unknown) => error instanceof HubError);
      assert.equal(fake.probeCalls(), 2);
      assert.deepEqual(await collectFiles(sessionsDir), []);
    } finally {
      adapter.disposeAll();
    }
  });
});
