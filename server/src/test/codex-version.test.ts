/**
 * codex-version.ts 单测（P0：合成 session_meta 缺 cli_version/model_provider 时
 * codex 0.162 两条 resume 路都拒绝）：
 * - 版本正则/比较（输出噪音、预发行标签、不可识别输入）
 * - probeCodexCliVersion：成功 / 非零退出 / spawn error / 输出无法识别 / 挂起超时
 *   （一律伪造 spawn，绝不真跑 codex 二进制）
 * - sampleCodexRolloutMeta：日期树新→旧有界采样、最高版本、最新 provider、坏行跳过、
 *   归档平铺目录、maxFiles/首行字节预算
 * - resolveCodexNewSessionMeta 取值链：探测成功→探测版本；探测失败→采样回落；
 *   都失败→HubError（fail-fast，不落盘残缺文件由 codex-adapter.test.ts 验证）
 */
import { strict as assert } from "node:assert";
import type { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import {
  compareCodexVersions,
  normalizeCodexVersion,
  probeCodexCliVersion,
  resolveCodexNewSessionMeta,
  sampleCodexRolloutMeta,
} from "../adapters/codex-version.js";
import { ErrorCodes, HubError } from "../errors.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string): boolean { this.signals.push(signal); return true; }
}

type ProbeBehavior =
  | { kind: "ok"; output: string }
  | { kind: "exitNonZero"; output?: string; code?: number }
  | { kind: "spawnError" }
  | { kind: "hang" };

/** 伪造 spawnFn：按 behavior 回应 --version；记录调用参数供断言 */
function fakeSpawn(behavior: ProbeBehavior): { spawnFn: typeof spawn; calls: Array<{ bin: string; args: string[] }>; children: FakeChild[] } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnFn = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    setImmediate(() => {
      if (behavior.kind === "ok") {
        child.stdout.write(behavior.output);
        child.emit("close", 0);
      } else if (behavior.kind === "exitNonZero") {
        if (behavior.output !== undefined) child.stdout.write(behavior.output);
        child.emit("close", behavior.code ?? 1);
      } else if (behavior.kind === "spawnError") {
        child.emit("error", new Error("ENOENT"));
      }
      // hang：什么都不发，等 probeCodexCapabilities 内部 5s 超时
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { spawnFn, calls, children };
}

const SID = "019e67ea-c861-78a1-b429-119496dac86e";

/** 已有会话 rollout 首行（session_meta）fixture：字段照 codex 真实产物形态 */
function metaLine(over: { sid?: string; version?: string | null; provider?: string | null; cwd?: string } = {}): string {
  const payload: Record<string, unknown> = {
    session_id: over.sid ?? SID,
    id: over.sid ?? SID,
    timestamp: "2026-10-08T00:00:00.000Z",
    cwd: over.cwd ?? "/Users/me/Workspace/demo",
    originator: "codex-tui",
  };
  if (over.version !== null) payload.cli_version = over.version ?? "0.143.0";
  if (over.provider !== null) payload.model_provider = over.provider ?? "openai";
  return JSON.stringify({ timestamp: "2026-10-08T00:00:00.000Z", ordinal: 0, type: "session_meta", payload }) + "\n";
}

/** tmp 工作区（after 统一清理） */
const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-hub-codex-version-"));
  tmpDirs.push(dir);
  return dir;
}

/** 往 sessions/YYYY/MM/DD 写一个 rollout 文件 */
async function writeRollout(base: string, day: string, name: string, content: string): Promise<string> {
  const [y, m, d] = day.split("-");
  const dir = join(base, "sessions", y, m, d);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, content, "utf8");
  return file;
}

describe("normalizeCodexVersion / compareCodexVersions：版本正则与主干比较", () => {
  it("从噪音输出提取版本（含预发行/构建标签）；不可识别返回 null", () => {
    assert.equal(normalizeCodexVersion("codex-cli 0.162.0-alpha.17.2"), "0.162.0-alpha.17.2");
    assert.equal(normalizeCodexVersion("codex 0.143.0\n"), "0.143.0");
    assert.equal(normalizeCodexVersion("warning: junk before 1.2.3+build.9 after"), "1.2.3+build.9");
    // \b 在字母紧贴数字处（"v1.2.3"）无词边界 → 不匹配；与 probeCodexCapabilities 同口径，
    // 真实 codex --version 输出是 "codex-cli x.y.z"，无 v 前缀，不受影响
    assert.equal(normalizeCodexVersion("v1.2.3"), null);
    assert.equal(normalizeCodexVersion("no digits here"), null);
    assert.equal(normalizeCodexVersion("only 1.2"), null);
    assert.equal(normalizeCodexVersion(42), null);
    assert.equal(normalizeCodexVersion(undefined), null);
  });

  it("只比较数字主干：0.162 > 0.143；相等返回 0；预发行标签不改变主干序；坏输入 null", () => {
    assert.equal(compareCodexVersions("0.162.0", "0.143.0"), 1);
    assert.equal(compareCodexVersions("0.143.0", "0.162.0-alpha.17.2"), -1);
    assert.equal(compareCodexVersions("0.162.0-alpha.17.2", "0.162.0"), 0);
    assert.equal(compareCodexVersions("1.0.0", "0.999.999"), 1);
    assert.equal(compareCodexVersions("0.162.0", "junk"), null);
  });
});

