/**
 * 平行发送的「外部活跃闸门」测试（防双写同一会话文件）。
 *
 * 背景：pi 会话文件是 append-only + leafId 树。电脑终端的 pi 进程与 server 内的 SDK 实例
 * 各自维护 leafId，同时 append 会产生同 parent 分叉（一侧消息在 selectActiveBranch 回溯下
 * 静默不可见）；版本迁移触发 SessionManager._rewriteFile() 时更会截断重写、永久抹掉对方的行。
 * claude 侧早有 isEffectivelyBusy() 三源并集，pi 侧此前只看 SDK 自己的 isIdle = 零保护。
 *
 * 本文件同时钉死两类**误伤**（比漏保护更容易发生、后果更直接）：
 * - 手机新建会话后发第一条消息：createSession 写盘把 mtime 刷成 now，裸用时间推断会自锁
 * - server 自己的 live 实例在跑：写盘同样刷新 mtime，必须放行
 */
import { strict as assert } from "node:assert";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSession, AgentSessionEvent, createAgentSession } from "@earendil-works/pi-coding-agent";
import { ErrorCodes, HubError } from "../errors.js";
import { SessionHub } from "../sessions/hub.js";
import { SessionTailManager } from "../sessions/tail.js";
import type { ServerEvent } from "../types.js";

interface FakeSession {
  session: AgentSession;
  emit: (event: AgentSessionEvent) => void;
}

function makeFakeSession(promptImpl: () => Promise<void> = async () => undefined): FakeSession {
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
    abort: async () => undefined,
    compact: async () => undefined,
    sessionManager: { getEntries: () => [] },
  } as unknown as AgentSession;
  return { session, emit: (event) => handler?.(event) };
}

function fakeCreate(fake: FakeSession) {
  return (async () => ({ session: fake.session })) as unknown as typeof createAgentSession;
}

const SESSION_HEADER = (id: string, cwd: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-02-18T09:00:00.000Z", cwd });
const USER_LINE = (id: string) =>
  JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-02-18T10:00:00.000Z",
    message: { role: "user", content: "历史消息", timestamp: Date.parse("2026-02-18T10:00:00.000Z") },
  });

