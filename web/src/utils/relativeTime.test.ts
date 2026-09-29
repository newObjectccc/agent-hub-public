import { describe, expect, it } from "vitest";
import { elapsedDuration, elapsedMinutesLabel, relativeTime } from "./relativeTime";

const NOW = Date.parse("2026-02-18T12:00:00.000Z");

describe("relativeTime", () => {
  it("1 分钟内显示「刚刚」", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("刚刚");
    expect(relativeTime(NOW - 59_000, NOW)).toBe("刚刚");
  });

  it("分钟级显示「N分钟前」，例如 2 分钟前", () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe("2分钟前");
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe("59分钟前");
  });

  it("小时级显示「N小时前」", () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3小时前");
  });

  it("天级显示「N天前」，超过 7 天显示绝对时间", () => {
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2天前");
    expect(relativeTime(NOW - 7 * 86_400_000 - 1, NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("接受 ISO 字符串与 Date 输入", () => {
    expect(relativeTime("2026-02-18T11:58:00.000Z", NOW)).toBe("2分钟前");
    expect(relativeTime(new Date(NOW - 60 * 60_000), NOW)).toBe("1小时前");
  });

  it("非法输入返回空串，未来时间返回绝对时间", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("");
    expect(relativeTime(NOW + 60_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("elapsedDuration（运行时长实时格式化）", () => {
  const NOW = Date.parse("2026-02-18T12:00:00.000Z");

  it("秒级：45秒", () => {
    expect(elapsedDuration(NOW - 45_000, NOW)).toBe("45秒");
  });

  it("分钟级：12分30秒", () => {
    expect(elapsedDuration(NOW - 750_000, NOW)).toBe("12分30秒");
  });

  it("小时级：2时05分", () => {
    expect(elapsedDuration(NOW - (2 * 3600 + 300) * 1000, NOW)).toBe("2时05分");
  });

  it("刚启动 0 秒与非法起点", () => {
    expect(elapsedDuration(NOW, NOW)).toBe("0秒");
    expect(elapsedDuration(NaN, NOW)).toBe("");
    // 未来时间（时钟偏差）不出现负数
    expect(elapsedDuration(NOW + 5_000, NOW)).toBe("0秒");
  });
});

describe("elapsedMinutesLabel（会话行内已运行标记，分钟粒度）", () => {
  const NOW = Date.parse("2026-02-18T12:00:00.000Z");

  it("分钟级：12分钟", () => {
    expect(elapsedMinutesLabel(NOW - 12 * 60_000, NOW)).toBe("12分钟");
    expect(elapsedMinutesLabel(NOW - 59 * 60_000, NOW)).toBe("59分钟");
  });

  it("小时级：2时05分", () => {
    expect(elapsedMinutesLabel(NOW - (2 * 3600 + 300) * 1000, NOW)).toBe("2时05分");
  });

  it("不足 1 分钟、非法起点与未来时间", () => {
    expect(elapsedMinutesLabel(NOW - 30_000, NOW)).toBe("不到1分钟");
    expect(elapsedMinutesLabel(NaN, NOW)).toBe("");
    expect(elapsedMinutesLabel(NOW + 5_000, NOW)).toBe("不到1分钟");
  });
});
