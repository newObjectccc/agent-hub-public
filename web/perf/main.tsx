/**
 * chat 工作页渲染性能实测 harness（仅 dev 手工验证，vite build 不打包本目录）。
 *
 * 用法：cd web && pnpm dev，浏览器打开
 *   http://localhost:5173/perf/index.html?mode=after   （改造后：批处理 + memo + 窗口化 + rAF 滚动）
 *   http://localhost:5173/perf/index.html?mode=before  （改造前行为模拟：逐条 setState + 无 memo + 全量渲染 + 同步 scroll）
 *
 * 测量（真实 MessageBubble / messageStream / deltaBatcher / messageWindow 代码路径 + 真实样式）：
 * 1. 流式风暴：200 条历史 + 50 delta/s × 4s，测 commit 次数 / 渲染耗时 / 流式期间帧率
 * 2. 长会话滚动：自动上下滚动 2 秒，测滚动帧率（p50/p95 帧间隔、最长帧、掉帧数）
 * 结果渲染到页面表格 + window.__perfResult（自动化读取）。
 */
import { Profiler, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionMessage } from "../src/api/types";
import { applyWsEvent, type WsEvent } from "../src/chat/messageStream";
import { DeltaBatcher } from "../src/chat/deltaBatcher";
import { computeMessageWindow, paddingTopFor, MESSAGE_GAP_PX } from "../src/chat/messageWindow";
import { MessageBubble } from "../src/components/MessageBubble";
import { probeCount, probeReset } from "../src/utils/renderProbe";
import "../src/styles.css";
import "../src/d-polish.css";

const MODE: "before" | "after" = new URLSearchParams(location.search).get("mode") === "before" ? "before" : "after";
const HISTORY_COUNT = Number(new URLSearchParams(location.search).get("count") ?? 200);
const DELTA_COUNT = 200; // 50 delta/s × 4s
const DELTA_INTERVAL_MS = 20;
const VIRTUAL_MIN_COUNT = 60;
const VIRTUAL_OVERSCAN = 6;
const MAX_WINDOW_STEP = 24;

interface PerfResult {
  mode: string;
  stream: {
    commits: number;
    renderMs: number;
    bubbleRenders: number;
    fpsAvg: number;
    frameP50: number;
    frameP95: number;
    longestFrame: number;
    frames: number;
    /** 诊断：delta 循环实际间隔均值（timer 节流检测） */
    deltaIntervalAvg: number;
  };
  scroll: {
    fpsAvg: number;
    frameP50: number;
    frameP95: number;
    longestFrame: number;
    droppedFrames: number;
    domRows: number;
    frames: number;
  };
  diag?: Record<string, number>;
}

declare global {
  interface Window {
    __perfResult?: PerfResult;
    __perfStart?: () => void;
    __perfDone?: Promise<PerfResult>;
  }
}

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

/** 帧采样器（单链 rAF；支持诊断帧数/间隔） */
function useFrameSampler() {
  const framesRef = useRef<number[]>([]);
  const lastRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const tick = useCallback(() => {
    if (!runningRef.current) return;
    const now = performance.now();
    if (lastRef.current !== null) framesRef.current.push(now - lastRef.current);
    lastRef.current = now;
    rafRef.current = requestAnimationFrame(tick);
  }, []);
  const start = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    framesRef.current = [];
    lastRef.current = null;
    runningRef.current = true;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);
  const stats = useCallback((): { frames: number; fpsAvg: number; frameP50: number; frameP95: number; longestFrame: number; droppedFrames: number } => {
    const fs = framesRef.current.filter((f) => f > 0).sort((a, b) => a - b);
    const at = (q: number) => (fs.length > 0 ? fs[Math.min(fs.length - 1, Math.floor(fs.length * q))] : 0);
    const total = fs.reduce((s, f) => s + f, 0);
    return {
      frames: fs.length,
      fpsAvg: fs.length > 0 ? 1000 / (total / fs.length) : 0,
      frameP50: at(0.5),
      frameP95: at(0.95),
      longestFrame: fs.length > 0 ? fs[fs.length - 1] : 0,
      droppedFrames: framesRef.current.filter((f) => f > 50).length,
    };
  }, []);
  const stop = useCallback((): ReturnType<typeof stats> => {
    runningRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    return stats();
  }, [stats]);
  return { start, stop };
}

