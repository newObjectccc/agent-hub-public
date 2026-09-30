/**
 * 消息流时间分隔线：按本地日期分组（今天 / 昨天 / YYYY-MM-DD）。
 */
import { describe, expect, it } from "vitest";
import { dateLabel, dayKey, withDateDividers } from "./dateDivider";

function msg(id: string, timestamp: number) {
  return { id, timestamp };
}

// 固定“现在”：2026-02-18 12:00 本地时间
const NOW = new Date(2026, 1, 18, 12, 0, 0).getTime();
const TODAY_10 = new Date(2026, 1, 18, 10, 0, 0).getTime();
const YESTERDAY_22 = new Date(2026, 1, 17, 22, 0, 0).getTime();
const TWO_DAYS = new Date(2026, 1, 16, 9, 0, 0).getTime();

describe("dayKey / dateLabel", () => {
  it("本地日期键 YYYY-MM-DD（补零）", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(dayKey(TODAY_10)).toBe("2026-02-18");
  });

  it("今天/昨天/日期 三态标签", () => {
    expect(dateLabel(TODAY_10, NOW)).toBe("今天");
    expect(dateLabel(YESTERDAY_22, NOW)).toBe("昨天");
    expect(dateLabel(TWO_DAYS, NOW)).toBe("2026-02-16");
  });
});

describe("withDateDividers（消息流插入分隔线）", () => {
  it("首条消息前也插分隔线；同日只插一条；日期变化处再插", () => {
    const items = withDateDividers(
      [msg("m1", TWO_DAYS), msg("m2", TWO_DAYS + 1000), msg("m3", YESTERDAY_22), msg("m4", TODAY_10)],
      NOW,
    );
    const dividers = items.filter((i) => i.kind === "divider");
    expect(dividers).toHaveLength(3);
    expect(items.map((i) => (i.kind === "divider" ? `|${i.label}` : i.message.id))).toEqual([
      "|2026-02-16",
      "m1",
      "m2",
      "|昨天",
      "m3",
      "|今天",
      "m4",
    ]);
  });

  it("分隔线 id 稳定（React key）；空消息流不产生分隔线", () => {
    const items = withDateDividers([msg("m1", TODAY_10), msg("m2", TODAY_10 + 1000)], NOW);
    const divider = items.find((i) => i.kind === "divider");
    expect(divider && divider.kind === "divider" ? divider.id : null).toBe("date-2026-02-18");
    expect(withDateDividers([], NOW)).toEqual([]);
  });
});
