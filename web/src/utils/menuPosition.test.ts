/**
 * 长按菜单定位纯函数（utils/menuPosition.ts）：
 * 按压点锚定居中 + 视口 8px margin clamp + 底部放不下上翻（修长消息菜单飞出屏幕旧 bug）。
 */
import { describe, expect, it } from "vitest";
import { layoutMenu } from "./menuPosition";

describe("layoutMenu", () => {
  it("视口中间：菜单中心压在锚点上", () => {
    const r = layoutMenu({
      anchorX: 200,
      anchorY: 400,
      width: 100,
      height: 50,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    expect(r).toEqual({ left: 150, top: 375 });
  });

  it("锚点靠近左缘：clamp 进 margin（8px）", () => {
    const r = layoutMenu({
      anchorX: 10,
      anchorY: 400,
      width: 100,
      height: 50,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    expect(r.left).toBe(8);
  });

  it("锚点贴近屏幕底部：菜单上翻到锚点上方", () => {
    const r = layoutMenu({
      anchorX: 200,
      anchorY: 790,
      width: 100,
      height: 50,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    // 上翻：bottom = 790 + 25 = 815 > 800-8 → 上翻后 top 在锚点上方
    expect(r.top + 50).toBeLessThanOrEqual(790);
    expect(r.top).toBeGreaterThanOrEqual(8);
  });

  it("锚点贴近屏幕顶部（上翻也放不下）：贴上边 margin", () => {
    const r = layoutMenu({
      anchorX: 200,
      anchorY: 12,
      width: 100,
      height: 50,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    expect(r.top).toBe(8);
  });

  it("菜单比视口还大：贴 margin 起点（clamp 下限优先）", () => {
    const r = layoutMenu({
      anchorX: 200,
      anchorY: 400,
      width: 500,
      height: 900,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    expect(r).toEqual({ left: 8, top: 8 });
  });

  it("jsdom 退化（尺寸 0）：锚点即左上角，不越界", () => {
    const r = layoutMenu({
      anchorX: 123,
      anchorY: 456,
      width: 0,
      height: 0,
      viewportWidth: 0,
      viewportHeight: 0,
    });
    expect(r.left).toBe(8); // 视口 0 → clamp 到 margin 下限
    expect(r.top).toBe(8);
  });
});
