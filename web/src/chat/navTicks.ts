/**
 * 对话导航条（Codex app 风格刻度时间线）纯逻辑：
 * 消息 → 刻度模型（标题/摘要/权重）、视口指示器几何、跳转滚动偏移估算。
 * 无 DOM 依赖，可单测。
 */
import type { MessageRole, SessionMessage } from "../api/types";

/** 导航条最少消息数：短会话无需时间线 */
export const NAV_MIN_MESSAGES = 4;

/** 刻度长度映射区间（px）：内容量少 → 短刻度，多 → 长刻度（Codex 条形码效果） */
export const TICK_MIN_LEN = 5;
export const TICK_MAX_LEN = 15;

/** 单个刻度（一条消息） */
export interface NavTick {
  id: string;
  role: MessageRole;
  /** 消息在会话消息数组中的下标（跳转定位用） */
  index: number;
  timestamp: number;
  /** 预览卡标题（首行摘要，截断） */
  title: string;
  /** 预览卡正文摘要（后续文本，截断） */
  preview: string;
  /** 内容量 0..1（刻度长度映射） */
  weight: number;
}

/** 标题最大长度（字符） */
const TITLE_MAX = 28;
/** 正文摘要最大长度（字符） */
const PREVIEW_MAX = 110;

/** 剥掉轻量 markdown 记号取纯文本（预览展示用；不追求完整解析） */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " [代码块] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*\*|___|\*\*|__|\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/[`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 截断到 max 字符（超出加省略号） */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 空文本消息的占位标题（工具调用/图片/流式中） */
function emptyLabel(message: SessionMessage): string {
  if (message.toolCalls.length > 0) {
    const first = message.toolCalls[0];
    return `🔧 ${first.summary || first.name}`;
  }
  if ((message.images?.length ?? 0) > 0) return "[图片]";
  if (message.streaming === true) return "回复中…";
  return "（无内容）";
}

/** 首行标题 + 后续摘要（Codex 预览卡两段式） */
function summarize(message: SessionMessage): { title: string; preview: string } {
  const plain = plainText(message.text);
  if (!plain) {
    const label = emptyLabel(message);
    return { title: clip(label, TITLE_MAX), preview: "" };
  }
  // 首句优先（？。！；\n 断句），无句读时按长度硬切
  const match = plain.match(/^[^？。！；\n]{1,40}[？。！；]?/);
  const head = (match?.[0] ?? "").trim() || plain;
  const rest = plain.slice(head.length).trim();
  return {
    title: clip(head, TITLE_MAX),
    preview: clip(rest, PREVIEW_MAX),
  };
}

/** 内容量 0..1：文本长度 + 工具调用/图片/思维链加权 */
function weightOf(message: SessionMessage): number {
  const raw =
    message.text.length / 500 +
    (message.thinking?.length ?? 0) / 800 +
    message.toolCalls.length * 0.22 +
    (message.images?.length ?? 0) * 0.28;
  return Math.min(1, Math.max(0.12, raw));
}

/** 消息 → 刻度模型数组（顺序与入参一致） */
export function buildNavTicks(messages: SessionMessage[]): NavTick[] {
  return messages.map((message, index) => {
    const { title, preview } = summarize(message);
    return {
      id: message.id,
      role: message.role,
      index,
      timestamp: message.timestamp,
      title,
      preview,
      weight: weightOf(message),
    };
  });
}

/** 刻度长度（px）：weight 0..1 → [TICK_MIN_LEN, TICK_MAX_LEN] */
export function tickLength(weight: number): number {
  const w = Math.min(1, Math.max(0, weight));
  return TICK_MIN_LEN + w * (TICK_MAX_LEN - TICK_MIN_LEN);
}

/** 刻度时:分 标签（与消息气泡 msg-time 同口径） */
export function tickTimeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 视口指示器几何（导航条轨道坐标系，比例 0..1） */
export function viewportRatio(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): { top: number; height: number } {
  const { scrollTop, scrollHeight, clientHeight } = input;
  if (!(scrollHeight > 0) || !(clientHeight > 0)) return { top: 0, height: 1 };
  const height = Math.min(1, Math.max(0.02, clientHeight / scrollHeight));
  if (scrollHeight <= clientHeight) return { top: 0, height };
  const top = Math.min(1 - height, Math.max(0, scrollTop / scrollHeight));
  return { top, height };
}

/**
 * 跳转目标 scrollTop 估算（目标行未挂载时先滚到大致位置，窗口渐进展开后微调）：
 * 行高缓存缺失（未测量行）按已测均值补齐；结果 clamp 到合法滚动范围。
 */
export function estimateJumpTop(input: {
  /** 每条消息实测高度（与 messages 同序；0 = 未测） */
  heights: readonly number[];
  /** 行间距（px，不含在行高内） */
  gap: number;
  /** 目标消息下标 */
  targetIndex: number;
  /** msg-list 顶部相对滚动内容顶部的偏移（加载更早按钮等） */
  listOffset: number;
  viewportHeight: number;
  contentHeight: number;
}): number {
  const { heights, gap, targetIndex, listOffset, viewportHeight, contentHeight } = input;
  let measuredSum = 0;
  let measuredCount = 0;
  for (const h of heights) {
    if (h > 0) {
      measuredSum += h;
      measuredCount++;
    }
  }
  const avg = measuredCount > 0 ? measuredSum / measuredCount : 0;
  let top = listOffset;
  for (let i = 0; i < targetIndex && i < heights.length; i++) {
    top += (heights[i] > 0 ? heights[i] : avg) + gap;
  }
  const targetH = heights[targetIndex] > 0 ? heights[targetIndex] : avg;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  return Math.min(maxScroll, Math.max(0, top - (viewportHeight - targetH) / 2));
}
