/**
 * 消息渲染 memo 回归（长会话滚动/相邻消息更新不重渲全部历史）：
 * 1. MessageBubble：props 不变时父级重渲 → 不渲染（React.memo 拦截）
 * 2. message 引用变化（该条流式更新）时才渲染
 * 3. Markdown：text 不变不重复解析/渲染；text 变化才渲染
 * 4. ToolCallCard：toolCall 引用不变不重渲；变化才渲染
 *
 * 渲染次数用 utils/renderProbe 插桩统计（dev/test 专用，生产构建消除）。
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMessage, ToolCall } from "../api/types";
import { probeCount, probeReset } from "../utils/renderProbe";
import { MessageBubble } from "./MessageBubble";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let harnessForce: (() => void) | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  harnessForce = null;
});

beforeEach(() => {
  probeReset();
});

function message(over: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "m1",
    role: "assistant",
    timestamp: 1,
    text: "你好",
    thinking: null,
    toolCalls: [],
    ...over,
  };
}

function toolCall(over: Partial<ToolCall> = {}): ToolCall {
  return { name: "Read", summary: "src/a.ts", status: "done", resultPreview: null, ...over };
}

/** 可强制父级重渲的壳（子元素由外部控制，模拟"相邻消息更新导致父级重渲"） */
function Harness({ children }: { children: React.ReactNode }) {
  const [, force] = useState(0);
  harnessForce = () => force((n) => n + 1);
  return <>{children}</>;
}

function renderWith(children: (key: number) => React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness>{children(0)}</Harness>);
  });
}

function rerender(children: (key: number) => React.ReactNode): void {
  act(() => {
    root!.render(<Harness>{children(1)}</Harness>);
  });
}

describe("消息组件 React.memo（历史消息不随相邻更新重渲）", () => {
  it("MessageBubble：props 不变时父级重渲 → 不渲染；message 变化 → 渲染", () => {
    const msg = message();
    renderWith(() => <MessageBubble message={msg} onQuote={() => undefined} />);
    const afterMount = probeCount("MessageBubble");

    // 父级重渲（相邻消息更新引起的整页重渲）：memo 拦截，不重渲
    act(() => {
      harnessForce?.();
      harnessForce?.();
    });
    expect(probeCount("MessageBubble")).toBe(afterMount);

    // 该条消息本身变化（流式更新）→ 重渲一次
    rerender(() => <MessageBubble message={{ ...msg, text: "你好呀" }} onQuote={() => undefined} />);
    expect(probeCount("MessageBubble")).toBe(afterMount + 1);
  });

  it("MessageBubble：onQuote/onOpenFile handler 引用变化会击穿 memo（handler 须稳定）", () => {
    const msg = message();
    renderWith(() => <MessageBubble message={msg} onQuote={() => undefined} />);
    const afterMount = probeCount("MessageBubble");
    rerender(() => <MessageBubble message={msg} onQuote={() => undefined} />);
    // 新建的箭头函数引用不同 → 重渲（文档化 ChatPage 用 useCallback 稳定 handler 的原因）
    expect(probeCount("MessageBubble")).toBe(afterMount + 1);
  });

  it("Markdown：text 不变不渲染（解析结果 useMemo 缓存）；text 变化才渲染", () => {
    renderWith(() => <Markdown text="# 标题" />);
    const afterMount = probeCount("Markdown");
    act(() => {
      harnessForce?.();
    });
    expect(probeCount("Markdown")).toBe(afterMount);
    rerender(() => <Markdown text="# 新标题" />);
    expect(probeCount("Markdown")).toBe(afterMount + 1);
  });

  it("ToolCallCard：toolCall 引用不变不渲染；变化才渲染", () => {
    const tc = toolCall();
    renderWith(() => <ToolCallCard toolCall={tc} />);
    const afterMount = probeCount("ToolCallCard");
    act(() => {
      harnessForce?.();
    });
    expect(probeCount("ToolCallCard")).toBe(afterMount);
    rerender(() => <ToolCallCard toolCall={{ ...tc, status: "running" }} />);
    expect(probeCount("ToolCallCard")).toBe(afterMount + 1);
  });
});

