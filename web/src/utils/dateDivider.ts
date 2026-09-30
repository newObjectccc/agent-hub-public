/**
 * 消息流时间分隔线：按本地日期分组（今天 / 昨天 / YYYY-MM-DD），
 * 日期变化处插入居中小标签（野兽派风格）。
 */

export interface DateDivider {
  kind: "divider";
  /** 稳定 key：`date-<YYYY-MM-DD>` */
  id: string;
  label: string;
}

export type StreamItem<T> = { kind: "message"; message: T } | DateDivider;

/** 本地日期键 `YYYY-MM-DD`（与消息时间 HH:mm 同为浏览器本地时区） */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 分隔线标签：今天 / 昨天 / 日期（跨年歧义由 YYYY-MM-DD 恒定带年份消除） */
export function dateLabel(ts: number, now: number = Date.now()): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return "今天";
  if (key === dayKey(now - 86_400_000)) return "昨天";
  return key;
}

/** 按日期分组插入分隔线（首条消息前也插；同日只插一条） */
export function withDateDividers<T extends { id: string; timestamp: number }>(
  messages: T[],
  now: number = Date.now(),
): StreamItem<T>[] {
  const out: StreamItem<T>[] = [];
  let lastDay: string | null = null;
  for (const message of messages) {
    const key = dayKey(message.timestamp);
    if (key !== lastDay) {
      out.push({ kind: "divider", id: `date-${key}`, label: dateLabel(message.timestamp, now) });
      lastDay = key;
    }
    out.push({ kind: "message", message });
  }
  return out;
}
