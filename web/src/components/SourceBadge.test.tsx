import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SourceBadge } from "./SourceBadge";

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

describe("SourceBadge 来源徽章", () => {
  it('source="claude" 渲染 claude 徽章（野兽派小标签样式 class source-claude）', () => {
    const el = render(<SourceBadge source="claude" />);
    expect(el.querySelector(".badge.source-claude")).not.toBeNull();
    expect(el.textContent).toContain("claude");
    expect(el.querySelector(".badge.source-pi")).toBeNull();
  });

  it('source="pi" 或缺省渲染 pi 徽章', () => {
    const pi = render(<SourceBadge source="pi" />);
    expect(pi.querySelector(".badge.source-pi")).not.toBeNull();
    act(() => {
      root?.unmount();
    });
    container?.remove();
    const fallback = render(<SourceBadge source={null} />);
    expect(fallback.querySelector(".badge.source-pi")).not.toBeNull();
    expect(fallback.textContent).toContain("pi");
  });

  it('source="codex" 渲染 Codex 徽章（样式 class source-codex，文案 Codex）', () => {
    const el = render(<SourceBadge source="codex" />);
    expect(el.querySelector(".badge.source-codex")).not.toBeNull();
    expect(el.textContent).toContain("Codex");
    expect(el.querySelector(".badge.source-pi")).toBeNull();
    expect(el.querySelector(".badge.source-claude")).toBeNull();
  });
});
