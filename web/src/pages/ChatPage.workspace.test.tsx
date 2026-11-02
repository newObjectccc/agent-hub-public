import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSnapshot } from "../api/types";
import { getOfflineQueue } from "../chat/offlineQueue";
import { clearWorkspaceCache } from "../hooks/useWorkspace";
import { setLocaleSetting } from "../i18n";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ getWorkspace: vi.fn(), sendPrompt: vi.fn() }));
const session: SessionSummary = { id: "context-chat", source: "codex", name: "Fix routing", cwd: "/code/project", status: "idle", updatedAt: "2026-01-01", messageCount: 0, lastUserMessage: null, lastAssistantMessage: null, sessionFile: null, isSubAgent: false };
vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, getWorkspace: mocks.getWorkspace, sendPrompt: mocks.sendPrompt,
    getSession: vi.fn(async () => ({ session, messages: [], hasMore: false, nextBefore: null })),
    getSessionAgents: vi.fn(async () => ({ agents: [] })), getGitStatus: vi.fn(async () => null),
    listHostRequests: vi.fn(async () => ({ requests: [] })), getCommands: vi.fn(async () => ({ commands: [] })),
  } };
});
vi.mock("../hooks/useSessionSocket", () => ({ useSessionSocket: () => {} }));
import { ChatPage } from "./ChatPage";
import { ApiError } from "../api/client";

function snapshot(branch = "main"): WorkspaceSnapshot {
  return { cwd: session.cwd, projectName: "project", root: session.cwd, repositoryRoot: session.cwd, isWorktree: false, kind: "git", branch, head: null, detached: false, revision: (branch === "main" ? "1" : "2").repeat(64) };
}
let root: Root, container: HTMLDivElement;
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
const click = (selector: string) => act(() => { container.querySelector<HTMLButtonElement>(selector)!.click(); });
function type(text: string) { act(() => { const input = container.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(async () => {
  localStorage.clear(); getOfflineQueue(null); clearWorkspaceCache(); setLocaleSetting("en");
  mocks.getWorkspace.mockReset().mockResolvedValue(snapshot()); mocks.sendPrompt.mockReset().mockResolvedValue({ accepted: true, mode: "prompt" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<ChatPage sessionId={session.id} />); }); await flush();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("mobile workspace admission", () => {
  it("retains the draft on a real branch change and requires a separate send after confirmation", async () => {
    type("Keep my draft"); mocks.getWorkspace.mockResolvedValue(snapshot("fix/other"));
    act(() => window.dispatchEvent(new Event("focus"))); await flush();
    expect(container.querySelector(".workspace-change-banner")).not.toBeNull();
    click(".workspace-change-banner button"); await flush();
    expect(container.querySelector(".workspace-warning")!.textContent).toContain("main");
    expect(container.querySelector("textarea")!.value).toBe("Keep my draft");
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    click(".workspace-confirm"); await flush();
    expect(container.querySelector(".workspace-change-banner")).toBeNull();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    click(".composer-send"); await flush();
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.sendPrompt.mock.calls[0][6]).toBe("2".repeat(64));
  });
  it("does not discard edits made while the preflight request was in flight", async () => {
    let resolve!: (value: WorkspaceSnapshot) => void;
    mocks.getWorkspace.mockImplementationOnce(() => new Promise<WorkspaceSnapshot>(r => { resolve = r; }));
    type("first draft"); click(".composer-send"); type("newer draft");
    await act(async () => resolve(snapshot())); await flush();
    expect(container.querySelector("textarea")!.value).toBe("newer draft");
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });
  it("remembers the reviewed branch after closing and reopening the PWA", async () => {
    act(() => root.unmount());
    mocks.getWorkspace.mockResolvedValue(snapshot("fix/other"));
    root = createRoot(container);
    await act(async () => { root.render(<ChatPage sessionId={session.id} />); }); await flush();
    expect(container.querySelector(".workspace-change-banner")).not.toBeNull();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });
  it("preserves an admission race as a manual retry with its original identity", async () => {
    mocks.sendPrompt.mockRejectedValue(new ApiError(409, "WORKSPACE_CHANGED", "changed"));
    type("must be preserved"); click(".composer-send"); await flush();
    const pending = getOfflineQueue().list();
    expect(pending).toHaveLength(1); expect(pending[0].text).toBe("must be preserved");
    expect(pending[0].workspaceRevision).toBe("1".repeat(64)); expect(pending[0].autoRetry).toBe(false);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
  });
});