describe("SessionHub：外部活跃闸门（平行发送防双写）", () => {
  let dir: string;
  let workdir: string;
  const enc = "--tmp-gate-demo--";
  const events: ServerEvent[] = [];

  /** 写一个会话文件；ageMs>0 时把 mtime 推回过去（表达「历史不活跃会话」） */
  async function fixture(id: string, ageMs = 0): Promise<string> {
    const file = join(dir, enc, `${id}.jsonl`);
    await writeFile(file, [SESSION_HEADER(id, workdir), USER_LINE(`${id}-u1`)].join("\n"), "utf8");
    if (ageMs > 0) {
      const aged = new Date(Date.now() - ageMs);
      await utimes(file, aged, aged);
    }
    return file;
  }

  function makeHub(opts: { externalActive?: (id: string) => boolean } = {}): SessionHub {
    events.length = 0;
    const fake = makeFakeSession();
    const hub = new SessionHub(dir, (_id, event) => events.push(event), {
      createAgentSession: fakeCreate(fake),
      externalActive: opts.externalActive,
    });
    return hub;
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-gate-"));
    workdir = await mkdtemp(join(tmpdir(), "agent-hub-gate-work-"));
    await mkdir(join(dir, enc), { recursive: true });
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  /** 断言 prompt 抛 EXTERNAL_ACTIVE，并返回文案 */
  async function expectBlocked(hub: SessionHub, id: string, mode?: "prompt" | "steer" | "followUp"): Promise<string> {
    try {
      await hub.prompt(id, "你好", mode);
    } catch (err) {
      assert.ok(err instanceof HubError, `应是 HubError，实际 ${String(err)}`);
      assert.equal(err.code, ErrorCodes.EXTERNAL_ACTIVE);
      assert.equal(err.statusCode, 409);
      assert.ok(err.message.length > 10, "文案必须可行动，不能是空话");
      return err.message;
    }
    assert.fail("应被闸门拦住（409 EXTERNAL_ACTIVE），实际放行了");
  }

  it("历史不活跃会话（mtime 陈旧）→ 放行，这是手机继续老会话的主路径", async () => {
    await fixture("gate-idle", 10 * 60_000);
    const hub = makeHub();
    const result = await hub.prompt("gate-idle", "继续这个会话", undefined);
    assert.equal(result.accepted, true);
  });

  it("会话文件刚被外部写入（mtime 新鲜、无本进程登记）→ 409 + 中文原因", async () => {
    await fixture("gate-fresh"); // ageMs=0 → mtime=now
    const hub = makeHub();
    const message = await expectBlocked(hub, "gate-fresh");
    assert.match(message, /仍在运行|双写/);
    assert.match(message, /1 分钟/); // 必须给出「等多久」的出路
  });

  it("三种 mode 一律拦：steer/followUp 对外部进程无处投递（与 claude 口径一致）", async () => {
    await fixture("gate-modes");
    const hub = makeHub();
    await expectBlocked(hub, "gate-modes", "steer");
    await expectBlocked(hub, "gate-modes", "followUp");
    await expectBlocked(hub, "gate-modes", "prompt");
  });

  it("终端 pi-command 心跳在线 → 拦，且文案引导切 🖥 接管（不是干等）", async () => {
    await fixture("gate-online", 10 * 60_000); // mtime 陈旧：只有心跳这一个信号
    const hub = makeHub({ externalActive: (id) => id === "gate-online" });
    const message = await expectBlocked(hub, "gate-online");
    assert.match(message, /接管/);
  });

  it("心跳只针对该会话：别的会话在线不误伤本会话", async () => {
    await fixture("gate-other", 10 * 60_000);
    const hub = makeHub({ externalActive: (id) => id === "gate-notme" });
    const result = await hub.prompt("gate-other", "你好", undefined);
    assert.equal(result.accepted, true);
  });

  it("live-feed 扩展近期推过事件 → 拦（终端在跑但没装 pi-command 无法接管）", async () => {
    await fixture("gate-feed", 10 * 60_000);
    const hub = makeHub();
    hub.markLiveFeed("gate-feed");
    const message = await expectBlocked(hub, "gate-feed");
    assert.match(message, /实时事件|pi-command/);
  });

  it("abort 后实例驻留但外部开始写 → 仍拦截（live.has 不得无条件放行）", async () => {
    // 浏览器实测的第二层缺陷：abort 只中止 run、不删实例（10min 空闲才逐出），
    // 若闸门用 live.has 无条件放行，这 10min 内外部终端写盘完全拦不住 = 保护形同虚设。
    const file = await fixture("gate-abort", 10 * 60_000);
    const hub = makeHub();
    await hub.ensureLive("gate-abort"); // 建实例（lastUsedMs = 现在）
    await hub.abort("gate-abort"); // 中止；实例仍驻留且空闲
    // 外部终端接手开始写：mtime 推到实例最后活动之后（远超 5s 容差）
    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);
    const reason = await hub.externalBusyReason("gate-abort", Date.now() + 60_000);
    assert.notEqual(reason, null, "实例驻留但已空闲时，外部写入必须能拦住");
    assert.match(reason!, /仍在运行|双写/);
  });

  it("不自锁①：本进程已有 live 实例 → 放行（自己的写入不算外部）", async () => {
    const file = await fixture("gate-self");
    const hub = makeHub();
    await hub.ensureLive("gate-self"); // 建实例（此后 SDK 写盘会刷新 mtime）
    const result = await hub.prompt("gate-self", "第二条", undefined);
    assert.equal(result.accepted, true);
    // 顺带确认 fixture 确实是新鲜 mtime 场景（否则本用例证明不了「不自锁」）
    await appendFile(file, `${USER_LINE("gate-self-u2")}\n`, "utf8");
    const result2 = await hub.prompt("gate-self", "第三条", "followUp");
    assert.notEqual(result2.accepted, undefined);
  });

  it("不自锁②：手机新建会话后立刻发第一条消息 → 放行（createSession 写盘刷新 mtime）", async () => {
    const hub = makeHub();
    const created = await hub.createSession(workdir, "闸门回归");
    // 这条是修复前会红的回归线：裸用 inferExternalStatus 时新建会话必被自己拦死
    const result = await hub.prompt(created.id, "第一条消息", undefined);
    assert.equal(result.accepted, true);
  });

  it("own 登记之后文件又被外部写 → 拦（idle 登记不得永久压制真实外部活动）", async () => {
    const hub = makeHub();
    const created = await hub.createSession(workdir, "外部接手");
    // 模拟终端 resume 同一会话并开始写盘（mtime 变得比 own.at 更新）
    const found = created.sessionFile;
    await new Promise((r) => setTimeout(r, 5));
    await appendFile(found, `${USER_LINE("ext-1")}\n`, "utf8");
    const future = new Date(Date.now() + 1000);
    await utimes(found, future, future);
    await expectBlocked(hub, created.id);
  });

  it("不自锁③：本进程 open 造成的写入（版本迁移 _rewriteFile）不得当成外部活跃", async () => {
    // 真实路径：SessionManager.open 在会话文件版本较旧时会 migrateToCurrentVersion →
    // _rewriteFile()（openSync(f,"w") 截断重写）把 mtime 刷成 now。紧接着实例被 LRU 逐出
    // （LIVE_MAX=20，不看 TTL）时，下一条消息就会撞上「mtime 新鲜但其实是自己写的」。
    await fixture("gate-ownwrite"); // ageMs=0 → mtime 新鲜
    const hub = makeHub();
    await hub.ensureLive("gate-ownwrite"); // open + 记下写后 mtime
    hub.disposeAll(); // 清掉 live，强制走 mtime 判据（否则 live.has 直接放行，测不到目标分支）
    assert.equal(hub.isSdkLive("gate-ownwrite"), false);
    assert.equal(
      await hub.externalBusyReason("gate-ownwrite"),
      null,
      "本进程 open/迁移重写不算外部活跃，必须放行",
    );
    // 对照组：全新 hub（无 ownWrites，等价于 server 重启后的内存态）仍应保守拦住
    const fresh = makeHub();
    assert.notEqual(await fresh.externalBusyReason("gate-ownwrite"), null);
  });

  it("闸门不被 tail 的启发式回写绕过（WS 握手启动 tail 的真实绕过路径）", async () => {
    // 浏览器实测抓到的绕过：WS 握手 → tails.acquire → tail 对「只有 user 消息、尚无
    // assistant 回复」的文件启发式收尾置 idle 并回写 statuses；闸门的 own 判据若不分来源，
    // 会把这个 idle 当成本进程登记（mtime <= own.at）而放行 → 同窗口内 409 变 202，双写保护失效。
    const file = await fixture("gate-tail"); // ageMs=0 → mtime 新鲜
    const hub = makeHub();
    const before = await hub.externalBusyReason("gate-tail");
    assert.notEqual(before, null, "前置：无 tail 回写时应拦截");

    const tails = new SessionTailManager(() => undefined, { pollMs: 20, idleAfterMs: 60 });
    tails.acquire("gate-tail", file);
    // 等 tail 轮询 + 静默窗收尾 → notifyStatusSinks("idle") 回写进 hub.statuses（source="tail"）
    await new Promise((r) => setTimeout(r, 400));
    tails.release("gate-tail");

    const after = await hub.externalBusyReason("gate-tail");
    assert.notEqual(after, null, "tail 的启发式 idle 回写不得绕过闸门（修复前这里会返回 null = 放行）");
    assert.match(after!, /仍在运行|双写/);
  });

  it("compact 走同一道闸门（压缩也会往会话文件追加 entry）", async () => {
    await fixture("gate-compact");
    const hub = makeHub();
    try {
      await hub.compact("gate-compact");
    } catch (err) {
      assert.ok(err instanceof HubError);
      assert.equal(err.code, ErrorCodes.EXTERNAL_ACTIVE);
      return;
    }
    assert.fail("compact 应被闸门拦住");
  });

  it("闸门在 ensureLive 之前生效：被拦时不建实例、不停文件 tail", async () => {
    await fixture("gate-nolive");
    const hub = makeHub();
    let liveTurnedOff = false;
    hub.onLive = () => {
      liveTurnedOff = true; // index.ts 里这个回调会 tails.detach（停终端输出推送）
    };
    await expectBlocked(hub, "gate-nolive");
    assert.equal(liveTurnedOff, false, "被拦时绝不能触发 onLive（会停掉 tail，把终端输出推送一起搞丢）");
    assert.equal(hub.isSdkLive("gate-nolive"), false);
  });
});
