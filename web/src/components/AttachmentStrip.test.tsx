/**
 * 附件预览条（d-polish 手机手感回归）：
 * 1. 无附件不渲染；有附件渲染 chip + 删除按钮（.attach-remove 是触控热区外扩选择器挂钩，防类名回归）
 * 2. 点击删除按钮回调 onRemove（id 对应）
 * 3. 图片缩略图 / 文件图标两种形态
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../utils/uploads";
import { AttachmentStrip } from "./AttachmentStrip";

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

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "a1",
    name: "photo.png",
    path: "uploads/photo.png",
    mimeType: "image/png",
    size: 1024,
    isImage: true,
    preview: "data:image/png;base64,AAAA",
    ...over,
  };
}

describe("AttachmentStrip 附件预览条", () => {
  it("无附件不渲染任何内容", () => {
    const el = render(<AttachmentStrip attachments={[]} onRemove={() => {}} />);
    expect(el.querySelector(".attach-strip")).toBeNull();
  });

  it("渲染缩略图 chip + .attach-remove 删除按钮（热区外扩挂钩类名），点击回调 onRemove(id)", () => {
    const onRemove = vi.fn();
    const el = render(<AttachmentStrip attachments={[attachment()]} onRemove={onRemove} />);
    const chip = el.querySelector(".attach-chip");
    expect(chip).not.toBeNull();
    const remove = el.querySelector<HTMLButtonElement>(".attach-remove");
    expect(remove).not.toBeNull();
    expect(remove!.getAttribute("aria-label")).toContain("移除附件");
    expect(remove!.textContent).toContain("✕");
    act(() => {
      remove!.click();
    });
    expect(onRemove).toHaveBeenCalledWith("a1");
  });

  it("图片附件渲染 img.attach-thumb，非图片渲染文件图标", () => {
    const withImg = render(<AttachmentStrip attachments={[attachment()]} onRemove={() => {}} />);
    expect(withImg.querySelector("img.attach-thumb")).not.toBeNull();
    act(() => {
      root?.unmount();
    });
    container?.remove();
    const withFile = render(
      <AttachmentStrip
        attachments={[attachment({ id: "a2", name: "notes.md", mimeType: "text/markdown", isImage: false, preview: null })]}
        onRemove={() => {}}
      />,
    );
    expect(withFile.querySelector("img.attach-thumb")).toBeNull();
    expect(withFile.querySelector(".attach-thumb.file")).not.toBeNull();
    expect(withFile.querySelector(".attach-name")?.textContent).toBe("notes.md");
  });
});