describe("probeCodexCliVersion：伪造 spawn 的 --version 探测", () => {
  it("成功：只调 --version，输出带噪音也能提取版本", async () => {
    const fake = fakeSpawn({ kind: "ok", output: "npm warn blah\ncodex-cli 0.162.0-alpha.17.2\n" });
    const version = await probeCodexCliVersion({ codexBin: "/opt/codex", spawnFn: fake.spawnFn, env: {} });
    assert.equal(version, "0.162.0-alpha.17.2");
    assert.deepEqual(fake.calls, [{ bin: "/opt/codex", args: ["--version"] }]);
  });

  it("非零退出 → null（不抛，调用方回落采样）", async () => {
    const fake = fakeSpawn({ kind: "exitNonZero", output: "codex-cli 0.162.0", code: 3 });
    assert.equal(await probeCodexCliVersion({ codexBin: "codex", spawnFn: fake.spawnFn, env: {} }), null);
  });

  it("spawn error（二进制缺失）→ null", async () => {
    const fake = fakeSpawn({ kind: "spawnError" });
    assert.equal(await probeCodexCliVersion({ codexBin: "codex", spawnFn: fake.spawnFn, env: {} }), null);
  });

  it("退出码 0 但输出无法识别 → null", async () => {
    const fake = fakeSpawn({ kind: "ok", output: "no version info at all" });
    assert.equal(await probeCodexCliVersion({ codexBin: "codex", spawnFn: fake.spawnFn, env: {} }), null);
  });

  it("子进程挂起 → 5s 内部超时后 null 且 SIGKILL 收尾（本用例真实耗时约 5s）", async () => {
    const fake = fakeSpawn({ kind: "hang" });
    assert.equal(await probeCodexCliVersion({ codexBin: "codex", spawnFn: fake.spawnFn, env: {} }), null);
    assert.deepEqual(fake.children[0].signals, ["SIGKILL"], "超时必须杀掉挂起的子进程");
  });
});

