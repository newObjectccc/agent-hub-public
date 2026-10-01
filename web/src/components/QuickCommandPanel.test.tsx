/**
 * QuickCommandPanel 组件测试：渲染 / 插入 / 新增 / 编辑 / 删除（两步确认）/ 恢复内置默认 / 空态 / 禁用。
 * 渲染方式与 SendModeMenu.test.tsx 先例一致（createRoot + act，jsdom）。
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCommandPanel } from "./QuickCommandPanel";
import {
  BUILTIN_QUICK_COMMANDS,
  QUICK_COMMANDS_STORAGE_KEY,
  type QuickCommandState,
} from "../utils/quickCommands";

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

beforeEach(() => {
  window.localStorage.clear();
});

/** 输入框输入（React onChange 走原生 value setter + input 事件） */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 预置 localStorage 状态 */
function seedState(state: Partial<QuickCommandState>): void {
  window.localStorage.setItem(
    QUICK_COMMANDS_STORAGE_KEY,
    JSON.stringify({ custom: [], removedBuiltinIds: [], builtinTexts: {}, ...state }),
  );
}

const FIRST_BUILTIN = BUILTIN_QUICK_COMMANDS[0];

/** 带受控开关的宿主：模拟 ChatPage 的 open 切换（onClose 后再开验证持久化） */
function PanelHost({ onInsert, onClose }: { onInsert: (t: string) => void; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="toggle" onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
      <QuickCommandPanel open={open} onInsert={onInsert} onClose={() => { onClose(); setOpen(false); }} />
    </>
  );
}

describe("QuickCommandPanel 渲染", () => {
  it("open=false 不渲染任何内容", () => {
    const el = render(<QuickCommandPanel open={false} onInsert={() => {}} onClose={() => {}} />);
    expect(el.querySelector(".quick-panel")).toBeNull();
  });

  it("open=true 渲染全部内置模板（内置标签）", () => {
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    const items = el.querySelectorAll(".quick-insert");
    expect(items).toHaveLength(BUILTIN_QUICK_COMMANDS.length);
    expect(el.querySelector(".quick-title")?.textContent).toContain("快捷指令");
    for (const item of items) {
      expect(item.querySelector(".quick-tag")?.textContent).toBe("内置");
      expect(item.textContent).not.toBe("");
    }
  });

  it("渲染 localStorage 里的自定义模板（带自定义标签）", () => {
    seedState({ custom: [{ id: "c1", text: "我的模板" }] });
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    const items = el.querySelectorAll(".quick-insert");
    expect(items).toHaveLength(BUILTIN_QUICK_COMMANDS.length + 1);
    const last = items[items.length - 1];
    expect(last.querySelector(".quick-tag")?.textContent).toBe("自定义");
    expect(last.textContent).toContain("我的模板");
  });
});

describe("QuickCommandPanel 插入", () => {
  it("点条目 → onInsert 收到模板文本并关闭面板", () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    const el = render(<QuickCommandPanel open onInsert={onInsert} onClose={onClose} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-insert")!.click();
    });
    expect(onInsert).toHaveBeenCalledWith(FIRST_BUILTIN.text);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disabled（发送中）时插入按钮禁用", () => {
    const onInsert = vi.fn();
    const el = render(<QuickCommandPanel open disabled onInsert={onInsert} onClose={() => {}} />);
    const first = el.querySelector<HTMLButtonElement>(".quick-insert")!;
    expect(first.disabled).toBe(true);
    act(() => {
      first.click();
    });
    expect(onInsert).not.toHaveBeenCalled();
  });
});

describe("QuickCommandPanel 新增自定义（localStorage 持久化）", () => {
  it("填入 + 添加 → 列表出现新条目，刷新（重开面板）不丢", () => {
    const el = render(<PanelHost onInsert={() => {}} onClose={() => {}} />);
    const input = el.querySelector<HTMLInputElement>('[aria-label="自定义快捷指令模板"]')!;
    act(() => {
      typeInto(input, "  我的自定义模板  ");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-add-btn")!.click();
    });
    expect(el.querySelectorAll(".quick-insert")).toHaveLength(BUILTIN_QUICK_COMMANDS.length + 1);
    expect(container!.textContent).toContain("我的自定义模板");
    // localStorage 持久化
    expect(window.localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY)).toContain("我的自定义模板");
    // 关闭重开仍在
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(container!.textContent).toContain("我的自定义模板");
  });

  it("空文本 / 与现有模板重复 → 不新增", () => {
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    const input = el.querySelector<HTMLInputElement>('[aria-label="自定义快捷指令模板"]')!;
    act(() => {
      typeInto(input, "   ");
      el.querySelector<HTMLButtonElement>(".quick-add-btn")!.click();
    });
    act(() => {
      typeInto(input, FIRST_BUILTIN.text);
      el.querySelector<HTMLButtonElement>(".quick-add-btn")!.click();
    });
    expect(el.querySelectorAll(".quick-insert")).toHaveLength(BUILTIN_QUICK_COMMANDS.length);
  });
});

