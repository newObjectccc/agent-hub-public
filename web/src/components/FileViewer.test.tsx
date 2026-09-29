/**
 * 文件联动组件测试：工具卡片文件路径可点击 → FileRef 回调；文件弹层渲染行号；
 * 同文件有 diff 时提供"看 diff"跳转。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContentResult } from "../api/types";
import { FileLinkText } from "./FileLinkText";
import { FileViewer } from "./FileViewer";
import { ToolCallCard } from "./ToolCallCard";

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

describe("FileLinkText（文件路径识别为可点击）", () => {
  it("summary 里的 src/foo.ts:12 渲染成按钮并回传 FileRef", () => {
    const onOpenFile = vi.fn();
    const el = render(<FileLinkText text="读取 src/foo.ts:12 的内容" onOpenFile={onOpenFile} />);
    const btn = el.querySelector(".file-ref") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe("src/foo.ts:12");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "src/foo.ts", line: 12 }));
  });

  it("无引用/无回调时原样渲染文本，不产生按钮", () => {
    const el = render(<FileLinkText text="普通文本" onOpenFile={vi.fn()} />);
    expect(el.querySelector(".file-ref")).toBeNull();
    const el2 = render(<FileLinkText text="src/foo.ts" />);
    expect(el2.querySelector(".file-ref")).toBeNull();
    expect(el2.textContent).toBe("src/foo.ts");
  });
});

describe("ToolCallCard（工具调用卡片文件联动）", () => {
  it("summary 文件链接点击触发 onOpenFile 且不展开卡片", () => {
    const onOpenFile = vi.fn();
    const el = render(
      <ToolCallCard
        toolCall={{ name: "edit", summary: "修改 server/src/git.ts:12", status: "done", resultPreview: "ok" }}
        onOpenFile={onOpenFile}
      />,
    );
    const btn = el.querySelector(".file-ref") as HTMLButtonElement;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "server/src/git.ts", line: 12 }));
    // stopPropagation：不触发折叠
    expect(el.querySelector(".tool-body")).toBeNull();
  });

  it("展开后 resultPreview 中的文件路径也可点击", () => {
    const onOpenFile = vi.fn();
    const el = render(
      <ToolCallCard
        toolCall={{
          name: "read",
          summary: "read",
          status: "done",
          resultPreview: "查看 docs/API_CONTRACT.md 完毕",
        }}
        onOpenFile={onOpenFile}
      />,
    );
    act(() => {
      (el.querySelector(".tool-head") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const btn = el.querySelector(".tool-body .file-ref") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "docs/API_CONTRACT.md" }));
  });
});

describe("FileViewer（文件内容弹层）", () => {
  const fileResult: FileContentResult = {
    root: "/repo",
    path: "src/foo.ts",
    size: 42,
    truncated: false,
    content: "line one\nline two\nline three\n",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => fileResult,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("渲染文件内容 + 行号", async () => {
    const el = render(<FileViewer cwd="/repo" path="src/foo.ts" onClose={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.querySelector(".sheet-title")?.textContent).toBe("src/foo.ts");
    const lines = [...el.querySelectorAll(".code-line")];
    // "line one\nline two\nline three\n" → 3 行内容 + 1 个末尾空行
    expect(lines).toHaveLength(4);
    expect(lines[0].querySelector(".ln")?.textContent).toBe("1");
    expect(lines[1].querySelector(".lc")?.textContent).toBe("line two");
  });

  it("hasDiff=true 显示'看 diff'并跳转；false 不显示", async () => {
    const onViewDiff = vi.fn();
    const el = render(
      <FileViewer cwd="/repo" path="src/foo.ts" hasDiff onViewDiff={onViewDiff} onClose={() => {}} />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const btn = [...el.querySelectorAll(".sheet-head button")].find((b) => b.textContent === "看 diff");
    expect(btn).toBeTruthy();
    act(() => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onViewDiff).toHaveBeenCalledTimes(1);

    const el2 = render(<FileViewer cwd="/repo" path="src/foo.ts" onClose={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...el2.querySelectorAll(".sheet-head button")].some((b) => b.textContent === "看 diff")).toBe(false);
  });

  it("指定 line 高亮目标行", async () => {
    const el = render(<FileViewer cwd="/repo" path="src/foo.ts" line={2} onClose={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const hit = el.querySelector(".code-line.hit");
    expect(hit?.querySelector(".ln")?.textContent).toBe("2");
  });
});
