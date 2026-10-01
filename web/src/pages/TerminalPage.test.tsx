/**
 * 终端页（/terminal，F2）单测：ttyd 未安装/不支持降级文案、按需启动 iframe 内嵌、
 * 启动失败报错、关闭回收。api 层 mock，不打真实 server。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession, TerminalStatus } from "../api/types";
import { TerminalPage } from "./TerminalPage";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  api: {
    getTerminalStatus: vi.fn(async () => null),
    startTerminalSession: vi.fn(async () => null),
    stopTerminal: vi.fn(async () => ({ stopped: true })),
  },
}));

import { api } from "../api/client";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const installedStatus: TerminalStatus = {
  supported: true,
  installed: true,
  running: false,
  version: "1.7.7",
  hint: null,
};

const notInstalledStatus: TerminalStatus = {
  supported: true,
  installed: false,
  running: false,
  version: null,
  hint: "未安装（brew install ttyd）",
};

const windowsStatus: TerminalStatus = {
  supported: false,
  installed: false,
  running: false,
  version: null,
  hint: "不支持（WSL 内可用）",
};

const sessionFixture: TerminalSession = {
  url: "/terminal/?t=secret-token",
  expiresAt: "2026-02-18T20:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(node: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

beforeEach(() => {
  vi.mocked(api.getTerminalStatus).mockReset();
  vi.mocked(api.startTerminalSession).mockReset();
  vi.mocked(api.stopTerminal).mockReset();
  vi.mocked(api.stopTerminal).mockResolvedValue({ stopped: true });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("TerminalPage：降级态", () => {
  it("ttyd 未安装：灰色安装指引，无启动按钮", async () => {
    vi.mocked(api.getTerminalStatus).mockResolvedValue(notInstalledStatus);
    const el = await render(<TerminalPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.textContent).toContain("未安装（brew install ttyd）");
    expect(el.textContent).toContain("ttyd 未安装");
    expect(el.querySelector("[aria-label='打开真终端']")).toBeNull();
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("Windows：不支持（WSL 内可用）降级说明", async () => {
    vi.mocked(api.getTerminalStatus).mockResolvedValue(windowsStatus);
    const el = await render(<TerminalPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.textContent).toContain("不支持（WSL 内可用）");
    expect(el.textContent).toContain("WSL 内可用");
    expect(el.querySelector("iframe")).toBeNull();
  });
});

describe("TerminalPage：按需启动 + iframe 内嵌", () => {
  it("点击「打开真终端」→ 签发会话并 iframe 内嵌同源反代地址", async () => {
    vi.mocked(api.getTerminalStatus).mockResolvedValue(installedStatus);
    vi.mocked(api.startTerminalSession).mockResolvedValue(sessionFixture);
    const el = await render(<TerminalPage />);
    await act(async () => {
      await Promise.resolve();
    });
    const button = el.querySelector<HTMLButtonElement>("[aria-label='打开真终端']");
    expect(button).not.toBeNull();
    expect(el.textContent).toContain("已安装");

    await act(async () => {
      button!.click();
    });
    expect(api.startTerminalSession).toHaveBeenCalledTimes(1);
    const frame = el.querySelector<HTMLIFrameElement>("iframe.terminal-frame");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("src")).toBe(sessionFixture.url);
    // 关闭/重连工具栏
    expect(el.querySelector("[aria-label='关闭终端']")).not.toBeNull();
    expect(el.querySelector("[aria-label='重新连接终端']")).not.toBeNull();
  });

  it("关闭终端 → stopTerminal 回收并退出 iframe", async () => {
    vi.mocked(api.getTerminalStatus).mockResolvedValue(installedStatus);
    vi.mocked(api.startTerminalSession).mockResolvedValue(sessionFixture);
    const el = await render(<TerminalPage />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>("[aria-label='打开真终端']")!.click();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>("[aria-label='关闭终端']")!.click();
    });
    expect(api.stopTerminal).toHaveBeenCalledTimes(1);
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("启动失败（如未安装竞态/服务不可用）→ 错误文案展示", async () => {
    vi.mocked(api.getTerminalStatus).mockResolvedValue(installedStatus);
    vi.mocked(api.startTerminalSession).mockRejectedValue(new Error("boom"));
    const el = await render(<TerminalPage />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>("[aria-label='打开真终端']")!.click();
    });
    expect(el.querySelector("[role='alert']")?.textContent).toContain("终端启动失败");
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("重新连接 → 重新签发会话（新 token）", async () => {
    vi.mocked(api.getTerminalStatus).mockResolvedValue(installedStatus);
    vi.mocked(api.startTerminalSession)
      .mockResolvedValueOnce(sessionFixture)
      .mockResolvedValueOnce({ ...sessionFixture, url: "/terminal/?t=fresh" });
    const el = await render(<TerminalPage />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>("[aria-label='打开真终端']")!.click();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>("[aria-label='重新连接终端']")!.click();
    });
    expect(api.startTerminalSession).toHaveBeenCalledTimes(2);
    expect(el.querySelector<HTMLIFrameElement>("iframe")!.getAttribute("src")).toBe("/terminal/?t=fresh");
  });
});
