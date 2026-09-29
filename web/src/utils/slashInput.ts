/**
 * slash 命令输入的触发/过滤/插入（纯函数，便于单测）。
 *
 * 触发规则：光标前最后一个空白边界 token 以 `/` 开头即触发命令面板；
 * 继续输入 `xxx` 作为过滤 query（大小写不敏感子串，命中命令名或描述）；
 * 点击命令把 token 替换为 `/cmd `（发送时 `/cmd args` 原样作为 prompt 文本）。
 */

export interface TokenSpan {
  /** token 在文本中的起始下标（含 `/` / `@`） */
  start: number;
  /** token 结束下标（= 光标位置） */
  end: number;
  /** token 中触发符之后的过滤词 */
  query: string;
}

/** 可过滤的命令项（server GET /api/commands 的 CommandDto 子集） */
export interface SlashCommandLike {
  name: string;
  description: string;
  builtin: boolean;
  terminalOnly: boolean;
}

const TRIGGER = "/";

/**
 * 检测光标处的 `/cmd` 触发 token；无触发返回 null。
 * token 必须起于行首/空白之后，且不含空白（空白即终止）。
 */
export function detectCommandTrigger(text: string, cursor: number): TokenSpan | null {
  return detectToken(text, cursor, TRIGGER);
}

/** `@path` 同款 token 检测（文件引用面板复用） */
export function detectToken(text: string, cursor: number, trigger: string): TokenSpan | null {
  if (cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  let start = before.length;
  while (start > 0) {
    const ch = before[start - 1];
    if (/\s/.test(ch)) break;
    start -= 1;
  }
  const token = before.slice(start);
  if (!token.startsWith(trigger) || token.length < 1) return null;
  const query = token.slice(trigger.length);
  if (/\s/.test(query)) return null;
  return { start, end: cursor, query };
}

/** 过滤：query 为空全量；否则大小写不敏感子串命中命令名或描述 */
export function filterSlashCommands(commands: readonly SlashCommandLike[], query: string): SlashCommandLike[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...commands];
  return commands.filter(
    (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  );
}

/** 面板分组：可直接执行在前，“仅终端可用”殿后；组内内置优先、按名字稳定排序 */
export interface SlashGroup {
  key: "usable" | "terminal";
  label: string;
  icon: string;
  items: SlashCommandLike[];
}

export function groupSlashCommands(commands: readonly SlashCommandLike[], query: string): SlashGroup[] {
  const byKind = (a: SlashCommandLike, b: SlashCommandLike): number => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
  const filtered = filterSlashCommands(commands, query);
  const groups: SlashGroup[] = [
    { key: "usable", label: "可直接执行", icon: "⚡", items: filtered.filter((c) => !c.terminalOnly).sort(byKind) },
    { key: "terminal", label: "仅终端可用（插入参考）", icon: "⌨", items: filtered.filter((c) => c.terminalOnly).sort(byKind) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Enter 的默认选中项 = 第一个分组的第一条（与面板视觉首项一致） */
export function firstSlashCommand(commands: readonly SlashCommandLike[], query: string): SlashCommandLike | null {
  const groups = groupSlashCommands(commands, query);
  return groups.length > 0 && groups[0].items.length > 0 ? groups[0].items[0] : null;
}

export interface InsertResult {
  text: string;
  /** 插入后光标位置 */
  cursor: number;
}

/** 把触发 token 替换为选中命令 `/cmd `（含尾随空格，便于继续输参数） */
export function applyCommandInsert(text: string, span: TokenSpan, name: string): InsertResult {
  return replaceToken(text, span, `${name} `);
}

/** 把触发 token 替换为一组文件引用 `@a @b ` */
export function applyFileInsert(text: string, span: TokenSpan, paths: readonly string[]): InsertResult {
  const refs = paths.filter((p) => p.trim() !== "").map((p) => `@${p.replace(/^@+/, "")}`);
  return replaceToken(text, span, refs.length > 0 ? `${refs.join(" ")} ` : "");
}

function replaceToken(text: string, span: TokenSpan, replacement: string): InsertResult {
  const next = text.slice(0, span.start) + replacement + text.slice(span.end);
  return { text: next, cursor: span.start + replacement.length };
}
