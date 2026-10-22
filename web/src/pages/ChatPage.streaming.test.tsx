/**
 * WS 风暴批处理回归 + 性能对比（长会话/高频流式）：
 * 行为（零变化保障）：
 * 1. 在途 delta 未落盘时 message_end 到达 → 占位合并去重仍正确（无双条、文本完整）
 * 2. 批处理后打字机文本逐批推进、最终完整
 * 3. 相邻消息更新不重渲全部历史（MessageBubble/Markdown 渲染次数）
 * 性能（改造前后对比，同环境）：
 * - windowMs=0 = 改造前逐条 setState；windowMs=40 = 改造后时间窗批处理
 * - 200 条消息会话 + 50/200 delta/s 流式，测量渲染次数与渲染耗时（Profiler）
 */
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionSummary } from "../api/types";
import type { WsEvent } from "../chat/messageStream";
import { streamBatchConfig, DEFAULT_BATCH_WINDOW_MS } from "../chat/deltaBatcher";
import { probeCount, probeReset } from "../utils/renderProbe";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sendPromptWithMode: vi.fn(),
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSession: mocks.getSession,
    sendPrompt: mocks.sendPrompt,
    abortSession: mocks.abortSession,
  },
}));

vi.mock("../api/prompt", () => ({
  sendPromptWithMode: mocks.sendPromptWithMode,
}));

vi.mock("../hooks/useGitStatus", () => ({
  useGitStatus: () => null,
}));

let wsEvent: ((event: WsEvent) => void) | null = null;

vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (opts: { onEvent: (event: WsEvent) => void }) => {
    wsEvent = opts.onEvent;
  },
}));

import { ChatPage } from "./ChatPage";

const session: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "长会话",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo/s1.jsonl",
  isSubAgent: false,
};

/** 合成 N 条历史消息（user/assistant 交替，含 markdown 文本） */
function historyMessages(count: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push({
      id: `h-${i}`,
      role,
      timestamp: 1_000 + i,
      text:
        role === "user"
          ? `问题 ${i}：请分析这段代码`
          : `回答 ${i}：\n\n- 结论 **${i}**\n- 明细 \`item-${i}\`\n\n见 [文档](https://example.com/${i})`,
      thinking: null,
      toolCalls: i % 5 === 0 ? [{ name: "Read", summary: `src/a${i}.ts`, status: "done", resultPreview: null }] : [],
    });
  }
  return out;
}

/** 合成流式文本（每条 delta 一个字符） */
function makeLiveText(count: number): string {
  return "流式回复内容".repeat(Math.ceil(count / 6)).slice(0, count);
}

let root: Root | null = null;
let container: HTMLElement | null = null;

interface StreamResult {
  commits: number;
  durationMs: number;
  bubbleRenders: number;
  markdownRenders: number;
  wallMs: number;
  finalText: string;
  rows: number;
}

/**
 * 跑一轮：200 条历史 + 高频流式（deltaCount 条 delta，间隔 intervalMs），
 * windowMs=0 为改造前路径（逐条 flush），windowMs=40 为改造后批处理。
 */
async function runStream(windowMs: number, deltaCount: number, intervalMs: number): Promise<StreamResult> {
  streamBatchConfig.windowMs = windowMs;
  probeReset();
  mocks.getSession.mockResolvedValue({ session, messages: historyMessages(200), hasMore: false, nextBefore: null });

  let commits = 0;
  let durationMs = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Profiler
        id="chat"
        onRender={(_id, _phase, actualDuration) => {
          commits += 1;
          durationMs += actualDuration;
        }}
      >
        <ChatPage sessionId="s1" />
      </Profiler>,
    );
    await Promise.resolve();
  });

  const baselineCommits = commits;
  const baselineDuration = durationMs;
  probeReset();

  // 高频流式：message_start + N 条 text_delta（50/200 delta/s）+ message_end
  const liveText = makeLiveText(deltaCount);
  const wallStart = performance.now();
  await act(async () => {
    wsEvent?.({ type: "message_start", message: { id: "live-1", role: "assistant", timestamp: 10_000 } });
    wsEvent?.({ type: "status", status: "running" });
  });
  for (let i = 0; i < deltaCount; i += 1) {
    await act(async () => {
      wsEvent?.({ type: "text_delta", messageId: "live-1", delta: liveText[i] });
      vi.advanceTimersByTime(intervalMs);
    });
  }
  await act(async () => {
    wsEvent?.({
      type: "message_end",
      message: { id: "live-1", role: "assistant", timestamp: 10_001, text: liveText, toolCalls: [] },
    });
    vi.advanceTimersByTime(1_000);
  });
  const wallMs = performance.now() - wallStart;

  const el = container;
  const rows = el.querySelectorAll(".msg-row").length;
  const finalText = el.querySelector("#msg-live-1 .md")?.textContent ?? "";
  const result: StreamResult = {
    commits: commits - baselineCommits,
    durationMs: durationMs - baselineDuration,
    bubbleRenders: probeCount("MessageBubble"),
    markdownRenders: probeCount("Markdown"),
    wallMs,
    finalText,
    rows,
  };
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  root = null;
  container = null;
  return result;
}

