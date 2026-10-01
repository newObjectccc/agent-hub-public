/**
 * 快捷指令（常用 prompt 模板）：内置默认 + 用户自定义（localStorage 持久化）。
 * 存储与合并逻辑全部为纯函数，便于单测；UI（QuickCommandPanel）只做渲染与交互。
 * （历史：原 quickCommands.ts 随面板移除，插入逻辑迁往 utils/insert.ts；本模块按新形态重建，
 *   在其之上扩展了"内置模板可编辑/可删除 + 恢复内置默认"的覆盖式自定义。）
 */

/** 模板条目（渲染用，合并内置与自定义后的统一形态） */
export interface QuickCommand {
  id: string;
  text: string;
  builtin: boolean;
}

/** 自定义模板（持久化；id 在新增时生成，编辑只改文本不改 id） */
export interface CustomQuickCommand {
  id: string;
  text: string;
}

/** 用户模板状态（localStorage 形状）：自定义 + 对内置模板的编辑/删除覆盖 */
export interface QuickCommandState {
  /** 自定义模板（渲染在内置之后，保持存储顺序） */
  custom: CustomQuickCommand[];
  /** 被删除（隐藏）的内置模板 id */
  removedBuiltinIds: string[];
  /** 被编辑过的内置模板文本（id → 新文本；无记录 = 用默认文本） */
  builtinTexts: Record<string, string>;
}

export const QUICK_COMMANDS_STORAGE_KEY = "agent-hub.quickCommands.v1";

/** 内置模板（中英文各若干：解释 / 测试 / 审查 / 总结 / 继续推进） */
export const BUILTIN_QUICK_COMMANDS: readonly QuickCommand[] = [
  {
    id: "builtin-explain-code",
    text: "解释这段代码：逐段说明做了什么、关键数据结构与边界条件",
    builtin: true,
  },
  {
    id: "builtin-write-tests",
    text: "帮我写测试：覆盖正常路径与边界情况，沿用项目现有测试风格",
    builtin: true,
  },
  {
    id: "builtin-review-changes",
    text: "审查当前改动并给出风险清单，按严重程度排序，附修复建议",
    builtin: true,
  },
  { id: "builtin-summary", text: "总结当前进展与下一步计划", builtin: true },
  { id: "builtin-run-tests", text: "跑测试并修复失败的用例", builtin: true },
  {
    id: "builtin-explain-en",
    text: "Explain this code step by step, including edge cases",
    builtin: true,
  },
  {
    id: "builtin-tests-en",
    text: "Write tests for this change, covering edge cases and failure paths",
    builtin: true,
  },
  {
    id: "builtin-review-en",
    text: "Review my changes and list the risks, ordered by severity",
    builtin: true,
  },
  {
    id: "builtin-refactor-en",
    text: "Refactor this for readability without changing behavior",
    builtin: true,
  },
  { id: "builtin-continue-en", text: "Continue with the next step", builtin: true },
];

/** 只依赖 Storage 的 getItem/setItem 子集，测试可注入 fake */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 空状态（每次返回新对象，避免共享引用被外部修改） */
export function emptyQuickCommandState(): QuickCommandState {
  return { custom: [], removedBuiltinIds: [], builtinTexts: {} };
}

let customIdSeq = 0;