/**
 * 图片加载失败恢复布局（.img-error）：不永留 16:10 占位。
 */
describe("图片 load/error 状态标记（占位防跳动 + 失败恢复布局）", () => {
  it("MessageBubble 图片 load → img-loaded", () => {
    renderWith(() => <MessageBubble message={message({ images: [{ url: "https://x.test/a.png", alt: "图" }] })} />);
    const img = container!.querySelector<HTMLImageElement>("img.msg-img");
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event("load"));
    });
    expect(img!.classList.contains("img-loaded")).toBe(true);
  });

  it("MessageBubble 图片 error → img-error（撤掉占位，不永留 16:10）", () => {
    renderWith(() => <MessageBubble message={message({ images: [{ url: "https://x.test/a.png", alt: "图" }] })} />);
    const img = container!.querySelector<HTMLImageElement>("img.msg-img");
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(img!.classList.contains("img-error")).toBe(true);
    expect(img!.classList.contains("img-loaded")).toBe(false);
  });

  it("Markdown 图片 error（捕获委托）→ img-error；后续 load → img-loaded", () => {
    renderWith(() => <Markdown text={"![图](https://x.test/a.png)"} />);
    const img = container!.querySelector<HTMLImageElement>("img.md-img");
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(img!.classList.contains("img-error")).toBe(true);
    act(() => {
      img!.classList.remove("img-error");
      img!.dispatchEvent(new Event("load"));
    });
    expect(img!.classList.contains("img-loaded")).toBe(true);
  });
});

/**
 * 渲染性能对比（memo 前后）：200 条消息会话 + 相邻消息流式更新 20 次。
 * before（改造前无 memo）用不稳定 handler 击穿 memo 模拟：每次父级重渲全部历史重渲。
 */
describe("消息列表渲染性能对比（memo 前后）", () => {
  function bench(breakMemo: boolean): { renders: number; wallMs: number } {
    probeReset();
    const msgs: SessionMessage[] = [];
    for (let i = 0; i < 200; i += 1) msgs.push(message({ id: `m${i}`, text: `消息 ${i} 内容` }));
    const stableQuote = () => undefined;
    let bump!: (n: number) => void;
    function Host() {
      const [n, setN] = useState(0);
      bump = setN;
      return (
        <>
          {msgs.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={i === 199 ? { ...m, text: `消息 ${i} 内容 ${n}` } : m}
              onQuote={breakMemo ? () => undefined : stableQuote}
            />
          ))}
        </>
      );
    }
    renderWith(() => <Host />);
    const baseline = probeCount("MessageBubble");
    const start = performance.now();
    for (let n = 1; n <= 20; n += 1) {
      act(() => {
        bump(n);
      });
    }
    return { renders: probeCount("MessageBubble") - baseline, wallMs: performance.now() - start };
  }

  it("相邻消息更新 20 次：memo 拦截后仅变化条重渲，无 memo 则全部历史重渲", () => {
    const before = bench(true); // 无 memo（改造前）：不稳定 handler 击穿
    act(() => {
      root?.unmount();
    });
    const after = bench(false); // memo 生效（改造后）：稳定 handler
    console.log(
      `[perf] 200 条消息会话 + 相邻消息更新 20 次（jsdom）| ` +
        `MessageBubble 渲染：改造前 ${before.renders} 次 → 改造后 ${after.renders} 次（${(before.renders / Math.max(1, after.renders)).toFixed(0)}x ↓）| ` +
        `耗时：${before.wallMs.toFixed(1)}ms → ${after.wallMs.toFixed(1)}ms`,
    );
    expect(after.renders).toBe(20); // 20 次更新 × 1 条变化消息
    expect(before.renders).toBe(20 * 200); // 每次更新全部历史重渲
    expect(after.renders).toBeLessThan(before.renders / 50);
  });
});
