/**
 * 离线消息队列（F1）单元测试：
 * - 持久化：入队 → 新 store 重载不丢（刷新/杀 App 不丢）
 * - 按序 flush：成功出队；网络失败保留并中止（保序）；业务失败标手动后继续
 * - 附件/图片入队：未上传先补上传并回写（重试不重复上传）；超限提示（不静默丢）
 * - failedSends 融合语义：网络错误 autoRetry=true，业务拒绝 autoRetry=false
 */
import { describe, expect, it, vi } from "vitest";
import {
  appendLocalAttachmentHints,
  attachmentsOf,
  classifySendError,
  flushQueue,
  getOfflineQueue,
  MAX_QUEUE_IMAGE_BASE64,
  OfflineQueueStore,
  parseQueue,
  persistProblem,
  queuedImagesOf,
  serializeQueue,
  type FlushQueueDeps,
  type QueuedSend,
} from "./offlineQueue";
import { ApiError } from "../api/client";
import type { Attachment } from "../utils/uploads";

function fakeStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

function item(overrides: Partial<QueuedSend> = {}): QueuedSend {
  return {
    localId: `local-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "s1",
    cwd: "/tmp/demo",
    text: "你好",
    images: [],
    sendMode: "auto",
    attachMode: "prompt",
    channel: "parallel",
    queuedAt: 1000,
    attempts: 0,
    autoRetry: true,
    lastError: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<FlushQueueDeps> = {}) {
  const calls = { uploads: [] as Array<{ name: string; data: string }>, sends: [] as Array<{ text: string; images?: string[] }> };
  const uploadFile: FlushQueueDeps["uploadFile"] = vi.fn(async (input) => {
    calls.uploads.push({ name: input.name, data: input.data });
    return { upload: { path: `.agent-hub-uploads/${input.name}` } };
  });
  const sendPrompt: FlushQueueDeps["sendPrompt"] = vi.fn(async () => ({ accepted: true, mode: "prompt" as const }));
  const sendPromptWithMode: FlushQueueDeps["sendPromptWithMode"] = vi.fn(async (_id, text, _mode, _d, images) => {
    calls.sends.push({ text, images });
    return { result: { accepted: true, mode: "prompt" as const } };
  });
  const sendAttachMessage: FlushQueueDeps["sendAttachMessage"] = vi.fn(async () => ({ accepted: true }));
  const deps: FlushQueueDeps = { uploadFile, sendPrompt, sendPromptWithMode, sendAttachMessage, ...overrides };
  return { deps, calls };
}

describe("offlineQueue: 持久化与解析", () => {
  it("入队后新 store 从同一 storage 重载不丢（刷新/杀 App 不丢）", () => {
    const storage = fakeStorage();
    const store1 = new OfflineQueueStore(storage);
    store1.add(item({ text: "断网时发的消息" }));
    const store2 = new OfflineQueueStore(storage);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].text).toBe("断网时发的消息");
  });

  it("parseQueue 损坏/缺字段容错；serialize 往返稳定", () => {
    expect(parseQueue("not json")).toEqual([]);
    expect(parseQueue(JSON.stringify({ items: "x" }))).toEqual([]);
    const items = [item({ text: "a" }), item({ text: "b", channel: "attach", attachMode: "steer", autoRetry: false })];
    const round = parseQueue(serializeQueue(items));
    expect(round.map((i) => i.text)).toEqual(["a", "b"]);
    expect(round[1].channel).toBe("attach");
    expect(round[1].attachMode).toBe("steer");
    expect(round[1].autoRetry).toBe(false);
  });

  it("超限提示：单图 base64 >1MB 不持久化但保留内存态（不静默丢）", () => {
    const storage = fakeStorage();
    const store = new OfflineQueueStore(storage);
    const big = item({
      images: [{ name: "big.png", mimeType: "image/png", isImage: true, path: null, data: "x".repeat(MAX_QUEUE_IMAGE_BASE64 + 1) }],
    });
    const result = store.add(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("1MB");
    expect(store.list(), "内存态保留，本次页面内不丢").toHaveLength(1);
    expect(storage.data.size, "超限不落盘").toBe(0);
  });

  it("persistProblem：总量超 3MB 提示；正常返回 null", () => {
    expect(persistProblem([item()])).toBeNull();
    const huge = Array.from({ length: 4 }, (_, i) =>
      item({ localId: `local-${i}`, images: [{ name: "p.png", mimeType: "image/png", isImage: true, path: null, data: "y".repeat(MAX_QUEUE_IMAGE_BASE64 - 10) }] }),
    );
    const problem = persistProblem(huge);
    expect(problem).toContain("离线队列已满");
  });

  it("classifySendError：ApiError<500=业务；≥500/非 ApiError=网络", () => {
    expect(classifySendError(new ApiError(400, "INVALID_REQUEST", "x"))).toBe("business");
    expect(classifySendError(new ApiError(500, "INTERNAL", "x"))).toBe("network");
    expect(classifySendError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifySendError(new Error("网络错误"))).toBe("network");
  });

  it("attachmentsOf/queuedImagesOf 互转：图片 base64 恢复预览", () => {
    const att: Attachment = {
      id: "a1",
      name: "p.png",
      path: "",
      mimeType: "image/png",
      size: 10,
      isImage: true,
      preview: null,
      uploaded: false,
      data: "AAAA",
    };
    const images = queuedImagesOf([att]);
    expect(images[0]).toEqual({ name: "p.png", mimeType: "image/png", isImage: true, path: null, data: "AAAA" });
    const restored = attachmentsOf(item({ images }));
    expect(restored[0].preview).toBe("data:image/png;base64,AAAA");
    expect(restored[0].uploaded).toBe(false);
  });

  it("appendLocalAttachmentHints：未引用的非图片附件补 @path 提示", () => {
    expect(appendLocalAttachmentHints("看下这个", ["a.pdf"])).toBe("看下这个\n\n[附件] @a.pdf");
    expect(appendLocalAttachmentHints("看 @a.pdf", ["a.pdf"])).toBe("看 @a.pdf");
    expect(appendLocalAttachmentHints("看下这个", [])).toBe("看下这个");
  });
});

describe("offlineQueue: flush 按序重发", () => {
  it("按队列顺序发送，成功出队", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "l1", text: "第一条" }));
    store.add(item({ localId: "l2", text: "第二条" }));
    const { deps, calls } = makeDeps();
    const result = await flushQueue(store, deps);
    expect(result.sent).toEqual(["l1", "l2"]);
    expect(calls.sends.map((s) => s.text)).toEqual(["第一条", "第二条"]);
    expect(store.list()).toHaveLength(0);
  });

  it("网络失败：保留并中止本轮（顺序保留，剩余不插队）", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "l1", text: "第一条" }));
    store.add(item({ localId: "l2", text: "第二条" }));
    const { deps, calls } = makeDeps({
      sendPromptWithMode: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const result = await flushQueue(store, deps);
    expect(result.stopped).toBe(true);
    expect(calls.sends).toHaveLength(0);
    expect(store.list().map((i) => i.localId), "保序：两条都还在").toEqual(["l1", "l2"]);
    expect(store.get("l1")?.autoRetry, "网络失败 → 自动重试").toBe(true);
    expect(store.get("l1")?.attempts).toBe(1);
  });

  it("业务拒绝（4xx）：标手动重试后继续发下一条（坏消息不堵队列）", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "l1", text: "坏消息" }));
    store.add(item({ localId: "l2", text: "好消息" }));
    const sendMock = vi.fn(async (_id: string, text: string) => {
      if (text === "坏消息") throw new ApiError(400, "INVALID_REQUEST", "消息非法");
      return { result: { accepted: true, mode: "prompt" as const } };
    });
    const { deps } = makeDeps({ sendPromptWithMode: sendMock });
    const result = await flushQueue(store, deps);
    expect(result.sent).toEqual(["l2"]);
    expect(result.failed[0]).toMatchObject({ localId: "l1", kind: "business" });
    expect(store.get("l1")?.autoRetry, "业务拒绝 → 手动重试").toBe(false);
    expect(store.list().map((i) => i.localId)).toEqual(["l1"]);
    expect(sendMock.mock.calls.map((c) => c[1]), "坏消息不堵队列，后续继续").toEqual(["坏消息", "好消息"]);
  });

  it("accepted:false 视同业务失败保留；only 选项只重发指定条目", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "l1", text: "a" }));
    store.add(item({ localId: "l2", text: "b" }));
    const { deps } = makeDeps({
      sendPromptWithMode: vi.fn(async () => ({ result: { accepted: false, mode: "prompt" as const } })),
    });
    const result = await flushQueue(store, deps, { only: ["l2"] });
    expect(result.sent).toEqual([]);
    expect(store.get("l2")?.autoRetry).toBe(false);
    expect(store.get("l1")?.attempts, "only 之外不动").toBe(0);
  });

  it("图片随消息入队：未上传先补上传并回写，重试不重复上传", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(
      item({
        localId: "l1",
        text: "看图",
        images: [{ name: "p.png", mimeType: "image/png", isImage: true, path: null, data: "AAAA" }],
      }),
    );
    const sendMock = vi.fn(async (...args: unknown[]) => {
      void args;
      throw new ApiError(400, "SESSION_BUSY", "busy");
    });
    const { deps, calls } = makeDeps({ sendPromptWithMode: sendMock });
    await flushQueue(store, deps);
    expect(calls.uploads).toHaveLength(1);
    expect(sendMock.mock.calls[0][4], "上传后以路径随消息发送").toEqual([".agent-hub-uploads/p.png"]);
    // 第二轮：已回写路径，不再重复上传
    await flushQueue(store, deps);
    expect(calls.uploads).toHaveLength(1);
    expect(store.get("l1")?.images[0].path).toBe(".agent-hub-uploads/p.png");
  });

  it("附件上传网络失败：保留待发（autoRetry），不发消息", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(
      item({
        localId: "l1",
        text: "看图",
        images: [{ name: "p.png", mimeType: "image/png", isImage: true, path: null, data: "AAAA" }],
      }),
    );
    const { deps, calls } = makeDeps({
      uploadFile: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const result = await flushQueue(store, deps);
    expect(result.stopped).toBe(true);
    expect(calls.sends).toHaveLength(0);
    expect(store.get("l1")?.autoRetry).toBe(true);
  });

  it("请求挂起超时：按网络失败保留待发，队列不被永久堵死（弱网看门狗）", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "l1", text: "卡住的消息" }));
    store.add(item({ localId: "l2", text: "后面的消息" }));
    const sendMock = vi.fn(() => new Promise<never>(() => undefined));
    const { deps } = makeDeps({ sendPromptWithMode: sendMock });
    const result = await flushQueue(store, deps, { timeoutMs: 20 });
    expect(result.stopped).toBe(true);
    expect(result.failed[0].kind).toBe("network");
    expect(store.list().map((i) => i.localId), "超时条目保留，后续不插队").toEqual(["l1", "l2"]);
  });

  it("attach 通道：入终端指令队列（clientMessageId 幂等键 = localId）", async () => {
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "l1", channel: "attach", attachMode: "steer" }));
    const sendAttachMessage = vi.fn(async (...args: unknown[]) => {
      void args;
      return { accepted: true };
    });
    const { deps } = makeDeps({ sendAttachMessage });
    await flushQueue(store, deps);
    expect(sendAttachMessage).toHaveBeenCalledTimes(1);
    expect(sendAttachMessage.mock.calls[0][2]).toBe("steer");
    expect(sendAttachMessage.mock.calls[0][3]).toBe("l1");
    expect(store.list()).toHaveLength(0);
  });

  it("幂等键：超时自动重发同 clientMessageId（= localId），server 去重防同文双发", async () => {
    const cids: Array<string | undefined> = [];
    let firstAttempt = true;
    const sendPromptWithMode: FlushQueueDeps["sendPromptWithMode"] = vi.fn(
      async (_id, _text, _mode, _d, _images, clientMessageId) => {
        cids.push(clientMessageId);
        if (firstAttempt) {
          firstAttempt = false;
          throw Object.assign(new Error("请求超时，请检查网络后重试"), { name: "TimeoutError" });
        }
        return { result: { accepted: true, mode: "prompt" as const } };
      },
    );
    const { deps } = makeDeps({ sendPromptWithMode });
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "local-idem-1" }));
    const first = await flushQueue(store, deps);
    expect(first.sent).toEqual([]);
    expect(store.list(), "网络失败保留待发").toHaveLength(1);
    // 网络恢复重发：同一幂等键（同键 server 去重，不会双发双执行）
    const second = await flushQueue(store, deps);
    expect(second.sent).toEqual(["local-idem-1"]);
    expect(cids).toEqual(["local-idem-1", "local-idem-1"]);
  });

  it("409 ATTACH_ACTIVE 死锁自愈：通道校正 attach 后同键重发，不再永卡死信", async () => {
    const sendPromptWithMode: FlushQueueDeps["sendPromptWithMode"] = vi.fn(async () => {
      throw new ApiError(409, "ATTACH_ACTIVE", "终端接管中");
    });
    const sendAttachMessage = vi.fn(async (...args: unknown[]) => {
      void args;
      return { accepted: true };
    });
    const { deps } = makeDeps({ sendPromptWithMode, sendAttachMessage });
    const store = new OfflineQueueStore(fakeStorage());
    store.add(item({ localId: "local-heal-1", channel: "parallel" }));
    const result = await flushQueue(store, deps);
    expect(result.sent).toEqual(["local-heal-1"]);
    expect(result.failed).toEqual([]);
    expect(store.list(), "自愈成功出队，不再永卡手动重试").toHaveLength(0);
    // attach 通道携带同一幂等键
    expect(sendAttachMessage).toHaveBeenCalledTimes(1);
    expect(sendAttachMessage.mock.calls[0][3]).toBe("local-heal-1");
    // 通道校正已持久化（同条消息后续不再走 parallel 撞墙）
    // （条目已出队，验证点在于未再次调用 sendPromptWithMode）
    expect(sendPromptWithMode).toHaveBeenCalledTimes(1);
  });
});

describe("getOfflineQueue 单例", () => {
  it("注入 storage 后返回共享实例（页面/flush 同一队列）", () => {
    const storage = fakeStorage();
    const a = getOfflineQueue(storage);
    const b = getOfflineQueue();
    expect(a).toBe(b);
    a.add(item({ localId: "shared-1" }));
    expect(b.get("shared-1")).not.toBeNull();
  });
});
