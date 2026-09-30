/**
 * 子代理活动面板（反馈轮 3 #4）：
 * 1. 无子代理不渲染；有则显示活动卡（🤖 名字 / ⏱ 时长 / 正在执行 / 最新输出）
 * 2. 完成卡片转「✅ 完成，点击查看结果」+ 结果摘要
 * 3. 点击卡片展开详情 + 「查看完整会话」跳转回调
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubAgentActivity } from "../api/types";
import { SubAgentPanel } from "./SubAgentPanel";

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
});

function agent(over: Partial<SubAgentActivity> = {}): SubAgentActivity {
  return {
    sessionId: "sub-1",
    name: "developer#abc123",
    status: "running",
    currentTool: "bash grep -n foo",
    toolRunning: true,
    lastOutput: "正在分析根因…",
    startedAt: Date.now() - 25_000,
    updatedAt: Date.now(),
    done: false,
    resultSummary: null,
    ...over,
  };
}

describe("SubAgentPanel 子代理活动面板", () => {
  it("无子代理不渲染", () => {
    const el = render(<SubAgentPanel agents={[]} onOpenSession={() => {}} />);
    expect(el.querySelector(".subagent-panel")).toBeNull();
  });

  it("进行中卡片：🤖 名字 + 运行时长 + 正在执行工具 + 最新输出摘要", () => {
    const el = render(<SubAgentPanel agents={[agent()]} onOpenSession={() => {}} />);
    expect(el.querySelector(".subagent-panel")).not.toBeNull();
    expect(el.querySelector(".subagent-name")?.textContent).toContain("developer#abc123");
    expect(el.querySelector(".subagent-elapsed")?.textContent).toMatch(/⏱ \d+:\d\d/);
    expect(el.querySelector(".subagent-tool")?.textContent).toContain("正在执行：");
    expect(el.querySelector(".subagent-tool-text")?.textContent).toContain("bash grep -n foo");
    expect(el.querySelector(".subagent-output-text")?.textContent).toContain("正在分析根因…");
  });

  it("多个子代理堆叠显示（并行回合各自一张卡）", () => {
    const el = render(
      <SubAgentPanel
        agents={[agent(), agent({ sessionId: "sub-2", name: "tester#def456", done: true, status: "idle", resultSummary: "全部通过" })]}
        onOpenSession={() => {}}
      />,
    );
    expect(el.querySelectorAll(".subagent-card")).toHaveLength(2);
    const done = el.querySelector(".subagent-card.done");
    expect(done?.textContent).toContain("✅ 完成，点击查看结果");
    expect(done?.textContent).toContain("全部通过");
  });

  it("点击卡片展开详情，「查看完整会话」回调子代理会话 id", () => {
    const onOpenSession = vi.fn();
    const el = render(<SubAgentPanel agents={[agent()]} onOpenSession={onOpenSession} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".subagent-head")!.click();
    });
    expect(el.querySelector(".subagent-detail")).not.toBeNull();
    act(() => {
      const buttons = el.querySelectorAll<HTMLButtonElement>(".subagent-detail button");
      buttons[buttons.length - 1].click();
    });
    expect(onOpenSession).toHaveBeenCalledWith("sub-1");
  });

  it("面板可折叠（默认展开）", () => {
    const el = render(<SubAgentPanel agents={[agent()]} onOpenSession={() => {}} />);
    expect(el.querySelector(".subagent-card")).not.toBeNull();
    act(() => {
      el.querySelector<HTMLButtonElement>(".subagent-panel-toggle")!.click();
    });
    expect(el.querySelector(".subagent-card")).toBeNull();
    act(() => {
      el.querySelector<HTMLButtonElement>(".subagent-panel-toggle")!.click();
    });
    expect(el.querySelector(".subagent-card")).not.toBeNull();
  });

  it("长会话收敛：进行中全显，已完成只留最近 3 个，其余进“点击展开”", () => {
    const done = Array.from({ length: 8 }, (_, i) =>
      agent({
        sessionId: `done-${i}`,
        name: `developer#done${i}`,
        done: true,
        status: "idle",
        resultSummary: `结果 ${i}`,
        updatedAt: 1000 + i,
      }),
    );
    const el = render(<SubAgentPanel agents={[agent(), ...done]} onOpenSession={() => {}} />);
    // 进行中 1 + 最近完成 3
    expect(el.querySelectorAll(".subagent-card")).toHaveLength(4);
    const more = el.querySelector<HTMLButtonElement>(".subagent-more");
    expect(more?.textContent).toContain("还有 5 个已完成");
    act(() => {
      more!.click();
    });
    expect(el.querySelectorAll(".subagent-card")).toHaveLength(9);
  });
});
