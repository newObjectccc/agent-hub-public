/**
 * 系统状态区（真实指标主视觉）单测：指标条渲染、采集失败降级、8s 轮询。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemMetrics, SystemStatus } from "../api/types";
import { fmtBytes, fmtPercent, fmtUptime, SystemStatusBar } from "./SystemStatus";

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

const metricsFixture: SystemMetrics = {
  cpu: { usagePercent: 42.5, cores: 8 },
  memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, usagePercent: 50 },
  disk: { usedBytes: 400 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3, usagePercent: 47, mount: "/" },
  loadavg: [1.5, 1.2, 0.9],
  uptimeSeconds: 90_060,
  sampledAt: "2026-02-18T12:00:00.000Z",
};

function makeSystem(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    platform: "darwin",
    pi: { available: true, version: "0.87.1" },
    claude: { available: true, version: "2.1.267" },
    tmux: { available: true, version: "3.4" },
    ttyd: { available: false, version: null },
    tailscale: { available: true, version: "1.0", loggedIn: true, hostname: "my-mac" },
    sessionDir: "/tmp/sessions",
    workspaceRoot: "/tmp/ws",
    metrics: metricsFixture,
    ...over,
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

beforeEach(() => {
  vi.mocked(api.getSystem).mockClear();
  vi.mocked(api.getSystem).mockResolvedValue(makeSystem());
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("SystemStatusBar 指标条", () => {
  it("渲染 CPU / 内存 / 磁盘 三行：百分比 + 数字明细 + 进度条宽度", async () => {
    const el = await render(<SystemStatusBar system={makeSystem()} />);
    const text = el.textContent ?? "";
    expect(text).toContain("CPU");
    expect(text).toContain("内存");
    expect(text).toContain("磁盘");
    // 百分比与数字明细
    expect(text).toContain("42.5%");
    expect(text).toContain("50%");
    expect(text).toContain("47%");
    expect(text).toContain("8 核");
    expect(text).toContain("8.0 GB / 16.0 GB");
    expect(text).toContain("400.0 GB / 1000.0 GB");
    // 进度条宽度与数值一致
    const fills = el.querySelectorAll(".metric-fill");
    expect(fills).toHaveLength(3);
    expect((fills[0] as HTMLElement).style.width).toBe("42.5%");
    expect((fills[1] as HTMLElement).style.width).toBe("50%");
    // 负载 / 运行时长 / 环境行
    expect(text).toContain("load 1.50 1.20 0.90");
    expect(text).toContain("运行 1d 1h");
    expect(text).toContain("环境");
  });

  it("metrics 缺省（旧 server / 采集失败）优雅降级：不显示假数字", async () => {
    const el = await render(<SystemStatusBar system={makeSystem({ metrics: null })} />);
    const text = el.textContent ?? "";
    expect(text).toContain("指标不可用");
    expect(text).not.toContain("%");
    expect(text).not.toContain("GB");
  });

  it("磁盘单项失败（disk=null）→ 磁盘行降级为破折号，CPU/内存照常", async () => {
    const el = await render(
      <SystemStatusBar system={makeSystem({ metrics: { ...metricsFixture, disk: null } })} />,
    );
    const text = el.textContent ?? "";
    expect(text).toContain("42.5%");
    expect(text).toContain("不可用");
    const na = el.querySelector(".metric.na");
    expect(na).not.toBeNull();
    expect(na?.textContent).toContain("—");
  });

  it("进度条 ≥85% 转警示色（.warn）", async () => {
    const hot = makeSystem({
      metrics: { ...metricsFixture, cpu: { usagePercent: 92, cores: 8 } },
    });
    const el = await render(<SystemStatusBar system={hot} />);
    const fills = el.querySelectorAll(".metric-fill");
    expect(fills[0].classList.contains("warn")).toBe(true);
    expect(fills[1].classList.contains("warn")).toBe(false);
  });

  it("system 为 null 时显示加载态", async () => {
    const el = await render(<SystemStatusBar system={null} />);
    expect(el.textContent).toContain("系统状态加载中");
  });
});

describe("SystemStatusBar 指标轮询（8s）", () => {
  it("每 8s 拉取 /api/system 并更新指标；失败保留上次值", async () => {
    vi.useFakeTimers();
    const el = await render(<SystemStatusBar system={makeSystem()} />);
    expect(vi.mocked(api.getSystem)).not.toHaveBeenCalled();

    vi.mocked(api.getSystem).mockResolvedValue(
      makeSystem({ metrics: { ...metricsFixture, cpu: { usagePercent: 77, cores: 8 } } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(vi.mocked(api.getSystem)).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("77%");

    // 下一轮失败：保留 77% 不清空
    vi.mocked(api.getSystem).mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(el.textContent).toContain("77%");
  });
});

describe("格式化纯函数", () => {
  it("fmtBytes：GB / MB / KB 分档", () => {
    expect(fmtBytes(16 * 1024 ** 3)).toBe("16.0 GB");
    expect(fmtBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(fmtBytes(2048 * 1024)).toBe("2 MB");
  });

  it("fmtPercent：整数不带小数，小数 1 位", () => {
    expect(fmtPercent(47)).toBe("47%");
    expect(fmtPercent(42.5)).toBe("42.5%");
  });

  it("fmtUptime：d/h/m 分档", () => {
    expect(fmtUptime(90_060)).toBe("1d 1h");
    expect(fmtUptime(5 * 3600 + 12 * 60)).toBe("5h 12m");
    expect(fmtUptime(23 * 60)).toBe("23m");
  });
});
