/**
 * 首页工作台统计推导（docs/API_CONTRACT.md §4）单测：
 * todayDone/todayMessages 的时间口径、等你处理分类、周 commits（git 可注入）、
 * DashboardService 端到端（临时会话目录 + 固定 now）。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  capReadIds,
  classifyAttention,
  clampResidentText,
  computeStreak,
  countSettledRuns,
  countTodayMessages,
  countWeekCommits,
  deriveDashboard,
  findGitRepos,
  parseRevListCount,
  startOfDay,
  startOfWeek,
  sumCommitCounts,
  DashboardService,
  LIVE_TEXT_LIMIT,
  READ_IDS_MAX,
} from "../dashboard.js";
import { notificationSummary } from "../notifications.js";
import { buildInsight, type SessionInsight } from "../sessions/scan.js";
import type { MessageDto, SessionListItem } from "../types.js";

const NOW = Date.parse("2026-02-18T12:00:00.000Z"); // 周三
const DAY_START = startOfDay(NOW);

function msg(id: string, role: MessageDto["role"], text: string, timestamp: number): MessageDto {
  return { id, role, timestamp, text, toolCalls: [] };
}

function makeInsight(over: {
  status?: SessionListItem["status"];
  updatedAt?: string;
  messages?: MessageDto[];
  lastMessageRole?: SessionInsight["lastMessageRole"];
}): SessionInsight {
  const summary: SessionListItem = {
    id: "sess-a",
    name: "会话 A",
    cwd: "/tmp/demo",
    updatedAt: over.updatedAt ?? new Date(NOW - 60_000).toISOString(),
    messageCount: over.messages?.length ?? 0,
    status: over.status ?? "idle",
    lastUserMessage: "帮我跑一下",
    lastAssistantMessage: "已完成，输出如上",
    sessionFile: "/tmp/sess-a.jsonl",
    isSubAgent: false,
    source: "pi",
  };
  const messages = over.messages ?? [
    msg("m1", "user", "帮我跑一下", NOW - 10 * 60_000),
    msg("m2", "assistant", "已完成，输出如上", NOW - 5 * 60_000),
  ];
  const built = buildInsight(summary, messages);
  return { ...built, lastMessageRole: over.lastMessageRole !== undefined ? over.lastMessageRole : built.lastMessageRole };
}

describe("dashboard: 今日时间窗", () => {
  it("startOfDay = 本地 00:00", () => {
    const d = new Date(startOfDay(NOW));
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
  });

  it("startOfWeek = 本地周一 00:00（2026-02-18 是周三）", () => {
    const d = new Date(startOfWeek(NOW));
    assert.equal(d.getDay(), 1);
    assert.equal(d.getHours(), 0);
    assert.ok(startOfWeek(NOW) <= startOfDay(NOW));
  });

  it("computeStreak：连续活跃天数（今日未活跃不渐裂）", () => {
    const day = (offset: number): number => startOfDay(NOW) - offset * 86_400_000;
    // 今天 + 昨天 + 前天 → 3
    assert.equal(computeStreak([day(0), day(1), day(2)], NOW), 3);
    // 今天没活跃：从昨天起算 → 2
    assert.equal(computeStreak([day(1), day(2)], NOW), 2);
    // 断档：只数到最近连续段
    assert.equal(computeStreak([day(0), day(2), day(3)], NOW), 1);
    // 多天前才活跃且不连续 → 0
    assert.equal(computeStreak([day(5)], NOW), 0);
    assert.equal(computeStreak([], NOW), 0);
  });
});

describe("dashboard: todayDone（agent_settled 次数从消息时间推）", () => {
  const t = (min: number) => NOW - min * 60_000;

  it("一轮 run（user + 多条 assistant）只算一次 settled", () => {
    const messages = [
      msg("u1", "user", "开始", t(30)),
      msg("a1", "assistant", "思考中", t(29)),
      msg("a2", "assistant", "完成", t(28)),
    ];
    assert.equal(countSettledRuns(messages, { dayStart: DAY_START, dayEnd: NOW + 1, running: false }), 1);
  });

  it("多轮 run 按 user 边界分别计数", () => {
    const messages = [
      msg("u1", "user", "一", t(60)),
      msg("a1", "assistant", "好", t(59)),
      msg("u2", "user", "二", t(40)),
      msg("a2", "assistant", "好", t(39)),
    ];
    assert.equal(countSettledRuns(messages, { dayStart: DAY_START, dayEnd: NOW + 1, running: false }), 2);
  });

  it("运行中的会话末条 assistant 不算 settled", () => {
    const messages = [msg("u1", "user", "一", t(10)), msg("a1", "assistant", "好", t(9))];
    assert.equal(countSettledRuns(messages, { dayStart: DAY_START, dayEnd: NOW + 1, running: true }), 0);
  });

  it("只计今日窗口内的 settled", () => {
    const yesterday = DAY_START - 60 * 60_000;
    const messages = [
      msg("u1", "user", "昨天", yesterday),
      msg("a1", "assistant", "昨天完成", yesterday + 1000),
      msg("u2", "user", "今天", t(30)),
      msg("a2", "assistant", "今天完成", t(29)),
    ];
    assert.equal(countSettledRuns(messages, { dayStart: DAY_START, dayEnd: NOW + 1, running: false }), 1);
  });

  it("custom 消息后随也算 run 边界", () => {
    const messages = [msg("a1", "assistant", "好", t(30)), msg("c1", "custom", "[compacted]", t(20))];
    assert.equal(countSettledRuns(messages, { dayStart: DAY_START, dayEnd: NOW + 1, running: false }), 1);
  });
});

describe("dashboard: todayMessages", () => {
  it("只计今日的 user/assistant 消息", () => {
    const messages = [
      msg("u1", "user", "昨天", DAY_START - 1000),
      msg("a1", "assistant", "今天", NOW - 5000),
      msg("u2", "user", "今天", NOW - 4000),
      msg("x1", "custom", "压缩记录", NOW - 3000),
    ];
    assert.equal(countTodayMessages(messages, { dayStart: DAY_START, dayEnd: NOW + 1 }), 2);
  });
});

describe("dashboard: 等你处理分类", () => {
  it("error 会话无条件浮出", () => {
    const insight = makeInsight({ status: "error", updatedAt: new Date(NOW - 48 * 3600_000).toISOString() });
    assert.equal(classifyAttention(insight, { now: NOW }), "error");
  });

  it("agent 干完（最后是 assistant）且 24h 内 → settled", () => {
    assert.equal(classifyAttention(makeInsight({}), { now: NOW }), "settled");
  });

  it("超过时间窗的 settled 不再浮出", () => {
    const insight = makeInsight({ updatedAt: new Date(NOW - 25 * 3600_000).toISOString() });
    assert.equal(classifyAttention(insight, { now: NOW }), null);
  });

  it("运行中 / 最后是用户消息 → 不进等你处理", () => {
    assert.equal(classifyAttention(makeInsight({ status: "running" }), { now: NOW }), null);
    assert.equal(classifyAttention(makeInsight({ lastMessageRole: "user" }), { now: NOW }), null);
    assert.equal(classifyAttention(makeInsight({ lastMessageRole: null }), { now: NOW }), null);
  });
});

describe("dashboard: deriveDashboard 汇总", () => {
  it("数字与分区卡片同源（真实数据推导）", () => {
    const insights = [
      makeInsight({ status: "running", messages: [msg("u1", "user", "跑", NOW - 60_000), msg("a1", "assistant", "工具执行中", NOW - 30_000)] }),
      makeInsight({}),
      makeInsight({ status: "error" }),
    ];
    const stats = deriveDashboard(insights, { now: NOW, weekCommits: 7 });
    assert.equal(stats.working, 1);
    assert.equal(stats.needAttention, 2);
    // running 卡的末条 assistant 未 settled 不计；另两个各一轮（含 error 会话的 run 边界，v0 口径）
    assert.equal(stats.todayDone, 2);
    assert.equal(stats.todayMessages, 6);
    assert.equal(stats.weekCommits, 7);
    // 本周统计：本周消息 / 本周完成会话 / 连续活跃天数
    assert.equal(stats.weekMessages, 6);
    assert.equal(stats.weekDone, 2);
    assert.equal(stats.streak, 1);
    assert.equal(stats.todayDoneSessions.length, 2);
    assert.ok(stats.todayDoneSessions.every((id) => id === "sess-a"));
    assert.equal(stats.workingSessions.length, 1);
    assert.equal(stats.workingSessions[0].id, "sess-a");
    assert.equal(stats.workingSessions[0].currentTool, null);
    assert.equal(stats.workingSessions[0].lastOutput, "已完成，输出如上");
    const reasons = stats.attentionSessions.map((a) => a.reason).sort();
    assert.deepEqual(reasons, ["error", "settled"]);
    for (const card of stats.attentionSessions) {
      assert.equal(card.summary, "已完成，输出如上");
    }
  });
});

describe("dashboard: git 周提交数", () => {
  it("parseRevListCount / sumCommitCounts", () => {
    assert.equal(parseRevListCount("12\n"), 12);
    assert.equal(parseRevListCount("garbage"), 0);
    assert.equal(parseRevListCount(""), 0);
    assert.equal(sumCommitCounts([1, 2, 3]), 6);
    assert.equal(sumCommitCounts([]), 0);
  });

  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-hub-ws-"));
    await mkdir(join(root, "repo-a", ".git"), { recursive: true });
    await mkdir(join(root, "nested", "repo-b", ".git"), { recursive: true });
    await mkdir(join(root, "not-a-repo"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("findGitRepos：自身 + 子孙（含 worktree 层级），仓库内部不再递归", async () => {
    const repos = await findGitRepos(root, 2);
    assert.deepEqual(repos.sort(), [join(root, "nested", "repo-b"), join(root, "repo-a")].sort());
  });

  it("countWeekCommits：多仓库求和，git 不可用时为 0", async () => {
    const calls: string[][] = [];
    const fakeExec = ((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      calls.push([cmd, ...args]);
      const repo = args[1];
      cb(null, repo.endsWith("repo-a") ? "5\n" : "2\n");
    }) as never;
    const total = await countWeekCommits(root, { now: NOW, execFileFn: fakeExec });
    assert.equal(total, 7);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call[0], "git");
      assert.ok(call.includes("rev-list"));
      assert.ok(call.some((a) => a.startsWith("--since=")), `缺少 --since: ${call.join(" ")}`);
    }

    const brokenExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      cb(new Error("git not found"), "");
    }) as never;
    assert.equal(await countWeekCommits(root, { now: NOW, execFileFn: brokenExec }), 0);
    assert.equal(await countWeekCommits("/nonexistent-root-xyz", { now: NOW, execFileFn: fakeExec }), 0);
  });
});

describe("dashboard: DashboardService 端到端（临时会话目录）", () => {
  let dir: string;
  let wsRoot: string;
  let storeFile: string;
  const NOW_MS = Date.parse("2026-02-18T12:00:00.000Z");

  function sessionLine(id: string, cwd: string): string {
    return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(NOW_MS - 3600_000).toISOString(), cwd });
  }
  function msgLine(id: string, role: string, text: string, tsMs: number, parentId: string | null = null): string {
    return JSON.stringify({ type: "message", id, parentId, timestamp: new Date(tsMs).toISOString(), message: { role, content: text, timestamp: tsMs } });
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-dash-"));
    storeFile = join(dir, "read-marks.json");
    // workspaceRoot：一个 git 仓库（fake exec 返回 3）
    wsRoot = join(dir, "ws");
    await mkdir(join(wsRoot, "repo", ".git"), { recursive: true });
    const enc = "--tmp-work-demo--";
    await mkdir(join(dir, enc), { recursive: true });
    // 会话 1：昨天开始、今天完成一轮（等你处理 + todayDone）
    await writeFile(
      join(dir, enc, "s1.jsonl"),
      [
        sessionLine("s1", "/tmp/work-demo"),
        msgLine("u1", "user", "帮我修复构建", NOW_MS - 30 * 60_000),
        msgLine("a1", "assistant", "构建已修复", NOW_MS - 20 * 60_000, "u1"),
      ].join("\n"),
      "utf8",
    );
    // 会话 2：出错（等你处理 reason=error）
    await writeFile(
      join(dir, enc, "s2.jsonl"),
      [
        sessionLine("s2", "/tmp/work-demo"),
        msgLine("u2", "user", "跑测试", NOW_MS - 40 * 60_000),
        msgLine("a2", "assistant", "测试失败：TypeError", NOW_MS - 35 * 60_000, "u2"),
      ].join("\n"),
      "utf8",
    );
    // 会话 3：用户发话未回（不进等你处理）
    await writeFile(
      join(dir, enc, "s3.jsonl"),
      [sessionLine("s3", "/tmp/work-demo"), msgLine("u3", "user", "检查一下", NOW_MS - 10 * 60_000)].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("getStats：数字来自会话扫描；running 由注入运行态决定", async () => {
    const service = new DashboardService({
      sessionDir: dir,
      workspaceRoot: wsRoot,
      storeFile,
      now: () => NOW_MS,
      statusOf: (id) => (id === "s3" ? "running" : id === "s2" ? "error" : "idle"),
      execFileFn: ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, "3\n")) as never,
    });
    const stats = await service.getStats();
    assert.equal(stats.working, 1);
    assert.equal(stats.needAttention, 2);
    // s1/s2 各一轮 run 边界（s3 running 未 settled 不计）
    assert.equal(stats.todayDone, 2);
    assert.ok(stats.todayMessages >= 4);
    assert.equal(stats.weekCommits, 3);
    assert.equal(stats.workingSessions[0].id, "s3");
    const reasons = Object.fromEntries(stats.attentionSessions.map((a) => [a.id, a.reason]));
    assert.deepEqual(reasons, { s1: "settled", s2: "error" });
    assert.equal(stats.attentionSessions.find((a) => a.id === "s2")?.summary, "测试失败：TypeError");
  });
});

describe("dashboard: 洞察计数守卫（AC4 口径逐字不变）", () => {
  it("锚点日/周与 derive 不同窗时按 0 计（与逐条过滤口径等价）", () => {
    // 上周六活跃的旧会话：今天 derive 时今日/本周计数都不窜入
    const lastWeekDay = startOfWeek(NOW) - 2 * 86_400_000;
    const oldMessages = [
      msg("u1", "user", "上周任务", lastWeekDay + 10 * 3600_000),
      msg("a1", "assistant", "上周完成", lastWeekDay + 11 * 3600_000),
    ];
    const oldInsight = makeInsight({
      messages: oldMessages,
      updatedAt: new Date(lastWeekDay + 11 * 3600_000).toISOString(),
    });
    const stats = deriveDashboard([oldInsight], { now: NOW, weekCommits: 0 });
    // 对照口径：旧实现逐条按 derive-now 过滤同样为 0
    assert.equal(countSettledRuns(oldMessages, { dayStart: DAY_START, dayEnd: NOW + 1, running: false }), 0);
    assert.equal(stats.todayDone, 0);
    assert.equal(stats.weekDone, 0);
    assert.equal(stats.todayMessages, 0);
    assert.equal(stats.weekMessages, 0);
    assert.equal(stats.streak, 0);
    // 同窗会话照常计数（守卫不冤枉今天的会话）
    const todayStats = deriveDashboard([makeInsight({})], { now: NOW, weekCommits: 0 });
    assert.equal(todayStats.todayDone, 1);
    assert.equal(todayStats.todayMessages, 2);
    assert.equal(todayStats.weekDone, 1);
  });
});

describe("dashboard: 内存驻留裁剪（AC6）", () => {
  it("clampResidentText 只留前缀上限，通知摘要输出逐字不变", () => {
    const long = `任务${"长".repeat(5000)}结尾`;
    const clamped = clampResidentText(long);
    assert.equal(clamped.length, LIVE_TEXT_LIMIT);
    assert.ok(long.startsWith(clamped));
    assert.equal(clampResidentText("短文本"), "短文本");
    // 摘要只用开头：截断前后 settled 文案逐字相同（行为不变性）
    assert.equal(
      notificationSummary({ kind: "settled", lastUserText: clamped, fallback: "x" }),
      notificationSummary({ kind: "settled", lastUserText: long, fallback: "x" }),
    );
  });

  it("capReadIds 只留最近 1000 条（对齐 saveReadMarks 磁盘上限）", () => {
    const ids = new Set(Array.from({ length: 1500 }, (_, i) => `id-${i}`));
    const capped = capReadIds(ids);
    assert.equal(capped.size, READ_IDS_MAX);
    assert.ok(capped.has("id-1499"));
    assert.ok(!capped.has("id-0"));
    assert.deepEqual([...capped], [...ids].slice(-READ_IDS_MAX));
    // 未超上限不裁剪
    const small = new Set(["a", "b"]);
    assert.deepEqual([...capReadIds(small)], ["a", "b"]);
  });
});