/** 自定义模板 id：时间戳 + 序号 + 随机尾缀（同毫秒并发不撞车） */
export function newQuickCommandId(): string {
  customIdSeq += 1;
  return `qc-${Date.now().toString(36)}-${customIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCustomEntry(value: unknown): CustomQuickCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  const id = typeof rec.id === "string" && rec.id.trim() !== "" ? rec.id.trim() : null;
  const text = typeof rec.text === "string" ? rec.text.trim() : "";
  if (id === null || text === "") return null;
  return { id, text };
}

/**
 * 读取模板状态（存储损坏/缺省 → 空状态，绝不抛异常）。
 * 兼容旧版 string[] 形状（历史 localStorage 里可能残留），自动迁移为自定义模板。
 */
export function loadQuickCommandState(storage: StorageLike): QuickCommandState {
  try {
    const raw = storage.getItem(QUICK_COMMANDS_STORAGE_KEY);
    if (!raw) return emptyQuickCommandState();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 旧版形状：纯文本数组 = 自定义模板
      const custom = parsed
        .filter((t): t is string => typeof t === "string" && t.trim() !== "")
        .map((t) => ({ id: newQuickCommandId(), text: t.trim() }));
      return { custom, removedBuiltinIds: [], builtinTexts: {} };
    }
    if (typeof parsed !== "object" || parsed === null) return emptyQuickCommandState();
    const rec = parsed as Record<string, unknown>;
    const custom = (Array.isArray(rec.custom) ? rec.custom : [])
      .map(normalizeCustomEntry)
      .filter((c): c is CustomQuickCommand => c !== null);
    const removedBuiltinIds = (Array.isArray(rec.removedBuiltinIds) ? rec.removedBuiltinIds : []).filter(
      (t): t is string => typeof t === "string" && t.trim() !== "",
    );
    const builtinTexts: Record<string, string> = {};
    if (typeof rec.builtinTexts === "object" && rec.builtinTexts !== null) {
      for (const [key, value] of Object.entries(rec.builtinTexts as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim() !== "") builtinTexts[key] = value.trim();
      }
    }
    return { custom, removedBuiltinIds, builtinTexts };
  } catch {
    return emptyQuickCommandState();
  }
}

/** 保存模板状态：任何异常（quota/隐私模式）静默降级为 false，绝不向外抛 */
export function saveQuickCommandState(storage: StorageLike, state: QuickCommandState): boolean {
  try {
    storage.setItem(
      QUICK_COMMANDS_STORAGE_KEY,
      JSON.stringify({
        custom: state.custom,
        removedBuiltinIds: state.removedBuiltinIds,
        builtinTexts: state.builtinTexts,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** 内置模板默认文本（id 无效返回 null） */
export function builtinDefaultText(id: string): string | null {
  return BUILTIN_QUICK_COMMANDS.find((c) => c.id === id)?.text ?? null;
}

/**
 * 合并渲染列表：内置默认（未删除、按编辑覆盖）在前，自定义在后。
 * —— "内置默认合并"的核心：存储里只存差异，渲染时与出厂列表合并。
 */
export function mergeQuickCommands(state: QuickCommandState): QuickCommand[] {
  const builtin = BUILTIN_QUICK_COMMANDS.filter((c) => !state.removedBuiltinIds.includes(c.id)).map((c) => ({
    id: c.id,
    text: state.builtinTexts[c.id] ?? c.text,
    builtin: true,
  }));
  const custom = state.custom.map((c) => ({ id: c.id, text: c.text, builtin: false }));
  return [...builtin, ...custom];
}

/**
 * 新增自定义模板（trim、空忽略、与现有模板文本重复忽略）。
 * makeId 可注入便于测试确定性。
 */
export function addCustomQuickCommand(
  state: QuickCommandState,
  text: string,
  makeId: () => string = newQuickCommandId,
): QuickCommandState {
  const trimmed = text.trim();
  if (trimmed === "") return { ...state, custom: state.custom.slice() };
  const exists = mergeQuickCommands(state).some((c) => c.text === trimmed);
  if (exists) return { ...state, custom: state.custom.slice() };
  return {
    ...state,
    custom: [...state.custom, { id: makeId(), text: trimmed }],
  };
}

/**
 * 编辑模板文本（自定义改文本保 id；内置写覆盖，改回默认文本时清掉覆盖）。
 * 空文本 / 未知 id → 状态不变（删除走 removeQuickCommand）。
 */
export function updateQuickCommand(state: QuickCommandState, id: string, text: string): QuickCommandState {
  const trimmed = text.trim();
  if (trimmed === "") return { ...state, custom: state.custom.slice() };
  const customIdx = state.custom.findIndex((c) => c.id === id);
  if (customIdx >= 0) {
    const custom = state.custom.slice();
    custom[customIdx] = { ...custom[customIdx], text: trimmed };
    return { ...state, custom };
  }
  const defText = builtinDefaultText(id);
  if (defText === null) return { ...state, custom: state.custom.slice() };
  const builtinTexts = { ...state.builtinTexts };
  if (trimmed === defText) delete builtinTexts[id];
  else builtinTexts[id] = trimmed;
  return { ...state, builtinTexts };
}

/**
 * 删除模板（自定义 → 移除；内置 → 记入 removedBuiltinIds 隐藏，可"恢复内置默认"找回）。
 * 内置删除幂等。
 */
export function removeQuickCommand(state: QuickCommandState, id: string): QuickCommandState {
  const custom = state.custom.filter((c) => c.id !== id);
  if (custom.length !== state.custom.length) return { ...state, custom };
  if (builtinDefaultText(id) === null) return { ...state, custom: state.custom.slice() };
  if (state.removedBuiltinIds.includes(id)) return { ...state, custom: state.custom.slice() };
  return { ...state, custom: state.custom.slice(), removedBuiltinIds: [...state.removedBuiltinIds, id] };
}

/** 恢复内置默认：清除对内置模板的编辑/删除覆盖（自定义模板保留，可单独删除） */
export function restoreBuiltinQuickCommands(state: QuickCommandState): QuickCommandState {
  return { custom: state.custom.slice(), removedBuiltinIds: [], builtinTexts: {} };
}
