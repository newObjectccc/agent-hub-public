import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

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
