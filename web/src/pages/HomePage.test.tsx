/**
 * 工作台（UX 审查 AC6）：dashboard 拉取失败不再静默——错误条（参照 SessionsPage）
 * + 重试按钮；成功后错误条消失。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getUsage: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getDashboardStats: mocks.getDashboardStats,
    getUsage: mocks.getUsage,
  },
}));

// WS 全局事件在 jsdom 无 WebSocket：mock 为空操作（本用例只测拉取失败路径）
vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: () => undefined,
}));

import { HomePage } from "./HomePage";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<HomePage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  mocks.getDashboardStats.mockReset();
  mocks.getUsage.mockReset();
  mocks.getUsage.mockResolvedValue({ windows: null });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("HomePage dashboard 错误条", () => {
  it("拉取失败显示 error-banner（不再静默）+ 重试按钮", async () => {
    mocks.getDashboardStats.mockRejectedValueOnce(new Error("boom"));
    const el = await render();
    const banner = el.querySelector(".error-banner");
    expect(banner).not.toBeNull();
    // 原始 JS 异常不裸露：友好文案
    expect(banner!.textContent).toContain("工作台数据加载失败");
    expect(banner!.textContent).not.toContain("boom");
    const retry = Array.from(banner!.querySelectorAll("button")).find((b) => b.textContent === "重试");
    expect(retry).toBeTruthy();
  });

  it("点「重试」拉取成功 → 错误条消失", async () => {
    mocks.getDashboardStats.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      workingSessions: [],
      attentionSessions: [],
    });
    const el = await render();
    expect(el.querySelector(".error-banner")).not.toBeNull();
    const retry = Array.from(el.querySelectorAll<HTMLButtonElement>(".error-banner button")).find(
      (b) => b.textContent === "重试",
    )!;
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector(".error-banner")).toBeNull();
  });

  it("拉取成功：无错误条（正常路径不打扰）", async () => {
    mocks.getDashboardStats.mockResolvedValue({ workingSessions: [], attentionSessions: [] });
    const el = await render();
    expect(el.querySelector(".error-banner")).toBeNull();
    expect(el.textContent).toContain("工作中");
  });

  it("ApiError 用服务端中文提示（业务错误可读）", async () => {
    const apiErr = new Error("会话服务未就绪");
    apiErr.name = "ApiError";
    mocks.getDashboardStats.mockRejectedValueOnce(apiErr);
    const el = await render();
    expect(el.querySelector(".error-banner")!.textContent).toContain("会话服务未就绪");
  });
});
