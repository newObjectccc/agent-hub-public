/**
 * 对话导航条组件回归（K1，Codex 风格刻度时间线）：
 * 1. 每条消息一个刻度：数量对、aria 标签含序号/角色/标题、长度按内容量映射
 * 2. 点击刻度 → onJump(消息 id)（会话页负责滚动定位）
 * 3. 聚焦刻度 → 预览卡（标题 + 序号元信息）；失焦 → 隐藏
 * 4. 视口指示器按滚动几何映射 top/height 百分比
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../api/types";
import { ConversationNav } from "./ConversationNav";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let scrollEl: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  scrollEl?.remove();
  document.body.querySelectorAll(".chat-nav-preview").forEach((el) => el.remove());
  root = null;
  container = null;
  scrollEl = null;
});

function msg(id: string, text: string, over: Partial<SessionMessage> = {}): SessionMessage {
  return { id, role: "assistant", timestamp: 1700000000000, text, toolCalls: [], ...over };
}

/** jsdom 无布局：mock 滚动容器几何（指示器比例计算用） */
function makeScrollEl(geo: { scrollTop: number; scrollHeight: number; clientHeight: number }): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: geo.scrollTop, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: geo.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: geo.clientHeight, configurable: true });
  document.body.appendChild(el);
  return el;
}

function renderNav(
  messages: SessionMessage[],
  onJump: (id: string) => void,
  geo = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
): void {
  scrollEl = makeScrollEl(geo);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ConversationNav messages={messages} scrollRef={{ current: scrollEl }} onJump={onJump} />,
    );
  });
}

function ticks(): HTMLElement[] {
  return Array.from(container!.querySelectorAll<HTMLElement>(".chat-nav-tick"));
}

describe("ConversationNav 刻度时间线", () => {
  it("每条消息一个刻度；aria 标签含序号/角色/标题；空列表不渲染", () => {
    renderNav([msg("a", "第一句。其余摘要"), msg("b", "第二句", { role: "user" })], vi.fn());
    const els = ticks();
    expect(els).toHaveLength(2);
    expect(els[0].getAttribute("aria-label")).toContain("第 1 条");
    expect(els[0].getAttribute("aria-label")).toContain("助手");
    expect(els[0].getAttribute("aria-label")).toContain("第一句");
    expect(els[1].getAttribute("aria-label")).toContain("你");

    act(() => {
      root!.render(<ConversationNav messages={[]} scrollRef={{ current: scrollEl }} onJump={vi.fn()} />);
    });
    expect(container!.querySelector(".chat-nav")).toBeNull();
  });

  it("点击刻度 → onJump(消息 id)", () => {
    const onJump = vi.fn();
    renderNav([msg("a", "一"), msg("b", "二"), msg("c", "三")], onJump);
    act(() => {
      ticks()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("b");
  });

  it("刻度长度按内容量映射（长消息刻度更长）", () => {
    renderNav([msg("a", "短"), msg("b", "长".repeat(800))], vi.fn());
    const short = ticks()[0].querySelector<HTMLElement>(".chat-nav-dash")!;
    const long = ticks()[1].querySelector<HTMLElement>(".chat-nav-dash")!;
    expect(parseFloat(long.style.width)).toBeGreaterThan(parseFloat(short.style.width));
  });

  it("聚焦刻度 → 预览卡（标题 + 序号）；失焦 → 隐藏", () => {
    renderNav([msg("a", "为什么不实现呢？看板视图切换"), msg("b", "二")], vi.fn());
    act(() => {
      ticks()[0].dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const card = document.body.querySelector(".chat-nav-preview");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("为什么不实现呢？");
    expect(card!.textContent).toContain("第 1/2 条");

    act(() => {
      ticks()[0].dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(document.body.querySelector(".chat-nav-preview")).toBeNull();
  });

  it("视口指示器：视口中心定位 + 高度 clamp 细线", () => {
    renderNav([msg("a", "一"), msg("b", "二")], vi.fn(), {
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 500,
    });
    const thumb = container!.querySelector<HTMLElement>(".chat-nav-thumb")!;
    // 视口区域 top 25% + 高 25% → 中心 37.5%
    expect(thumb.style.top).toBe("37.5%");
    // 高度按几何比例但 clamp 到 [3px, 28px] 细线
    expect(thumb.style.height).toBe("clamp(3px, 25%, 28px)");
  });
});
