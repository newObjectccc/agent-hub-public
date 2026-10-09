/**
 * 新建会话 sheet 测试：source 分段单选、cwd 绝对路径校验、最近目录下拉点选、
 * 提交参数（cwd/name/source）与成功回调（跳转由页面负责）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSource, SessionSummary } from "../api/types";
import { api } from "../api/client";
import { isAbsoluteCwd, NewSessionForm } from "./NewSessionForm";

vi.mock("../api/client", () => ({
  api: {
    createSession: vi.fn(async (cwd: string, name?: string, source?: SessionSource) => ({
      session: {
        id: "new-1",
        source: source ?? "pi",
        name: name ?? "",
        cwd,
        updatedAt: "2026-02-18T12:00:00.000Z",
        messageCount: 0,
        status: "idle",
        lastUserMessage: null,
        lastAssistantMessage: null,
        sessionFile: "/tmp/new-1.jsonl",
        isSubAgent: false,
      } satisfies SessionSummary,
    })),
  },
}));

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

function click(el: Element | null): void {
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function type(el: Element | null, value: string): void {
  act(() => {
    const input = el as HTMLInputElement;
    // React 受控输入：必须走原生 value setter，否则 onChange 不触发
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.mocked(api.createSession).mockClear();
});

describe("isAbsoluteCwd", () => {
  it("POSIX / Windows 盘符为绝对路径，其余不是", () => {
    expect(isAbsoluteCwd("/Users/me/Workspace/x")).toBe(true);
    expect(isAbsoluteCwd("/tmp")).toBe(true);
    expect(isAbsoluteCwd("C:\\work\\x")).toBe(true);
    expect(isAbsoluteCwd("relative/path")).toBe(false);
    expect(isAbsoluteCwd("")).toBe(false);
  });
});

describe("NewSessionForm（新建会话 sheet）", () => {
  it("渲染 source 分段单选（pi / claude / Codex），默认 pi", () => {
    const el = render(<NewSessionForm open onClose={() => undefined} onCreated={() => undefined} />);
    const radios = el.querySelectorAll<HTMLButtonElement>(".segment-item");
    expect(radios.length).toBe(3);
    expect(radios[0].textContent).toContain("pi");
    expect(radios[1].textContent).toContain("claude");
    expect(radios[2].textContent).toContain("Codex");
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[1].getAttribute("aria-checked")).toBe("false");
    expect(radios[2].getAttribute("aria-checked")).toBe("false");
  });

  it("点选 claude 分段 → aria-checked 切换", () => {
    const el = render(<NewSessionForm open onClose={() => undefined} onCreated={() => undefined} />);
    const radios = el.querySelectorAll<HTMLButtonElement>(".segment-item");
    click(radios[1]);
    const after = el.querySelectorAll<HTMLButtonElement>(".segment-item");
    expect(after[1].getAttribute("aria-checked")).toBe("true");
    expect(after[0].getAttribute("aria-checked")).toBe("false");
  });

  it("cwd 非绝对路径 → 报错且不调 API", async () => {
    const el = render(<NewSessionForm open onClose={() => undefined} onCreated={() => undefined} />);
    type(el.querySelector('input[aria-label="工作目录"]'), "relative/path");
    click(el.querySelector(".sheet-foot button"));
    expect(el.querySelector(".error-text")?.textContent).toContain("cwd 必须是绝对路径");
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("cwd 为空 → 提示填写，不调 API", () => {
    const el = render(<NewSessionForm open onClose={() => undefined} onCreated={() => undefined} />);
    click(el.querySelector(".sheet-foot button"));
    expect(el.querySelector(".error-text")?.textContent).toContain("请填写工作目录");
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("最近使用目录下拉：点选填入输入框", () => {
    const el = render(
      <NewSessionForm
        open
        onClose={() => undefined}
        onCreated={() => undefined}
        recentCwds={["/Users/me/Workspace/a", "/Users/me/Workspace/b"]}
      />,
    );
    click(Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "最近") ?? null);
    const items = el.querySelectorAll<HTMLButtonElement>(".cwd-recent-item");
    expect(items.length).toBe(2);
    click(items[1]);
    const input = el.querySelector('input[aria-label="工作目录"]') as HTMLInputElement;
    expect(input.value).toBe("/Users/me/Workspace/b");
    expect(el.querySelector(".cwd-recent")).toBeNull();
  });

  it("最近目录去重（同路径只出现一次）", () => {
    const el = render(
      <NewSessionForm
        open
        onClose={() => undefined}
        onCreated={() => undefined}
        recentCwds={["/x", "/x", "/y", ""]}
      />,
    );
    click(Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "最近") ?? null);
    expect(el.querySelectorAll(".cwd-recent-item").length).toBe(2);
  });

  it("合法提交 → api.createSession(cwd, name, source) 且 onCreated 收到新会话", async () => {
    const created: SessionSummary[] = [];
    const el = render(
      <NewSessionForm open onClose={() => undefined} onCreated={(s) => created.push(s)} />,
    );
    click(el.querySelectorAll<HTMLButtonElement>(".segment-item")[1]);
    type(el.querySelector('input[aria-label="工作目录"]'), "/Users/me/Workspace/demo");
    type(el.querySelector('input[aria-label="会话名称"]'), "我的会话");
    click(el.querySelector(".sheet-foot button"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.createSession).toHaveBeenCalledWith("/Users/me/Workspace/demo", "我的会话", "claude");
    expect(created.length).toBe(1);
    expect(created[0].id).toBe("new-1");
    expect(created[0].source).toBe("claude");
  });

  it("open=false 不渲染 sheet", () => {
    const el = render(<NewSessionForm open={false} onClose={() => undefined} onCreated={() => undefined} />);
    expect(el.querySelector(".sheet")).toBeNull();
  });
});
