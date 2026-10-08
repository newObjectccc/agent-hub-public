/**
 * 横幅「已关闭/已读」记忆：解析安全收敛 + localStorage 持久化（刷新后不重复弹）。
 */
import { describe, expect, it } from "vitest";
import {
  loadDismissedIds,
  NOTICE_DISMISS_KEY,
  NOTICE_DISMISS_MAX,
  parseDismissedIds,
  recordDismissedId,
  type StorageLike,
} from "./noticeDismiss";

function memStorage(initial?: Record<string, string>): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe("parseDismissedIds", () => {
  it("非法输入安全回落空列表（纯函数）", () => {
    expect(parseDismissedIds(undefined)).toEqual([]);
    expect(parseDismissedIds("x")).toEqual([]);
    expect(parseDismissedIds([1, null, "a"])).toEqual(["a"]);
  });

  it("超长列表只留最新 MAX 条", () => {
    const many = Array.from({ length: NOTICE_DISMISS_MAX + 10 }, (_, i) => `n${i}`);
    const parsed = parseDismissedIds(many);
    expect(parsed).toHaveLength(NOTICE_DISMISS_MAX);
    expect(parsed[0]).toBe("n10");
  });
});

describe("loadDismissedIds / recordDismissedId", () => {
  it("读写闭环：记录后可从同一存储读回（刷新后不重复弹的持久化）", () => {
    const storage = memStorage();
    recordDismissedId(storage, "n1", []);
    recordDismissedId(storage, "n2", ["n1"]);
    expect(loadDismissedIds(storage)).toEqual(["n1", "n2"]);
    expect(JSON.parse(storage.data.get(NOTICE_DISMISS_KEY)!)).toEqual(["n1", "n2"]);
  });

  it("去重 + 只留最新 MAX 条", () => {
    const storage = memStorage();
    let ids = recordDismissedId(storage, "n1", []);
    ids = recordDismissedId(storage, "n1", ids);
    expect(ids).toEqual(["n1"]);
    const many = Array.from({ length: NOTICE_DISMISS_MAX }, (_, i) => `n${i}`);
    ids = recordDismissedId(storage, "tail", many);
    expect(ids).toHaveLength(NOTICE_DISMISS_MAX);
    expect(ids[ids.length - 1]).toBe("tail");
    expect(ids).not.toContain("n0");
  });

  it("storage 不可用/写失败：仅内存生效不抛错", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {
        throw new Error("no");
      },
    };
    expect(loadDismissedIds(broken)).toEqual([]);
    expect(loadDismissedIds(null)).toEqual([]);
    expect(recordDismissedId(broken, "n1", [])).toEqual(["n1"]);
    expect(recordDismissedId(null, "n1", [])).toEqual(["n1"]);
  });

  it("存储内容损坏（非法 JSON）→ 回落空列表", () => {
    const storage = memStorage({ [NOTICE_DISMISS_KEY]: "{oops" });
    expect(loadDismissedIds(storage)).toEqual([]);
  });
});