describe("QuickCommandPanel 管理模式：编辑 / 删除（两步确认）", () => {
  it("普通模式下条目点击是插入；进管理模式后条目点击变编辑", () => {
    const onInsert = vi.fn();
    const el = render(<QuickCommandPanel open onInsert={onInsert} onClose={() => {}} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-manage")!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-insert")!.click();
    });
    // 管理模式：点击不插入，进入编辑
    expect(onInsert).not.toHaveBeenCalled();
    const editInput = el.querySelector<HTMLInputElement>('[aria-label^="编辑模板"]');
    expect(editInput).not.toBeNull();
  });

  it("编辑保存 → 文本更新并持久化（内置写覆盖）", () => {
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-manage")!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-insert")!.click();
    });
    act(() => {
      typeInto(el.querySelector<HTMLInputElement>('[aria-label^="编辑模板"]')!, "改写后的模板");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-save")!.click();
    });
    expect(container!.textContent).toContain("改写后的模板");
    const stored = window.localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY) ?? "";
    expect(stored).toContain("改写后的模板");
    expect(stored).toContain(FIRST_BUILTIN.id);
  });

  it("删除需两步确认：第一击不删（防误触），第二击才删并持久化", () => {
    seedState({ custom: [{ id: "c1", text: "待删模板" }] });
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-manage")!.click();
    });
    const delBtns = el.querySelectorAll<HTMLButtonElement>(".quick-delete");
    const target = delBtns[delBtns.length - 1];
    expect(target.getAttribute("aria-label")).toContain("二次确认");
    act(() => {
      target.click();
    });
    // 第一击只进入待确认态
    expect(container!.textContent).toContain("待删模板");
    expect(target.textContent).toBe("确认");
    act(() => {
      target.click();
    });
    expect(container!.textContent).not.toContain("待删模板");
    const stored = window.localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY) ?? "";
    expect(stored).not.toContain("待删模板");
  });

  it("编辑取消：文本不变", () => {
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-manage")!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-insert")!.click();
    });
    act(() => {
      typeInto(el.querySelector<HTMLInputElement>('[aria-label^="编辑模板"]')!, "不该保存");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-cancel")!.click();
    });
    expect(container!.textContent).not.toContain("不该保存");
    expect(container!.textContent).toContain(FIRST_BUILTIN.text);
  });
});

describe("QuickCommandPanel 恢复内置默认 / 空态", () => {
  it("删除内置后点恢复内置默认（两步确认）→ 内置回归，自定义保留", () => {
    seedState({
      custom: [{ id: "c1", text: "我的自定义" }],
      removedBuiltinIds: [FIRST_BUILTIN.id],
      builtinTexts: { [BUILTIN_QUICK_COMMANDS[1].id]: "被改写" },
    });
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    expect(container!.textContent).not.toContain(FIRST_BUILTIN.text);
    act(() => {
      el.querySelector<HTMLButtonElement>(".quick-manage")!.click();
    });
    const restore = el.querySelector<HTMLButtonElement>(".quick-restore")!;
    act(() => {
      restore.click();
    });
    // 第一击进入待确认
    expect(restore.textContent).toContain("确认恢复");
    act(() => {
      restore.click();
    });
    expect(container!.textContent).toContain(FIRST_BUILTIN.text);
    expect(container!.textContent).toContain(BUILTIN_QUICK_COMMANDS[1].text);
    expect(container!.textContent).toContain("我的自定义");
  });

  it("全部删光（内置全隐藏 + 无自定义）→ 显示空态提示", () => {
    seedState({ removedBuiltinIds: BUILTIN_QUICK_COMMANDS.map((c) => c.id) });
    const el = render(<QuickCommandPanel open onInsert={() => {}} onClose={() => {}} />);
    expect(el.querySelectorAll(".quick-insert")).toHaveLength(0);
    const empty = el.querySelector(".quick-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("恢复内置默认");
  });
});