beforeEach(() => {
  wsEvent = null;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
  mocks.getSession.mockReset();
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.sendPrompt.mockReset();
  mocks.abortSession.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  streamBatchConfig.windowMs = DEFAULT_BATCH_WINDOW_MS;
});

describe("ChatPage 流式批处理（行为零变化保障）", () => {
  it("在途 delta 未落盘时 message_end 到达：占位合并去重仍正确（单条、文本完整）", async () => {
    mocks.getSession.mockResolvedValue({ session, messages: [], hasMore: false, nextBefore: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ChatPage sessionId="s1" />);
      await Promise.resolve();
    });
    await act(async () => {
      // 同帧高频：占位 + 若干 delta + 权威收尾（text 与占位一致，触发 FIFO 合并去重）
      wsEvent?.({ type: "status", status: "running" });
      wsEvent?.({ type: "message_start", message: { id: "live-9", role: "assistant", timestamp: 1 } });
      wsEvent?.({ type: "text_delta", messageId: "live-9", delta: "完整" });
      wsEvent?.({ type: "text_delta", messageId: "live-9", delta: "回复" });
      wsEvent?.({
        type: "message_end",
        message: { id: "real-9", role: "assistant", timestamp: 2, text: "完整回复", toolCalls: [] },
      });
    });
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".msg-row"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("msg-real-9");
    expect(rows[0].textContent).toContain("完整回复");
  });

  it("批处理打字机观感：文本逐批推进、最终完整、无重复气泡", async () => {
    const r = await runStream(DEFAULT_BATCH_WINDOW_MS, 100, 20);
    expect(r.rows).toBe(201); // 200 历史 + 1 条流式（不双条）
    expect(r.finalText).toBe(makeLiveText(100)); // 100 字符完整
  });
});

describe("ChatPage 流式性能对比（before/after）", () => {
  it("50 delta/s × 2s（100 delta）：渲染次数与耗时对比表", { timeout: 30_000 }, async () => {
    const before = await runStream(0, 100, 20);
    const after = await runStream(DEFAULT_BATCH_WINDOW_MS, 100, 20);
    // 行为一致：文本完整、无双条
    expect(after.finalText).toBe(before.finalText);
    expect(after.rows).toBe(before.rows);
    // 批处理后渲染次数显著下降
    expect(after.commits).toBeLessThan(before.commits);
    printTable("50 delta/s × 2s（100 delta）", before, after);
  });

  it("200 delta/s × 2s（400 delta）：更高频风暴下批处理收益更大", { timeout: 30_000 }, async () => {
    const before = await runStream(0, 400, 5);
    const after = await runStream(DEFAULT_BATCH_WINDOW_MS, 400, 5);
    expect(after.finalText).toBe(before.finalText);
    expect(after.rows).toBe(before.rows);
    expect(after.commits).toBeLessThan(before.commits / 3);
    printTable("200 delta/s × 2s（400 delta）", before, after);
  });
});

function printTable(title: string, before: StreamResult, after: StreamResult): void {
  const line = (name: string, b: string, a: string, delta: string) =>
    `| ${name} | ${b} | ${a} | ${delta} |`;
  console.log(`\n[perf] ${title}（200 条历史消息会话，jsdom + React Profiler）`);
  console.log(line("指标", "改造前(逐条)", "改造后(批处理)", "提升"));
  console.log(line("---", "---", "---", "---"));
  console.log(line("渲染次数(commit)", String(before.commits), String(after.commits), `${(before.commits / Math.max(1, after.commits)).toFixed(1)}x ↓`));
  console.log(line("MessageBubble 渲染", String(before.bubbleRenders), String(after.bubbleRenders), `${(before.bubbleRenders / Math.max(1, after.bubbleRenders)).toFixed(1)}x ↓`));
  console.log(line("Markdown 渲染", String(before.markdownRenders), String(after.markdownRenders), `${(before.markdownRenders / Math.max(1, after.markdownRenders)).toFixed(1)}x ↓`));
  console.log(line("渲染耗时(Profiler ms)", before.durationMs.toFixed(1), after.durationMs.toFixed(1), `${(before.durationMs / Math.max(0.1, after.durationMs)).toFixed(1)}x ↓`));
  console.log(line("流式总耗时(ms)", before.wallMs.toFixed(0), after.wallMs.toFixed(0), `${(before.wallMs / Math.max(0.1, after.wallMs)).toFixed(1)}x ↓`));
}
