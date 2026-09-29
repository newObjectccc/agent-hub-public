/**
 * 极简路由单测：一级菜单深链、chat 定位参数、chat 返回目标 = 来时列表页。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  HOME_PATH,
  SESSIONS_PATH,
  SETTINGS_PATH,
  SYSTEM_PATH,
  chatPath,
  chatReturnPath,
  listPathOf,
  navigate,
  parseRoute,
  treePath,
} from "./router";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("parseRoute：一级菜单深链", () => {
  it("/ → home；/sessions、/system、/settings 各自直达（含尾斜杠）", () => {
    expect(parseRoute("/")).toEqual({ name: "home" });
    expect(parseRoute("/sessions")).toEqual({ name: "sessions" });
    expect(parseRoute("/sessions/")).toEqual({ name: "sessions" });
    expect(parseRoute("/system")).toEqual({ name: "system" });
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
  });

  it("/s/:id → chat；/s/:id/tree → tree（id URL 解码）", () => {
    expect(parseRoute("/s/abc123")).toEqual({ name: "chat", id: "abc123" });
    expect(parseRoute("/s/abc123/tree")).toEqual({ name: "tree", id: "abc123" });
    expect(parseRoute("/s/a%2Fb")).toEqual({ name: "chat", id: "a/b" });
  });

  it("未知路径回落 home（不炸）", () => {
    expect(parseRoute("/unknown")).toEqual({ name: "home" });
    expect(parseRoute("")).toEqual({ name: "home" });
  });
});

describe("chat/tree 路径与定位参数", () => {
  it("chatPath 带 ?q= / ?m=；treePath 固定 /tree", () => {
    expect(chatPath("s1")).toBe("/s/s1");
    expect(chatPath("s1", { q: "KPI" })).toBe("/s/s1?q=KPI");
    expect(chatPath("s1", { messageId: "e5" })).toBe("/s/s1?m=e5");
    expect(treePath("s1")).toBe("/s/s1/tree");
  });
});

describe("chat 返回目标 = 来时的列表页", () => {
  it("从 /sessions 进 chat，chatReturnPath 回 /sessions；从 /system 进则回 /system", () => {
    window.history.replaceState({}, "", SESSIONS_PATH);
    navigate(chatPath("s1"));
    expect(chatReturnPath()).toBe(SESSIONS_PATH);

    window.history.replaceState({}, "", SYSTEM_PATH);
    navigate(chatPath("s2"));
    expect(chatReturnPath()).toBe(SYSTEM_PATH);

    window.history.replaceState({}, "", SETTINGS_PATH);
    navigate(chatPath("s3"));
    expect(chatReturnPath()).toBe(SETTINGS_PATH);
  });

  it("来源带 ?tab= 参数时原样记忆（返回后分类不丢）", () => {
    window.history.replaceState({}, "", `${SESSIONS_PATH}?tab=working`);
    navigate(chatPath("s1"));
    expect(chatReturnPath()).toBe(`${SESSIONS_PATH}?tab=working`);
  });

  it("chat 之间互相跳转不覆盖返回目标（仍指最初列表页）", () => {
    window.history.replaceState({}, "", SESSIONS_PATH);
    navigate(chatPath("s1"));
    navigate(chatPath("s2"));
    expect(chatReturnPath()).toBe(SESSIONS_PATH);
  });

  it("listPathOf 与 NAV 路径一致", () => {
    expect(listPathOf({ name: "home" })).toBe(HOME_PATH);
    expect(listPathOf({ name: "sessions" })).toBe(SESSIONS_PATH);
    expect(listPathOf({ name: "system" })).toBe(SYSTEM_PATH);
    expect(listPathOf({ name: "settings" })).toBe(SETTINGS_PATH);
    expect(listPathOf({ name: "chat", id: "x" })).toBe(HOME_PATH);
  });
});
