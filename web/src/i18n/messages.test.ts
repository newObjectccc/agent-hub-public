/**
 * 漏翻守护（CI 防漏翻）：zh/en 两包 key 集合必须完全一致，
 * 外加文案非空、插值占位符一致、复数 one/other 变体成对。
 * （编译期另有 zh.ts 的 Record<MessageKey, string> 双保险，此处在运行时兜住类型断言/绕过场景）
 */
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zh } from "./zh";

type Messages = Record<string, string>;

// 测试侧统一按 string 索引访问（编译期 key 约束由 zh.ts 的 Record<MessageKey, string> 保障）
const enAll = en as Messages;
const zhAll = zh as Messages;

function placeholders(messages: Messages, key: string): string[] {
  return [...messages[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const enKeys = Object.keys(enAll).sort();
const zhKeys = Object.keys(zhAll).sort();

describe("i18n 语言包一致性守护", () => {
  it("zh/en key 集合完全一致（缺一不可、多一不可）", () => {
    expect(zhKeys).toEqual(enKeys);
  });

  it("文案非空（en/zh 均无空字符串）", () => {
    for (const key of enKeys) {
      expect(enAll[key].trim(), `en.${key} 为空`).not.toBe("");
      expect(zhAll[key].trim(), `zh.${key} 为空`).not.toBe("");
    }
  });

  it("插值占位符一致（同 key 的 {name} 集合相同，防漏参/错参）", () => {
    for (const key of enKeys) {
      expect(placeholders(zhAll, key), `key=${key} 插值占位符不一致`).toEqual(
        placeholders(enAll, key),
      );
    }
  });

  it("复数变体成对：<base>.one 与 <base>.other 同时存在", () => {
    const oneBases = enKeys.filter((k) => k.endsWith(".one")).map((k) => k.slice(0, -".one".length));
    const otherBases = enKeys
      .filter((k) => k.endsWith(".other"))
      .map((k) => k.slice(0, -".other".length));
    expect(oneBases.sort()).toEqual(otherBases.sort());
  });
});
