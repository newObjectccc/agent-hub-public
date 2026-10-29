/**
 * HostRequestCard（hub 驱动接管的手机批权限卡片）：
 * 渲染标题/详情折叠、允许/拒绝回调、应答中禁用、超时灰显。
 */
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { HostRequestCard } from "./HostRequestCard";
import type { HostRequestDto } from "../api/types";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const request: HostRequestDto = {
  id: "call_1",
  sessionId: "s1",
  kind: "permission",
  title: "Bash: rm -rf build",
  detail: '{"command":"rm -rf build"}',
  toolName: "Bash",
  allowAlways: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

async function render(props: Partial<React.ComponentProps<typeof HostRequestCard>> = {}) {
  const onRespond = props.onRespond ?? vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <HostRequestCard request={props.request ?? request} respondingId={props.respondingId ?? null} onRespond={onRespond} />,
    );
  });
  return { container, onRespond, unmount: () => root.unmount() };
}

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("HostRequestCard", () => {
  it("渲染标题与工具入参，点允许/拒绝触发回调", async () => {
    const { container, onRespond, unmount } = await render();
    expect(container.textContent).toContain("需要你批准");
    expect(container.textContent).toContain("Bash: rm -rf build");

    click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "允许") ?? null);
    expect(onRespond).toHaveBeenCalledWith("call_1", { outcome: "allow" });
    click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "拒绝") ?? null);
    expect(onRespond).toHaveBeenCalledWith("call_1", { outcome: "deny" });
    unmount();
  });

  it("详情折叠展开/收起", async () => {
    const { container, unmount } = await render();
    expect(container.querySelector(".host-request-detail")).toBeNull();
    click(container.querySelector(".host-request-detail-toggle"));
    expect(container.querySelector(".host-request-detail")?.textContent).toContain("rm -rf build");
    click(container.querySelector(".host-request-detail-toggle"));
    expect(container.querySelector(".host-request-detail")).toBeNull();
    unmount();
  });

  it("应答中（respondingId 命中）按钮禁用", async () => {
    const { container, unmount } = await render({ respondingId: "call_1" });
    const allow = container.querySelector<HTMLButtonElement>(".host-request-btn.allow");
    expect(allow).not.toBeNull();
    expect(allow!.disabled).toBe(true);
    expect(container.textContent).toContain("提交中");
    unmount();
  });

  it("已过期：灰显 + 禁用 + 提示（服务端自动拒绝）", async () => {
    const expired: HostRequestDto = { ...request, expiresAt: Date.now() - 1000 };
    const { container, onRespond, unmount } = await render({ request: expired });
    expect(container.querySelector(".host-request.expired")).not.toBeNull();
    expect(container.textContent).toContain("自动拒绝");
    const allow = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("允许"));
    click(allow ?? null);
    expect(onRespond).not.toHaveBeenCalled();
    unmount();
  });
});

/* ===== 问答卡片（kind === "question"：Codex 工具提问 / MCP elicitation） ===== */

const questionRequest: HostRequestDto = {
  id: "call_q",
  sessionId: "s1",
  kind: "question",
  title: "MCP 需要你的输入",
  detail: null,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  questions: [
    {
      id: "q1",
      header: "部署环境",
      question: "部署到哪个环境？",
      options: [
        { label: "测试环境", description: "不影响线上" },
        { label: "生产环境", description: null },
      ],
    },
    {
      id: "q2",
      header: null,
      question: "还有什么要备注的吗？",
      options: null,
    },
  ],
};

function typeInto(el: Element | null, value: string): void {
  expect(el).not.toBeNull();
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement | undefined) ?? null;
}

describe("HostRequestCard 问答卡片（kind=question）", () => {
  it("渲染题目/选项/输入框", async () => {
    const { container, unmount } = await render({ request: questionRequest });
    expect(container.textContent).toContain("MCP 需要你的输入");
    expect(container.textContent).toContain("部署环境");
    expect(container.textContent).toContain("部署到哪个环境？");
    expect(container.textContent).toContain("测试环境");
    expect(container.textContent).toContain("不影响线上");
    expect(container.textContent).toContain("还有什么要备注的吗？");
    const inputs = container.querySelectorAll<HTMLInputElement>(".host-request-q-input");
    expect(inputs.length).toBe(2);
    expect(inputs[0].placeholder).toBe("或输入你的回答");
    expect(container.textContent).toContain("提交回答");
    expect(container.textContent).toContain("拒绝回答");
    unmount();
  });

  it("点选项 + 提交 → 回调收到 { answers: { qid: [label] } }", async () => {
    const { container, onRespond, unmount } = await render({ request: questionRequest });
    click(buttonByText(container, "测试环境不影响线上"));
    click(buttonByText(container, "提交回答"));
    expect(onRespond).toHaveBeenCalledWith("call_q", { answers: { q1: ["测试环境"] } });
    unmount();
  });

  it("自定义文本优先于选项", async () => {
    const { container, onRespond, unmount } = await render({ request: questionRequest });
    click(buttonByText(container, "生产环境"));
    typeInto(container.querySelectorAll(".host-request-q-input")[0], "灰度发布");
    click(buttonByText(container, "提交回答"));
    expect(onRespond).toHaveBeenCalledWith("call_q", { answers: { q1: ["灰度发布"] } });
    unmount();
  });

  it("全部未答时不能提交", async () => {
    const { container, onRespond, unmount } = await render({ request: questionRequest });
    const submit = buttonByText(container, "提交回答");
    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(true);
    click(submit);
    expect(onRespond).not.toHaveBeenCalled();
    expect(container.textContent).toContain("至少回答一题");
    unmount();
  });

  it("拒绝回答 → { outcome: deny }", async () => {
    const { container, onRespond, unmount } = await render({ request: questionRequest });
    click(buttonByText(container, "拒绝回答"));
    expect(onRespond).toHaveBeenCalledWith("call_q", { outcome: "deny" });
    unmount();
  });

  it("options 为 null 的题只显示输入框", async () => {
    const { container, unmount } = await render({ request: questionRequest });
    const blocks = Array.from(container.querySelectorAll(".host-request-q"));
    expect(blocks.length).toBe(2);
    const freeText = blocks[1];
    expect(freeText.querySelector(".host-request-q-options")).toBeNull();
    expect(freeText.querySelector(".host-request-q-input")).not.toBeNull();
    // 仅答自由文本题也可提交，答案进 q2
    typeInto(freeText.querySelector(".host-request-q-input"), "请加快上线");
    const submit = buttonByText(container, "提交回答");
    expect(submit!.disabled).toBe(false);
    unmount();
  });

  it("提交失败：回调抛错 → 卡片保留 + 内联报错 + 输入不丢", async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error("网络错误"));
    const { container, unmount } = await render({ request: questionRequest, onRespond });
    click(buttonByText(container, "测试环境不影响线上"));
    click(buttonByText(container, "提交回答"));
    await act(async () => {});
    expect(container.textContent).toContain("网络错误");
    // 输入保留，可重试
    const selected = container.querySelector(".host-request-q-option.selected");
    expect(selected).not.toBeNull();
    click(buttonByText(container, "提交回答"));
    expect(onRespond).toHaveBeenCalledTimes(2);
    unmount();
  });
});
