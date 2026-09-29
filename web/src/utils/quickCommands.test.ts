import { describe, expect, it } from "vitest";
import {
  addCustomCommand,
  allCommands,
  BUILTIN_COMMANDS,
  customCommandId,
  insertSnippet,
  loadCustomCommands,
  QUICK_COMMANDS_STORAGE_KEY,
  removeCustomCommand,
  safeStorage,
  saveCustomCommands,
  type StorageLike,
} from "./quickCommands";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("快捷指令存储（localStorage 持久化）", () => {
  it("内置模板齐全：继续 / 跑测试并修复失败 / 总结当前进展 / 先别动，等我确认", () => {
    expect(BUILTIN_COMMANDS.map((c) => c.text)).toEqual([
      "继续",
      "跑测试并修复失败",
      "总结当前进展",
      "先别动，等我确认",
    ]);
    expect(BUILTIN_COMMANDS.every((c) => c.builtin)).toBe(true);
  });

  it("保存后可读回；缺省为空列表", () => {
    const storage = fakeStorage();
    expect(loadCustomCommands(storage)).toEqual([]);
    saveCustomCommands(storage, ["自定义 A", "自定义 B"]);
    expect(loadCustomCommands(storage)).toEqual(["自定义 A", "自定义 B"]);
    expect(storage.data[QUICK_COMMANDS_STORAGE_KEY]).toContain("自定义 A");
  });

  it("存储损坏 / 非数组 → 空列表（不抛异常）", () => {
    expect(loadCustomCommands(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: "{oops" }))).toEqual([]);
    expect(loadCustomCommands(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadCustomCommands(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: '[1, null, "ok"]' }))).toEqual(["ok"]);
  });

  it("追加：trim、空忽略、去重，返回新列表不改原列表", () => {
    const base = ["已有"];
    expect(addCustomCommand(base, "  新指令  ")).toEqual(["已有", "新指令"]);
    expect(addCustomCommand(base, "   ")).toEqual(["已有"]);
    expect(addCustomCommand(base, "已有")).toEqual(["已有"]);
    expect(base).toEqual(["已有"]);
  });

  it("删除自定义指令返回新列表", () => {
    expect(removeCustomCommand(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("合并渲染：内置在前自定义在后，自定义 id 稳定", () => {
    const merged = allCommands(["我的指令"]);
    expect(merged.slice(0, BUILTIN_COMMANDS.length).every((c) => c.builtin)).toBe(true);
    const custom = merged[merged.length - 1];
    expect(custom.text).toBe("我的指令");
    expect(custom.builtin).toBe(false);
    expect(custom.id).toBe(customCommandId("我的指令"));
    expect(allCommands(["我的指令"])[merged.length - 1].id).toBe(custom.id);
  });
});

describe("insertSnippet（点击插入输入框，可编辑后发送）", () => {
  it("空输入框 → 直接插入", () => {
    expect(insertSnippet("", "继续")).toBe("继续");
    expect(insertSnippet("   ", "继续")).toBe("继续");
  });

  it("已有文本 → 换行衔接（原文可继续编辑）", () => {
    expect(insertSnippet("帮我看看", "跑测试并修复失败")).toBe("帮我看看\n跑测试并修复失败");
    expect(insertSnippet("帮我看看\n", "继续")).toBe("帮我看看\n继续");
  });

  it("空模板不改变原文", () => {
    expect(insertSnippet("保持", "  ")).toBe("保持");
  });
});

describe("localStorage 异常容错（写路径 + getter）", () => {
  it("setItem 抛异常时 saveCustomCommands 不向外抛，返回 false", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    let ok: boolean | undefined;
    expect(() => {
      ok = saveCustomCommands(throwing as unknown as StorageLike, ["继续"]);
    }).not.toThrow();
    expect(ok).toBe(false);
  });

  it("safeStorage 在 getter 抛 SecurityError 时返回 null（不抛）", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      let got: unknown;
      expect(() => {
        got = safeStorage();
      }).not.toThrow();
      expect(got).toBe(null);
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });

  it("storage 为 null 时 CRUD 纯函数仍可用（仅内存模式）", () => {
    const next = addCustomCommand(["继续"], "跑测试");
    expect(next).toEqual(["继续", "跑测试"]);
    expect(removeCustomCommand(next, "继续")).toEqual(["跑测试"]);
  });
});
