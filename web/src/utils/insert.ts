/**
 * 输入框文本插入（纯函数）：语音转写、模板片段等统一走这里。
 * （原 utils/quickCommands.ts 的 insertSnippet：快捷指令面板移除后迁移到上传/语音链路复用。）
 */

/** 片段追加到输入框现有文本（非空时换行衔接） */
export function insertSnippet(current: string, snippet: string): string {
  const trimmed = snippet.trim();
  if (trimmed === "") return current;
  const base = current.replace(/\s+$/, "");
  return base === "" ? trimmed : `${base}\n${trimmed}`;
}

export interface CursorInsert {
  text: string;
  /** 插入后光标位置 */
  cursor: number;
}

/** 在光标处插入片段（不吞光标后已有内容），返回新文本与新光标 */
export function insertAtCursor(text: string, cursor: number, snippet: string): CursorInsert {
  const at = Math.max(0, Math.min(cursor, text.length));
  const next = text.slice(0, at) + snippet + text.slice(at);
  return { text: next, cursor: at + snippet.length };
}

/**
 * 快捷指令等模板片段插到光标处（保留光标后已有内容），返回新文本与新光标。
 * 语义与 insertSnippet 的"换行衔接"一致：光标前已有非空白内容时补前置换行，
 * 光标后紧跟非空白内容时补后置换行，避免模板与前后文黏连。
 */
export function insertSnippetAtCursor(text: string, cursor: number, snippet: string): CursorInsert {
  const trimmed = snippet.trim();
  if (trimmed === "") return { text, cursor: Math.max(0, Math.min(cursor, text.length)) };
  const at = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const prefix = before !== "" && /\S$/.test(before) ? "\n" : "";
  const suffix = after !== "" && /^\S/.test(after) ? "\n" : "";
  const inserted = `${prefix}${trimmed}${suffix}`;
  return { text: before + inserted + after, cursor: at + inserted.length };
}
