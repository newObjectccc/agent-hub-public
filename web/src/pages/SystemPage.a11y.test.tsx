/**
 * 系统页（SystemPage → SystemStatusBar）a11y 审查测试（P2）：
 * 图标按钮逐个过——终端入口按钮须有 aria-label；指标进度条/分区均有可读名；
 * 降级说明以可见文本兜底（不再挂无效 aria-label）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemStatus } from "../api/types";
import { SystemPage } from "./SystemPage";

vi.mock("../api/client", () => ({
  api: {
    getSystem: vi.fn(async () => null),
  },
}));

import { api } from "../api/client";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeSystem(): SystemStatus {
  return {
    platform: "darwin",
    pi: { available: true, version: "0.87.1" },
    claude: { available: true, version: "2.1.267" },
    tmux: { available: true, version: "3.4" },
    ttyd: { available: true, version: "4.0.0" },
    tailscale: { available: true, version: "1.0", loggedIn: true, hostname: "my-mac" },
    sessionDir: "/tmp/sessions",
    workspaceRoot: "/tmp/ws",
    metrics: {
      cpu: { usagePercent: 42.5, cores: 8 },
      memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, usagePercent: 50 },
      disk: { usedBytes: 400 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3, usagePercent: 47, mount: "/" },
      loadavg: [1.5, 1.2, 0.9],
      uptimeSeconds: 90_060,
      sampledAt: "2026-02-18T12:00:00.000Z",
    },
    terminal: { supported: true, installed: true, running: false, version: "4.0.0", hint: null },
  };
}

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

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** 可访问名：aria-label 或可见文本兜底 */
function accessibleName(el: HTMLElement): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

describe("SystemPage a11y（图标按钮逐个过）", () => {
  it("所有按钮均有可访问名；终端入口图标按钮带 aria-label=打开终端", async () => {
    vi.mocked(api.getSystem).mockResolvedValue(makeSystem());
    const el = await render(<SystemPage />);

    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(accessibleName(b), `按钮缺少可访问名：${b.outerHTML.slice(0, 120)}`).not.toBe("");
    }
    const entry = el.querySelector<HTMLButtonElement>("button.terminal-entry");
    expect(entry).not.toBeNull();
    expect(entry!.getAttribute("aria-label")).toBe("打开终端");
    expect(entry!.getAttribute("title")).toBe("ttyd Web 终端");
  });

  it("指标进度条与分区均有可读名（progressbar / group）", async () => {
    vi.mocked(api.getSystem).mockResolvedValue(makeSystem());
    const el = await render(<SystemPage />);

    const bars = [...el.querySelectorAll<HTMLElement>('[role="progressbar"]')];
    expect(bars.map((b) => b.getAttribute("aria-label")).sort()).toEqual(["CPU使用率", "内存使用率", "磁盘使用率"]);
    expect(el.querySelector('[role="group"][aria-label="系统状态"]')).not.toBeNull();
    expect(el.querySelector('[role="group"][aria-label="环境"]')).not.toBeNull();
  });

  it("终端未安装时降级说明可见文本兜底可访问名（不挂无效 aria-label）", async () => {
    const noTtyd = makeSystem();
    noTtyd.ttyd = { available: false, version: null };
    noTtyd.terminal = { supported: true, installed: false, running: false, version: null, hint: "brew install ttyd" };
    vi.mocked(api.getSystem).mockResolvedValue(noTtyd);
    const el = await render(<SystemPage />);

    expect(el.querySelector("button.terminal-entry")).toBeNull();
    const degraded = el.querySelector<HTMLElement>("span.terminal-entry");
    expect(degraded).not.toBeNull();
    expect(degraded!.textContent).toContain("brew install ttyd");
    expect(degraded!.hasAttribute("aria-label")).toBe(false);
  });
});
