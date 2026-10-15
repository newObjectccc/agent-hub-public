/**
 * 驱动来源徽章（心理预期管理）：📱 面板驱动 / 🖥 终端驱动 / 缺省不渲染；
 * 阶段状态条（WaitStageBar）：阶段图标文案 + 秒级计时 + 阶段切换 key 重挂载。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrivenBadge } from "./DrivenBadge";
import { WaitStageBar } from "./WaitStageBar";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("DrivenBadge 驱动来源徽章", () => {
  it("panel → 📱 面板驱动（title 说明电脑端需重新载入会话）", () => {
    const el = render(<DrivenBadge drivenBy="panel" />);
    const badge = el.querySelector(".badge.driven-panel")!;
    expect(badge.textContent).toContain("📱");
    expect(badge.textContent).toContain("面板驱动");
    expect(badge.getAttribute("title")).toContain("重新打开该会话，载入新增消息");
  });

  it("terminal → 🖥 终端驱动；缺省/非法值不渲染", () => {
    const el = render(<DrivenBadge drivenBy="terminal" />);
    expect(el.querySelector(".badge.driven-terminal")!.textContent).toContain("🖥");
    expect(el.textContent).toContain("终端驱动");
    const empty = render(<DrivenBadge />);
    expect(empty.querySelector(".badge")).toBeNull();
    const undef = render(<DrivenBadge drivenBy={undefined} />);
    expect(undef.querySelector(".badge")).toBeNull();
  });

  it("320 窄屏防溢出：长文案套 .badge-text-long（窄屏隐藏挂钩类名）", () => {
    const el = render(<DrivenBadge drivenBy="panel" />);
    expect(el.querySelector(".badge-text-long")).not.toBeNull();
  });
});

describe("WaitStageBar 阶段化等待状态条", () => {
  it("phase=null 不渲染", () => {
    const el = render(<WaitStageBar phase={null} startedAt={null} />);
    expect(el.querySelector(".wait-stage-bar")).toBeNull();
  });

  it("🧠 思考中 + 计时秒级跳动（45s）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const el = render(<WaitStageBar phase="thinking" startedAt={1_000_000} />);
    expect(el.textContent).toContain("🧠");
    expect(el.textContent).toContain("思考中");
    expect(el.textContent).toContain("· 0s");
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(el.textContent).toContain("· 45s");
  });

  it("工具执行中/回复中/发送中各阶段文案；阶段切换带 fade-swap（key 重挂载）", () => {
    vi.useFakeTimers();
    const el = render(<WaitStageBar phase="tool" startedAt={Date.now()} />);
    expect(el.textContent).toContain("🔧");
    expect(el.textContent).toContain("工具执行中");
    expect(el.querySelector(".wait-stage.fade-swap")).not.toBeNull();

    act(() => {
      root!.render(<WaitStageBar phase="replying" startedAt={Date.now()} />);
    });
    expect(el.textContent).toContain("✍️");
    expect(el.textContent).toContain("回复中");

    act(() => {
      root!.render(<WaitStageBar phase="sending" startedAt={Date.now()} />);
    });
    expect(el.textContent).toContain("发送中");
  });

  it("断线追加提示（信息不丢）", () => {
    const el = render(<WaitStageBar phase="thinking" startedAt={Date.now()} disconnected />);
    expect(el.textContent).toContain("连接断开");
  });
});