describe("sampleCodexRolloutMeta：有界采样已有 rollout 首行", () => {
  it("目录不存在 → 全 null 且 sampledFiles=0（不抛）", async () => {
    const base = await workspace();
    const sample = await sampleCodexRolloutMeta(join(base, "missing"));
    assert.deepEqual(sample, { cliVersion: null, modelProvider: null, sampledFiles: 0 });
  });

  it("cli_version 取最高（哪怕在更旧日期目录）；model_provider 取最新一条非空值", async () => {
    const base = await workspace();
    // 旧日期文件反而带更高版本（升级后回滚场景）：版本取最高，provider 取最新
    await writeRollout(base, "2026-10-07", `rollout-2026-10-07T10-00-00-${SID}.jsonl`, metaLine({ version: "0.162.0-alpha.17.2", provider: "azure" }));
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-00-${SID}.jsonl`, metaLine({ version: "0.143.0", provider: null }));
    const sample = await sampleCodexRolloutMeta(join(base, "sessions"));
    assert.equal(sample.cliVersion, "0.162.0-alpha.17.2");
    assert.equal(sample.modelProvider, "azure", "最新（10-08）无 provider → 回退次新（10-07）的值");
    assert.equal(sample.sampledFiles, 2);
  });

  it("坏首行 / 非 session_meta 首行 / 空文件 → 跳过不中断", async () => {
    const base = await workspace();
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-01-${SID}.jsonl`, "{ 坏行\n");
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-02-${SID}.jsonl`, JSON.stringify({ type: "response_item", payload: {} }) + "\n");
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-03-${SID}.jsonl`, "");
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-04-${SID}.jsonl`, metaLine({ version: "0.159.0" }));
    const sample = await sampleCodexRolloutMeta(join(base, "sessions"));
    assert.equal(sample.cliVersion, "0.159.0");
    assert.equal(sample.sampledFiles, 4, "坏文件也计入预算（防坏盘全量扫）");
  });

  it("maxFiles 预算：超出即止（从最新日期扫起）", async () => {
    const base = await workspace();
    for (let i = 0; i < 5; i += 1) {
      await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-0${i}-${SID}.jsonl`, metaLine({ version: `0.14${i}.0` }));
    }
    const sample = await sampleCodexRolloutMeta(join(base, "sessions"), { maxFiles: 2 });
    assert.equal(sample.sampledFiles, 2);
    assert.equal(sample.cliVersion, "0.144.0", "文件名倒序 → 先读最新两个（04/03）中的最高版本");
  });

  it("首行字节预算：maxBytesPerFile 太小读不到完整首行 → 跳过（绝不整包加载大文件）", async () => {
    const base = await workspace();
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-00-${SID}.jsonl`, metaLine({ version: "0.159.0" }));
    const sample = await sampleCodexRolloutMeta(join(base, "sessions"), { maxBytesPerFile: 16 });
    assert.equal(sample.cliVersion, null);
    assert.equal(sample.sampledFiles, 1);
  });

  it("归档目录（平铺）一并采样；非 rollout 命名文件忽略", async () => {
    const base = await workspace();
    const archived = join(base, "archived_sessions");
    await mkdir(archived, { recursive: true });
    await writeFile(join(archived, `rollout-2026-05-12T13-11-39-${SID}.jsonl`), metaLine({ version: "0.130.0", provider: "openai" }), "utf8");
    await writeFile(join(archived, "session_index.jsonl"), metaLine({ version: "9.9.9" }), "utf8");
    const sample = await sampleCodexRolloutMeta(join(base, "sessions"), { archivedDir: archived });
    assert.equal(sample.cliVersion, "0.130.0");
    assert.equal(sample.modelProvider, "openai");
    assert.equal(sample.sampledFiles, 1, "非 rollout-*.jsonl 命名不进采样");
  });
});

describe("resolveCodexNewSessionMeta：探测 → 采样回落 → HubError 取值链", () => {
  it("探测成功 + 注入 provider：用探测版本，不依赖采样目录", async () => {
    const base = await workspace();
    const fake = fakeSpawn({ kind: "ok", output: "codex-cli 0.162.0\n" });
    const meta = await resolveCodexNewSessionMeta({
      codexBin: "codex", sessionsDir: join(base, "missing"), spawnFn: fake.spawnFn, env: {}, modelProvider: "azure",
    });
    assert.deepEqual(meta, { cliVersion: "0.162.0", modelProvider: "azure" });
  });

  it("探测成功 + 未注入 provider：版本用探测值（哪怕采样里有别的版本），provider 用采样值", async () => {
    const base = await workspace();
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-00-${SID}.jsonl`, metaLine({ version: "0.143.0", provider: "azure" }));
    const fake = fakeSpawn({ kind: "ok", output: "codex-cli 0.162.0-alpha.17.2\n" });
    const meta = await resolveCodexNewSessionMeta({
      codexBin: "codex", sessionsDir: join(base, "sessions"), spawnFn: fake.spawnFn, env: {},
    });
    assert.equal(meta.cliVersion, "0.162.0-alpha.17.2", "探测优先于采样（所配置二进制才是将要 resume 的那个）");
    assert.equal(meta.modelProvider, "azure");
  });

  it("探测失败（非零退出）→ 回落采样版本；无 provider 采样 → \"openai\"", async () => {
    const base = await workspace();
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-00-${SID}.jsonl`, metaLine({ version: "0.159.0-alpha.3", provider: null }));
    const fake = fakeSpawn({ kind: "exitNonZero" });
    const meta = await resolveCodexNewSessionMeta({
      codexBin: "codex", sessionsDir: join(base, "sessions"), spawnFn: fake.spawnFn, env: {},
    });
    assert.deepEqual(meta, { cliVersion: "0.159.0-alpha.3", modelProvider: "openai" });
  });

  it("探测失败（注入 provider 场景）→ 仍回落采样拿版本", async () => {
    const base = await workspace();
    await writeRollout(base, "2026-10-08", `rollout-2026-10-08T10-00-00-${SID}.jsonl`, metaLine({ version: "0.143.0" }));
    const fake = fakeSpawn({ kind: "spawnError" });
    const meta = await resolveCodexNewSessionMeta({
      codexBin: "codex", sessionsDir: join(base, "sessions"), spawnFn: fake.spawnFn, env: {}, modelProvider: "azure",
    });
    assert.deepEqual(meta, { cliVersion: "0.143.0", modelProvider: "azure" });
  });

  it("探测与采样都失败 → HubError(INTERNAL, 503)，文案含可行动的中文指引", async () => {
    const base = await workspace();
    const fake = fakeSpawn({ kind: "spawnError" });
    await assert.rejects(
      resolveCodexNewSessionMeta({ codexBin: "codex", sessionsDir: join(base, "missing"), spawnFn: fake.spawnFn, env: {} }),
      (error: unknown) =>
        error instanceof HubError &&
        error.code === ErrorCodes.INTERNAL &&
        error.statusCode === 503 &&
        /无法探测 codex 版本/.test(error.message) &&
        /新建 Codex 会话/.test(error.message),
    );
  });
});
