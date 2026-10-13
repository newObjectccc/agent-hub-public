/**
 * 产物新版本自检纯逻辑测试：入口 hash 提取与新旧判定（陈旧产物可见化的依据）。
 */
import { describe, expect, it } from "vitest";
import { extractEntryScript } from "./useNewVersion";

describe("extractEntryScript", () => {
  it("提取 index 入口脚本路径（构建指纹）", () => {
    const html = '<html><head><script type="module" src="/assets/index-Ab12Cd34.js"></script></head></html>';
    expect(extractEntryScript(html)).toBe("/assets/index-Ab12Cd34.js");
  });

  it("无入口脚本 → null（不误报新版本）", () => {
    expect(extractEntryScript("<html><body>offline</body></html>")).toBe(null);
  });

  it("懒加载 chunk 不混淆判定（只认 index- 入口）", () => {
    const html = '<script src="/assets/ChatPage-Xyz.js"></script><script src="/assets/index-QQQQ.js"></script>';
    expect(extractEntryScript(html)).toBe("/assets/index-QQQQ.js");
  });
});
