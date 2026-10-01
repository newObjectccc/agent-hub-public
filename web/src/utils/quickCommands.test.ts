/**
 * 快捷指令存储/合并纯函数单测：增删改、持久化、内置默认合并、旧格式迁移。
 */
import { describe, expect, it } from "vitest";
import {
  addCustomQuickCommand,
  BUILTIN_QUICK_COMMANDS,
  builtinDefaultText,
  emptyQuickCommandState,
  loadQuickCommandState,
  mergeQuickCommands,
  newQuickCommandId,
  QUICK_COMMANDS_STORAGE_KEY,
  removeQuickCommand,
  restoreBuiltinQuickCommands,
  saveQuickCommandState,
  updateQuickCommand,
  type QuickCommandState,
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

/** 抛异常的存储（quota/隐私模式模拟） */
function throwingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

/** 依次追加自定义模板（注入确定性 id 便于断言） */
function withCustom(texts: string[]): QuickCommandState {
  let state = emptyQuickCommandState();
  let seq = 0;
  for (const text of texts) {
    state = addCustomQuickCommand(state, text, () => `id-${seq++}`);
  }
  return state;
}

describe("内置默认模板", () => {
  it("中英文各若干（解释/测试/审查/总结等常用 prompt），id 唯一且全为内置", () => {
    expect(BUILTIN_QUICK_COMMANDS.length).toBeGreaterThanOrEqual(6);
    const texts = BUILTIN_QUICK_COMMANDS.map((c) => c.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(new Set(BUILTIN_QUICK_COMMANDS.map((c) => c.id)).size).toBe(texts.length);
    expect(BUILTIN_QUICK_COMMANDS.every((c) => c.builtin)).toBe(true);
    expect(BUILTIN_QUICK_COMMANDS.some((c) => /[a-z]/i.test(c.text))).toBe(true);
    expect(BUILTIN_QUICK_COMMANDS.some((c) => /[\u4e00-\u9fff]/.test(c.text))).toBe(true);
  });

  it("builtinDefaultText 按 id 取默认文本；未知 id 返回 null", () => {
    expect(builtinDefaultText(BUILTIN_QUICK_COMMANDS[0].id)).toBe(BUILTIN_QUICK_COMMANDS[0].text);
    expect(builtinDefaultText("nope")).toBeNull();
  });
});

describe("内置默认合并（mergeQuickCommands）", () => {
  it("内置在前、自定义在后，builtin 标记正确", () => {
    const state = withCustom(["我的模板 A", "我的模板 B"]);
    const merged = mergeQuickCommands(state);
    expect(merged.slice(0, BUILTIN_QUICK_COMMANDS.length)).toEqual(
      BUILTIN_QUICK_COMMANDS.map((c) => ({ id: c.id, text: c.text, builtin: true })),
    );
    expect(merged.slice(-2).map((c) => c.text)).toEqual(["我的模板 A", "我的模板 B"]);
    expect(merged.slice(-2).every((c) => !c.builtin)).toBe(true);
  });

  it("被删除的内置不出现在合并结果；被编辑的内置显示新文本", () => {
    let state = removeQuickCommand(emptyQuickCommandState(), BUILTIN_QUICK_COMMANDS[0].id);
    state = updateQuickCommand(state, BUILTIN_QUICK_COMMANDS[1].id, "改写后的模板");
    const merged = mergeQuickCommands(state);
    expect(merged.some((c) => c.id === BUILTIN_QUICK_COMMANDS[0].id)).toBe(false);
    expect(merged.find((c) => c.id === BUILTIN_QUICK_COMMANDS[1].id)?.text).toBe("改写后的模板");
  });
});

describe("自定义模板增删改（纯函数，不改入参）", () => {
  it("addCustomQuickCommand：trim、追加、注入 id", () => {
    const state = withCustom(["  模板 A  "]);
    expect(state.custom).toEqual([{ id: "id-0", text: "模板 A" }]);
    // 纯函数：入参不被修改
    const base = emptyQuickCommandState();
    addCustomQuickCommand(base, "x");
    expect(base.custom).toEqual([]);
  });

  it("空/纯空白文本忽略；与现有模板（含内置）文本重复忽略", () => {
    const state = withCustom(["模板 A"]);
    expect(addCustomQuickCommand(state, "   ").custom).toHaveLength(1);
    expect(addCustomQuickCommand(state, "模板 A").custom).toHaveLength(1);
    expect(addCustomQuickCommand(state, BUILTIN_QUICK_COMMANDS[0].text).custom).toHaveLength(1);
  });

  it("updateQuickCommand：自定义改文本保 id；空文本/未知 id 不变", () => {
    const state = withCustom(["旧文本"]);
    const updated = updateQuickCommand(state, "id-0", "  新文本  ");
    expect(updated.custom).toEqual([{ id: "id-0", text: "新文本" }]);
    expect(updateQuickCommand(state, "id-0", "   ").custom).toEqual(state.custom);
    expect(updateQuickCommand(state, "ghost", "x").custom).toEqual(state.custom);
  });

  it("updateQuickCommand：内置写覆盖；改回默认文本时清掉覆盖", () => {
    const id = BUILTIN_QUICK_COMMANDS[0].id;
    const edited = updateQuickCommand(emptyQuickCommandState(), id, "自定义解释");
    expect(edited.builtinTexts[id]).toBe("自定义解释");
    const reverted = updateQuickCommand(edited, id, BUILTIN_QUICK_COMMANDS[0].text);
    expect(reverted.builtinTexts[id]).toBeUndefined();
  });

  it("removeQuickCommand：自定义移除；内置删除幂等且可恢复", () => {
    const state = withCustom(["模板 A", "模板 B"]);
    const removed = removeQuickCommand(state, "id-0");
    expect(removed.custom.map((c) => c.text)).toEqual(["模板 B"]);

    const builtinId = BUILTIN_QUICK_COMMANDS[0].id;
    const hidden = removeQuickCommand(emptyQuickCommandState(), builtinId);
    expect(hidden.removedBuiltinIds).toEqual([builtinId]);
    expect(removeQuickCommand(hidden, builtinId).removedBuiltinIds).toEqual([builtinId]);
    // 未知 id 不产生任何变化
    expect(removeQuickCommand(emptyQuickCommandState(), "ghost").removedBuiltinIds).toEqual([]);
  });

  it("restoreBuiltinQuickCommands：内置编辑/删除覆盖全清，自定义保留", () => {
    const builtinId = BUILTIN_QUICK_COMMANDS[0].id;
    let state = withCustom(["我的模板"]);
    state = removeQuickCommand(state, builtinId);
    state = updateQuickCommand(state, BUILTIN_QUICK_COMMANDS[1].id, "改写");
    const restored = restoreBuiltinQuickCommands(state);
    expect(restored.removedBuiltinIds).toEqual([]);
    expect(restored.builtinTexts).toEqual({});
    expect(restored.custom.map((c) => c.text)).toEqual(["我的模板"]);
  });

  it("newQuickCommandId 连续生成不重复", () => {
    const ids = new Set([newQuickCommandId(), newQuickCommandId(), newQuickCommandId()]);
    expect(ids.size).toBe(3);
  });
});

describe("localStorage 持久化（键 agent-hub.quickCommands.v1）", () => {
  it("保存后可读回完整状态；缺省为空状态", () => {
    const storage = fakeStorage();
    expect(loadQuickCommandState(storage)).toEqual(emptyQuickCommandState());

    let state = withCustom(["自定义 A"]);
    state = removeQuickCommand(state, BUILTIN_QUICK_COMMANDS[0].id);
    state = updateQuickCommand(state, BUILTIN_QUICK_COMMANDS[1].id, "改写");
    expect(saveQuickCommandState(storage, state)).toBe(true);
    expect(storage.data[QUICK_COMMANDS_STORAGE_KEY]).toContain("自定义 A");
    expect(loadQuickCommandState(storage)).toEqual(state);
  });

  it("存储损坏 / 非对象 → 空状态（不抛异常）", () => {
    expect(loadQuickCommandState(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: "{oops" }))).toEqual(
      emptyQuickCommandState(),
    );
    expect(loadQuickCommandState(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: '"str"' }))).toEqual(
      emptyQuickCommandState(),
    );
    expect(loadQuickCommandState(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: "42" }))).toEqual(
      emptyQuickCommandState(),
    );
  });

  it("非法字段被过滤（空文本/非字符串/坏 id）", () => {
    const raw = JSON.stringify({
      custom: [{ id: "ok", text: " 有效 " }, { id: "", text: "x" }, { id: "a", text: "  " }, 1, null, "str"],
      removedBuiltinIds: ["good", 3, "", "fine"],
      builtinTexts: { a: " 改写 ", b: 7, c: "  " },
    });
    const state = loadQuickCommandState(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: raw }));
    expect(state.custom).toEqual([{ id: "ok", text: "有效" }]);
    expect(state.removedBuiltinIds).toEqual(["good", "fine"]);
    expect(state.builtinTexts).toEqual({ a: "改写" });
  });

  it("旧版 string[] 形状自动迁移为自定义模板", () => {
    const raw = JSON.stringify(["旧模板 A", "", " 旧模板 B "]);
    const state = loadQuickCommandState(fakeStorage({ [QUICK_COMMANDS_STORAGE_KEY]: raw }));
    expect(state.custom.map((c) => c.text)).toEqual(["旧模板 A", "旧模板 B"]);
    expect(state.custom.every((c) => c.id !== "")).toBe(true);
    expect(state.removedBuiltinIds).toEqual([]);
  });

  it("存储不可用（SecurityError/Quota）→ 读为空、写返回 false 不抛", () => {
    expect(loadQuickCommandState(throwingStorage())).toEqual(emptyQuickCommandState());
    expect(saveQuickCommandState(throwingStorage(), emptyQuickCommandState())).toBe(false);
  });
});
