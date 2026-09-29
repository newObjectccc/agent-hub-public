/**
 * 相对时间格式化（中文）："刚刚" / "N分钟前" / "N小时前" / "N天前" / 具体日期。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(input: string | number | Date, now: number = Date.now()): string {
  const t =
    typeof input === "number" ? input : input instanceof Date ? input.getTime() : Date.parse(input);
  if (Number.isNaN(t)) return "";

  const diff = now - t;
  if (diff < 0) {
    // 未来时间（时钟偏差）显示具体时间，避免出现"-3分钟前"
    return formatAbsolute(t);
  }
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}天前`;
  return formatAbsolute(t);
}

function formatAbsolute(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
