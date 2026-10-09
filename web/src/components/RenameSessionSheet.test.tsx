/**
 * 重命名会话 sheet 测试：当前名预填、保存调 api.renameSession + onRenamed 刷新回调、
 * 清空提交 = 去掉名字（空串透传）、失败内联报错、取消关闭。
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import { api } from "../api/client";
import { RenameSessionSheet } from "./RenameSessionSheet";

vi.mock("../api/client", () => ({
  api: {
    renameSession: vi.fn(async (id: string, name: string) => ({
      session: {
        id,
        source: "pi",
        name: name === "" ? null : name,
        cwd: "/tmp/demo",
        updatedAt: "2026-02-18T12:00:00.000Z",
        messageCount: 0,
        status: "idle",
        lastUserMessage: null,
        lastAssistantMessage: null,
        sessionFile: "/tmp/demo/s1.jsonl",
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

/** 键盘闭环 harness：外部 opener 打开 sheet，验证焦点进/环/还全链路 */
function KeyboardHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="opener" onClick={() => setOpen(true)}>
        打开
      </button>
      <RenameSessionSheet
        open={open}
        sessionId="s1"
        currentName="旧名"
        onClose={() => setOpen(false)}
        onRenamed={() => undefined}
      />
    </>
  );
}

function findButton(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label) ?? null
  );
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.mocked(api.renameSession).mockClear();
});

describe("RenameSessionSheet（重命名会话 sheet）", () => {
  it("open=false 不渲染；open 时预填当前名", () => {
    const closed = render(
      <RenameSessionSheet open={false} sessionId="s1" currentName="旧名" onClose={() => undefined} onRenamed={() => undefined} />,
    );
    expect(closed.querySelector(".sheet")).toBeNull();

    const el = render(
      <RenameSessionSheet open sessionId="s1" currentName="旧名" onClose={() => undefined} onRenamed={() => undefined} />,
    );
    const input = el.querySelector<HTMLInputElement>('input[aria-label="会话名称"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe("旧名");
  });

  it("保存 → api.renameSession(id, 新名) 调用一次且 onRenamed 拿到更新后的会话（页头/列表刷新）", async () => {
    const onRenamed = vi.fn();
    const el = render(
      <RenameSessionSheet open sessionId="s1" currentName="旧名" onClose={() => undefined} onRenamed={onRenamed} />,
    );
    type(el.querySelector('input[aria-label="会话名称"]'), "  新名字  ");
    await act(async () => {
      click(findButton(el, "保存"));
    });
    expect(api.renameSession).toHaveBeenCalledTimes(1);
    expect(api.renameSession).toHaveBeenCalledWith("s1", "新名字"); // trim 后提交
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(onRenamed.mock.calls[0][0]).toMatchObject({ id: "s1", name: "新名字" });
  });

  it("清空提交 = 去掉名字（空串透传，onRenamed 收到 name=null）", async () => {
    const onRenamed = vi.fn();
    const el = render(
      <RenameSessionSheet open sessionId="s1" currentName="旧名" onClose={() => undefined} onRenamed={onRenamed} />,
    );
    type(el.querySelector('input[aria-label="会话名称"]'), "");
    await act(async () => {
      click(findButton(el, "保存"));
    });
    expect(api.renameSession).toHaveBeenCalledWith("s1", "");
    expect(onRenamed.mock.calls[0][0]).toMatchObject({ id: "s1", name: null });
  });

  it("保存失败 → 内联错误提示，不回调 onRenamed", async () => {
    vi.mocked(api.renameSession).mockRejectedValueOnce(new Error("会话不存在: s1"));
    const onRenamed = vi.fn();
    const el = render(
      <RenameSessionSheet open sessionId="s1" currentName="旧名" onClose={() => undefined} onRenamed={onRenamed} />,
    );
    await act(async () => {
      click(findButton(el, "保存"));
    });
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("会话不存在");
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("取消 → onClose 调用，不发请求", () => {
    const onClose = vi.fn();
    const el = render(
      <RenameSessionSheet open sessionId="s1" currentName="旧名" onClose={onClose} onRenamed={() => undefined} />,
    );
    click(findButton(el, "取消"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.renameSession).not.toHaveBeenCalled();
  });

  describe("键盘闭环（useFocusTrap 覆盖 RenameSessionSheet）", () => {
    function sheetFocusables(el: HTMLElement): HTMLElement[] {
      return [...el.querySelectorAll<HTMLElement>(".sheet button, .sheet input")];
    }

    it("打开后焦点进入弹层内；Esc 关闭且焦点归还打开前的 opener", () => {
      const el = render(<KeyboardHarness />);
      const opener = el.querySelector<HTMLButtonElement>(".opener")!;
      act(() => {
        opener.focus();
      });
      click(opener);
      const input = el.querySelector<HTMLInputElement>('input[aria-label="会话名称"]')!;
      // 初始焦点已被带进弹层（不留在 opener）
      expect(document.activeElement).not.toBe(opener);
      expect(el.querySelector(".sheet")!.contains(document.activeElement)).toBe(true);

      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(el.querySelector(".sheet")).toBeNull();
      expect(document.activeElement).toBe(opener);
    });

    it("Tab 闭环：焦点在弹层末尾按 Tab 循环回首，不跑到弹层外", () => {
      const el = render(<KeyboardHarness />);
      click(el.querySelector(".opener"));
      const items = sheetFocusables(el);
      expect(items.length).toBeGreaterThan(2);
      const first = items[0];
      const last = items[items.length - 1];
      act(() => {
        last.focus();
      });
      const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      act(() => {
        document.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
    });

    it("Shift+Tab 反向循环：焦点在弹层首个按 Shift+Tab 跳到末尾", () => {
      const el = render(<KeyboardHarness />);
      click(el.querySelector(".opener"));
      const items = sheetFocusables(el);
      const first = items[0];
      const last = items[items.length - 1];
      act(() => {
        first.focus();
      });
      const ev = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      act(() => {
        document.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it("关闭按钮与页头按钮均有可访问名（aria-label）", () => {
      const el = render(
        <RenameSessionSheet open sessionId="s1" currentName="旧名" onClose={() => undefined} onRenamed={() => undefined} />,
      );
      const closeBtn = el.querySelector<HTMLButtonElement>(".sheet-close");
      expect(closeBtn!.getAttribute("aria-label")).toBe("关闭");
      // 页脚按钮均有可见文本兜底
      for (const b of el.querySelectorAll<HTMLButtonElement>(".sheet-foot button")) {
        expect((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()).not.toBe("");
      }
    });
  });
});
