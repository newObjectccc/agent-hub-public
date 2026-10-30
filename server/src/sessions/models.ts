import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ErrorCodes, HubError } from "../errors.js";
import type { PiModelCatalog, PiModelRef } from "../types.js";
import { parseSessionJsonl, selectActiveBranch } from "./scan.js";

export type PiRuntime = Pick<ModelRuntime, "getModels" | "getModel" | "getAvailableSnapshot" | "getError">
  & Partial<Pick<ModelRuntime, "refresh">>;
export type PiResolvedModel = ReturnType<ModelRuntime["getModels"]>[number];

export function parsePiModel(value: unknown): PiModelRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "model 必须包含 provider 和 id");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "provider" && key !== "id")) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "model 只接受 provider 和 id，不接受密钥或其他配置");
  }
  for (const key of ["provider", "id"] as const) {
    const part = raw[key];
    if (typeof part !== "string" || part.trim() === "" || part.length > 512 || /[\u0000-\u001f\u007f]/.test(part)) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, `model.${key} 必须是有效的非空名称`);
    }
  }
  return { provider: (raw.provider as string).trim(), id: (raw.id as string).trim() };
}

export function modelRef(value: { provider?: unknown; id?: unknown } | null | undefined): PiModelRef | null {
  return value && typeof value.provider === "string" && typeof value.id === "string"
    ? { provider: value.provider, id: value.id } : null;
}

/** Read the active branch without opening/migrating a SessionManager or modifying the file. */
export function recordedPiModel(content: string): { model: PiModelRef | null; leafId: string | null } {
  const branch = selectActiveBranch(parseSessionJsonl(content).entries);
  const change = [...branch].reverse().find((entry) => entry.type === "model_change"
    && typeof entry.provider === "string" && typeof entry.modelId === "string");
  const assistant = [...branch].reverse().find((entry) => {
    const message = entry.message as Record<string, unknown> | null | undefined;
    return entry.type === "message" && message?.role === "assistant"
      && typeof message.provider === "string" && typeof message.model === "string";
  });
  const message = assistant?.message as Record<string, unknown> | undefined;
  const model = change ? { provider: change.provider as string, id: change.modelId as string }
    : message ? { provider: message.provider as string, id: message.model as string } : null;
  const leaf = branch.at(-1);
  return { model, leafId: typeof leaf?.id === "string" ? leaf.id : null };
}

export interface PiModelsOptions {
  runtime?: () => Promise<PiRuntime>;
  defaults?: (cwd: string) => PiModelRef | null;
}

export class PiModels {
  constructor(private readonly options: PiModelsOptions = {}) {}

  async runtime(): Promise<PiRuntime> {
    // Match the SDK's local models.json/auth/catalog discovery. Listing never probes a model endpoint.
    return this.options.runtime ? this.options.runtime() : ModelRuntime.create({ allowModelNetwork: false });
  }

  private defaults(cwd: string): PiModelRef | null {
    if (this.options.defaults) return this.options.defaults(cwd);
    const settings = SettingsManager.create(cwd);
    const provider = settings.getDefaultProvider(), id = settings.getDefaultModel();
    return provider && id ? { provider, id } : null;
  }

  async catalog(cwd: string, currentModel: PiModelRef | null = null, runtime?: PiRuntime): Promise<PiModelCatalog> {
    await this.validateCwd(cwd);
    const modelsRuntime = runtime ?? await this.runtime();
    const models = modelsRuntime.getAvailableSnapshot().map((model) => ({
      provider: model.provider, id: model.id, name: model.name,
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    const defaultModel = this.defaults(cwd);
    const expected = currentModel ?? defaultModel;
    const missing = expected && !models.some((model) => model.provider === expected.provider && model.id === expected.id);
    const warning = modelsRuntime.getError()
      ? "本机 pi 模型配置有错误，请检查配置；这里只显示可识别的已配置模型。"
      : missing ? "会话或默认模型在 Hub 当前环境中不可用。请选择其他模型，或检查启动 Hub 的用户、环境变量及 pi 配置。"
      : models.length === 0 ? "Hub 当前环境没有可用的已配置模型。请在同一用户和环境中登录 pi 的 provider，再刷新列表。" : null;
    return { models, defaultModel, currentModel, warning };
  }

  async resolve(choice: PiModelRef, runtime?: PiRuntime): Promise<{ model: PiResolvedModel; runtime: PiRuntime }> {
    const modelsRuntime = runtime ?? await this.runtime();
    const model = modelsRuntime.getModel(choice.provider, choice.id);
    const available = modelsRuntime.getAvailableSnapshot().some((item) => item.provider === choice.provider && item.id === choice.id);
    if (!model || !available) {
      throw new HubError(ErrorCodes.MODEL_UNAVAILABLE,
        "所选模型在 Hub 当前环境中不可用。请刷新模型列表，并检查本机 pi 登录、模型目录和启动 Hub 的环境；不会自动改用其他 provider。", 400);
    }
    return { model, runtime: modelsRuntime };
  }

  async validateCwd(cwd: string): Promise<void> {
    if (!isAbsolute(cwd)) throw new HubError(ErrorCodes.INVALID_CWD, "cwd 必须是绝对路径");
    try { if ((await stat(cwd)).isDirectory()) return; } catch { /* same public error for missing/inaccessible paths */ }
    throw new HubError(ErrorCodes.INVALID_CWD, "cwd 不存在或不是目录");
  }
}
