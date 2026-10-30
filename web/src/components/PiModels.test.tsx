import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { PiModelCatalog, PiModelRef } from "../api/types";
import { setLocaleSetting } from "../i18n";
import { NewSessionForm } from "./NewSessionForm";
import { modelValue, PiModelControl, PiNewModelField } from "./PiModels";

const grok: PiModelRef = { provider: "xai", id: "grok-4.5" };
const claude: PiModelRef = { provider: "anthropic", id: "claude-sonnet-4-5" };
const catalog: PiModelCatalog = { models: [{ ...grok, name: "Grok 4.5" }, { ...claude, name: "Sonnet" }],
  currentModel: claude, defaultModel: grok, warning: null };
vi.mock("../api/client", () => ({ api: { getSessionModels: vi.fn(), getPiModels: vi.fn(), setPiModel: vi.fn(), createSession: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLElement;
function render(node: React.ReactElement) { act(() => root.render(node)); }
function click(element: Element | null) { expect(element).not.toBeNull(); act(() => (element as HTMLElement).click()); }
function input(element: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true })); });
}
function choose(element: HTMLSelectElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function catalogTimer() { await act(async () => { await vi.advanceTimersByTimeAsync(301); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); setLocaleSetting("en");
  vi.mocked(api.getSessionModels).mockResolvedValue(catalog);
  vi.mocked(api.getPiModels).mockResolvedValue({ ...catalog, currentModel: null });
  vi.mocked(api.setPiModel).mockResolvedValue({ model: grok });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); setLocaleSetting("zh"); });

describe("pi model controls", () => {
  it("displays the session model separately from the saved default and switches only on explicit save", async () => {
    render(<PiModelControl sessionId="pi-1" status="error" />); await settle();
    expect(container.querySelector(".pi-model-current")?.textContent).toContain("anthropic / claude-sonnet-4-5");
    expect(container.querySelector(".pi-model-current")?.textContent).not.toContain("xai");
    click(container.querySelector(".pi-model-change")); await settle();
    expect(api.setPiModel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Your global pi default stays unchanged");
    input(container.querySelector('input[type="search"]')!, "grok");
    expect(container.querySelector('optgroup[label="xai"]')?.textContent).toContain("Grok 4.5");
    choose(container.querySelector("select")!, modelValue(grok));
    click(container.querySelector(".sheet-foot button")); await settle();
    expect(api.setPiModel).toHaveBeenCalledOnce();
    expect(api.setPiModel).toHaveBeenCalledWith("pi-1", grok);
    expect(container.querySelector(".sheet")).toBeNull();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("retains the selected model and error when a provider refuses switching", async () => {
    vi.mocked(api.setPiModel).mockRejectedValue(new Error("Model unavailable; check local pi configuration"));
    render(<PiModelControl sessionId="pi-1" status="idle" />); await settle();
    click(container.querySelector(".pi-model-change")); await settle();
    choose(container.querySelector("select")!, modelValue(grok));
    click(container.querySelector(".sheet-foot button")); await settle();
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe(modelValue(grok));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Model unavailable");
    expect(container.querySelector(".pi-model-current")?.textContent).toContain("anthropic");
  });

  it("disables switching during a run or terminal takeover", async () => {
    render(<PiModelControl sessionId="pi-1" status="running" />); await settle();
    expect(container.querySelector<HTMLButtonElement>(".pi-model-change")?.disabled).toBe(true);
    render(<PiModelControl sessionId="pi-1" status="idle" attached />); await settle();
    expect(container.querySelector<HTMLButtonElement>(".pi-model-change")?.disabled).toBe(true);
    expect(api.setPiModel).not.toHaveBeenCalled();
  });

  it("unavailable recorded choices cannot be saved and failed catalog loading can be retried", async () => {
    vi.mocked(api.getSessionModels).mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ ...catalog, models: [catalog.models[0]] });
    render(<PiModelControl sessionId="pi-1" status="idle" />); await settle();
    click(container.querySelector(".pi-model-change")); await settle();
    expect(container.querySelector<HTMLButtonElement>(".sheet-foot button")?.disabled).toBe(true);
    choose(container.querySelector("select")!, modelValue(grok));
    expect(container.querySelector<HTMLButtonElement>(".sheet-foot button")?.disabled).toBe(false);
  });

  it("new pi sessions send the exact provider/id chosen on this computer", async () => {
    vi.mocked(api.createSession).mockResolvedValue({ session: { id: "new-pi" } as never });
    const created = vi.fn();
    render(<NewSessionForm open onClose={() => {}} onCreated={created} />);
    input(container.querySelector('input[aria-label="工作目录"]')!, "/workspace/project");
    await catalogTimer();
    choose(container.querySelector("select.pi-model-select")!, modelValue(grok));
    click(container.querySelector(".sheet-foot button")); await settle();
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.createSession).toHaveBeenCalledWith("/workspace/project", undefined, "pi", grok);
    expect(created).toHaveBeenCalledOnce();
  });

  it("a late catalog from the previous cwd cannot replace the next cwd's models", async () => {
    let resolveFirst!: (value: PiModelCatalog) => void;
    vi.mocked(api.getPiModels).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ...catalog, models: [catalog.models[0]] });
    function Form({ cwd }: { cwd: string }) {
      const [value, setValue] = useState<PiModelRef>();
      return <PiNewModelField cwd={cwd} value={value} onChange={setValue} />;
    }
    render(<Form cwd="/first" />); await catalogTimer();
    render(<Form cwd="/second" />); await catalogTimer();
    choose(container.querySelector("select")!, modelValue(grok));
    await act(async () => resolveFirst({ ...catalog, models: [catalog.models[1]] }));
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe(modelValue(grok));
    expect(container.querySelector('optgroup[label="anthropic"]')).toBeNull();
  });
});
