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