function App() {
  const [messages, setMessages] = useState<SessionMessage[]>(() => historyMessages(HISTORY_COUNT));
  const [windowStart, setWindowStart] = useState(0);
  const [windowPad, setWindowPad] = useState(0);
  const [virtualized, setVirtualized] = useState(false);
  const [phase, setPhase] = useState("准备中");
  const [result, setResult] = useState<PerfResult | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const winStateRef = useRef({ virtualized: false, start: 0, paddingTop: 0 });
  const sampler = useFrameSampler();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ===== 窗口化（改造后）：与 ChatPage 同口径（handler 链全稳定，不击穿 memo） =====
  const recomputeWindow = useCallback(() => {
    if (MODE !== "after") return;
    const el = scrollRef.current;
    const listEl = listRef.current;
    if (!el || !listEl) return;
    const heights: number[] = [];
    let allMeasured = true;
    for (const m of messagesRef.current) {
      const h = heightsRef.current.get(m.id) ?? 0;
      if (!(h > 0)) allMeasured = false;
      heights.push(h);
    }
    const win = computeMessageWindow({
      count: messagesRef.current.length,
      heights,
      allMeasured,
      scrollTop: el.getBoundingClientRect().top - listEl.getBoundingClientRect().top,
      viewportHeight: el.clientHeight,
      minCount: VIRTUAL_MIN_COUNT,
      overscan: VIRTUAL_OVERSCAN,
    });
    const prev = winStateRef.current;
    let nextStart = win.start;
    let nextPad = win.paddingTop;
    if (win.virtualized && Math.abs(nextStart - prev.start) > MAX_WINDOW_STEP) {
      nextStart = prev.start + Math.sign(nextStart - prev.start) * MAX_WINDOW_STEP;
      nextPad = paddingTopFor(heights, nextStart);
      requestAnimationFrame(recomputeWindow); // 渐进逼近到目标（含首次全量→窗口收缩）
    }
    if (prev.virtualized !== win.virtualized || prev.start !== nextStart || prev.paddingTop !== nextPad) {
      winStateRef.current = { virtualized: win.virtualized, start: nextStart, paddingTop: nextPad };
      setVirtualized(win.virtualized);
      setWindowStart(nextStart);
      setWindowPad(nextPad);
    }
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(recomputeWindow);
    return () => cancelAnimationFrame(id);
  }, [messages, recomputeWindow]);

  const measureRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || MODE !== "after") return;
    const id = el.id.startsWith("msg-") ? el.id.slice(4) : "";
    if (!id) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && heightsRef.current.get(id) !== h) {
      heightsRef.current.set(id, h);
      requestAnimationFrame(recomputeWindow);
    }
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        const hh = el.getBoundingClientRect().height;
        if (hh > 0 && heightsRef.current.get(id) !== hh) {
          heightsRef.current.set(id, hh);
          requestAnimationFrame(recomputeWindow);
        }
      });
      ro.observe(el);
    }
  }, [recomputeWindow]);

  // ===== 滚动：改造后 rAF 合并（每帧一次布局读），改造前逐事件同步处理 =====
  const handleScroll = useCallback(() => {
    if (MODE === "before") {
      const el = scrollRef.current;
      if (el) void el.scrollHeight - el.scrollTop - el.clientHeight;
      return;
    }
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) void el.scrollHeight - el.scrollTop - el.clientHeight;
      recomputeWindow();
    });
  }, [recomputeWindow]);

  // ===== 流式风暴：50 delta/s =====
  const runStream = useCallback(async () => {
    setPhase("流式中（50 delta/s × 4s）");
    const w = window as unknown as { __commits?: number; __renderMs?: number };
    w.__commits = 0;
    w.__renderMs = 0;
    probeReset();
    sampler.start();
    const batcher = new DeltaBatcher(
      (events) => setMessages((prev) => events.reduce((acc, e) => applyWsEvent(acc, e), prev)),
      MODE === "before" ? 0 : 40,
    );
    setMessages((prev) => [
      ...prev,
      ...applyWsEvent([], { type: "message_start", message: { id: "live-1", role: "assistant", timestamp: 9_000 } }),
    ]);
    const liveText = "流式回复内容".repeat(Math.ceil(DELTA_COUNT / 6)).slice(0, DELTA_COUNT);
    let intervalSum = 0;
    for (let i = 0; i < DELTA_COUNT; i += 1) {
      const ev: WsEvent = { type: "text_delta", messageId: "live-1", delta: liveText[i] };
      if (MODE === "before") setMessages((prev) => applyWsEvent(prev, ev));
      else batcher.push(ev);
      const t0 = performance.now();
      await sleep(DELTA_INTERVAL_MS);
      intervalSum += performance.now() - t0;
    }
    batcher.flushNow();
    setMessages((prev) =>
      applyWsEvent(prev, { type: "message_end", message: { id: "live-1", role: "assistant", timestamp: 9_100, text: liveText, toolCalls: [] } }),
    );
    const frames = sampler.stop();
    await sleep(300);
    return { ...frames, deltaIntervalAvg: intervalSum / DELTA_COUNT };
  }, [sampler]);
  // ===== 长会话滚动：自动上下滚动 2s =====
  const runScroll = useCallback(async (): Promise<PerfResult["scroll"]> => {
    setPhase("长会话滚动（自动上下 2s）");
    const el = scrollRef.current;
    if (!el) throw new Error("滚动容器不存在");
    // 从底部开始上下滚动（覆盖长会话全范围，触发窗口化深度裁剪）
    el.scrollTop = el.scrollHeight;
    await sleep(120);
    sampler.start();
    const start = performance.now();
    let dir = -1;
    await new Promise<void>((resolve) => {
      const step = () => {
        el.scrollTop += dir * 60;
        if (el.scrollTop <= 0) dir = 1;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) dir = -1;
        if (performance.now() - start < 2000) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const frames = sampler.stop();
    const domRows = el.querySelectorAll(".msg-row").length;
    return {
      fpsAvg: frames.fpsAvg,
      frameP50: frames.frameP50,
      frameP95: frames.frameP95,
      longestFrame: frames.longestFrame,
      droppedFrames: frames.droppedFrames,
      domRows,
      frames: frames.frames,
    };
  }, [sampler]);

  const run = useCallback(async () => {
    const streamFrames = await runStream();
    const w = window as unknown as { __commits?: number; __renderMs?: number };
    const scroll = await runScroll();
    const out: PerfResult = {
      mode: MODE,
      stream: {
        commits: w.__commits ?? 0,
        renderMs: w.__renderMs ?? 0,
        bubbleRenders: probeCount("MessageBubble"),
        fpsAvg: streamFrames.fpsAvg,
        frameP50: streamFrames.frameP50,
        frameP95: streamFrames.frameP95,
        longestFrame: streamFrames.longestFrame,
        frames: streamFrames.frames,
        deltaIntervalAvg: streamFrames.deltaIntervalAvg,
      },
      scroll,
    };
    setResult(out);
    setPhase("完成");
    window.__perfResult = out;
    // 诊断：窗口化状态（排查用）
    const el = scrollRef.current;
    const listEl = listRef.current;
    if (el && listEl) {
      out.diag = {
        heights: heightsRef.current.size,
        virtualized: winStateRef.current.virtualized ? 1 : 0,
        windowStart: winStateRef.current.start,
        windowPad: winStateRef.current.paddingTop,
        viewport: el.clientHeight,
        scrollTop: el.scrollTop,
        scrollTopEff: el.getBoundingClientRect().top - listEl.getBoundingClientRect().top,
        messages: messagesRef.current.length,
      };
      console.log("[perf diag]", JSON.stringify(out.diag));
    }
    window.__perfResult = { ...out };
  }, [runScroll, runStream]);

  useEffect(() => {
    let started = false;
    window.__perfStart = () => {
      if (started) return;
      started = true;
      window.__perfDone = run();
    };
    // 分阶段接口（外部 CDP 采样滚动期间 layout/style 成本）
    (window as unknown as { __perfStream?: () => Promise<unknown> }).__perfStream = async () => {
      const f = await runStream();
      const w = window as unknown as { __commits?: number; __renderMs?: number };
      return {
        commits: w.__commits ?? 0,
        renderMs: w.__renderMs ?? 0,
        bubbleRenders: probeCount("MessageBubble"),
        ...f,
      };
    };
    (window as unknown as { __perfScroll?: () => Promise<unknown> }).__perfScroll = () => runScroll();
    // 自动开始（?manual=1 可关，供外部 CDP 分阶段采样）
    const manual = new URLSearchParams(location.search).has("manual");
    const t = manual ? null : setTimeout(() => window.__perfStart?.(), 600);
    return () => {
      if (t) clearTimeout(t);
    };
  }, [run, runStream, runScroll]);

  const start = virtualized ? windowStart : 0;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 12px", borderBottom: "2px solid #333", fontFamily: "monospace" }}>
        <strong>chat 渲染性能实测</strong> | mode=<b>{MODE}</b> | {phase}
        {result && (
          <pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>
            {`流式(50 delta/s × 4s)：commit ${result.stream.commits} 次 | MessageBubble 渲染 ${result.stream.bubbleRenders} 次 | 渲染 ${result.stream.renderMs.toFixed(1)}ms | delta 间隔均值 ${result.stream.deltaIntervalAvg.toFixed(1)}ms | 帧数 ${result.stream.frames}
流式帧率 avg ${result.stream.fpsAvg.toFixed(1)}fps | p50 ${result.stream.frameP50.toFixed(1)}ms p95 ${result.stream.frameP95.toFixed(1)}ms | 最长帧 ${result.stream.longestFrame.toFixed(1)}ms
滚动(2s)：avg ${result.scroll.fpsAvg.toFixed(1)}fps | p50 ${result.scroll.frameP50.toFixed(1)}ms p95 ${result.scroll.frameP95.toFixed(1)}ms | 最长帧 ${result.scroll.longestFrame.toFixed(1)}ms | 掉帧 ${result.scroll.droppedFrames} | 帧数 ${result.scroll.frames} | DOM 消息行 ${result.scroll.domRows}`}
          </pre>
        )}
      </div>
      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto" }}>
        <div className="chat-stream">
          <div className="msg-list" ref={listRef}>
            {virtualized && windowPad > 0 && <div className="msg-window-pad" aria-hidden="true" style={{ height: windowPad }} />}
            {(virtualized ? messages.slice(start) : messages).map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onQuote={MODE === "before" ? () => undefined : undefined}
                measureRef={measureRef}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(
  <Profiler
    id="perf"
    onRender={(_id, _phase, actualDuration) => {
      // App 内部通过 ref 读取（避免重渲）
      (window as unknown as { __commits?: number }).__commits = ((window as unknown as { __commits?: number }).__commits ?? 0) + 1;
      (window as unknown as { __renderMs?: number }).__renderMs = ((window as unknown as { __renderMs?: number }).__renderMs ?? 0) + actualDuration;
    }}
  >
    <App />
  </Profiler>,
);
