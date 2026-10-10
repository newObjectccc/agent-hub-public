/**
 * Service Worker hash 资产治理回归（OOM 审计 P2-7）：
 * 同 CACHE 内旧 hash chunk 不清理会随每次发版无限增长。
 * - put 时：新 chunk 入缓存即清同组（同名同扩展）旧 hash 版本；非 hash 资产（壳/字体/图标）永不误删。
 * - activate 时：以缓存 index.html 引用为「当前版本」白名单，清同 CACHE 内残留旧 assets。
 * sw.js 是无模块纯脚本：以函数作用域注入 self/caches/fetch/Response 假件离线驱动。
 */
import { describe, expect, it } from "vitest";
import swSource from "../public/sw.js?raw";

const ORIGIN = "https://hub.test";
/** 与 sw.js 的 CACHE 常量动态对齐（v2→v3 升级时曾锁死旧名致全红，提取防错位） */
const CACHE = /const CACHE = "([^"]+)"/.exec(swSource)?.[1] ?? "agent-hub-shell";

type Handler = (event: Record<string, unknown>) => void;

interface FakeEntry {
  url: string;
  body: string;
}

function toHref(req: string | { url?: string }): string {
  const raw = typeof req === "string" ? req : (req.url ?? "");
  return new URL(raw, ORIGIN).href;
}

class FakeCache {
  readonly entries = new Map<string, FakeEntry>();

  async match(req: string | { url?: string }): Promise<{ url: string; ok: boolean; text: () => Promise<string> } | undefined> {
    const hit = this.entries.get(toHref(req));
    return hit ? { url: hit.url, ok: true, text: async () => hit.body } : undefined;
  }

  async put(req: string | { url?: string }, res: { text: () => Promise<string> }): Promise<void> {
    const url = toHref(req);
    this.entries.set(url, { url, body: await res.text() });
  }

  async keys(): Promise<Array<{ url: string }>> {
    return [...this.entries.values()].map((e) => ({ url: e.url }));
  }

  async delete(req: string | { url?: string }): Promise<boolean> {
    return this.entries.delete(toHref(req));
  }

  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) {
      const url = toHref(u);
      this.entries.set(url, { url, body: "" });
    }
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeCache();
      this.stores.set(name, store);
    }
    return store;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async match(req: string | { url?: string }): Promise<unknown> {
    for (const store of this.stores.values()) {
      const hit = await store.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

interface FakeResponse {
  ok: boolean;
  clone: () => FakeResponse;
  text: () => Promise<string>;
}

function fakeResponse(body: string, ok = true): FakeResponse {
  const res: FakeResponse = {
    ok,
    clone: () => fakeResponse(body, ok),
    text: async () => body,
  };
  return res;
}

/** 以假 self/caches/fetch 注入执行 sw.js，返回事件处理器 */
function loadSw(caches: FakeCaches, fetchFn: (req: unknown) => Promise<FakeResponse>): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const self = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: new URL(`${ORIGIN}/sw.js`),
  };
  const factory = new Function("self", "caches", "fetch", "Response", swSource);
  factory(self, caches, fetchFn, globalThis.Response);
  return handlers;
}

/** 触发 fetch 事件并等 waitUntil 全部收尾 */
async function fireFetch(handlers: Record<string, Handler>, path: string, fetchFn: (req: unknown) => Promise<FakeResponse>): Promise<void> {
  const waits: Array<Promise<unknown>> = [];
  let respond: Promise<unknown> | null = null;
  handlers["fetch"]({
    request: { url: `${ORIGIN}${path}`, method: "GET", mode: "no-cors" },
    respondWith: (p: Promise<unknown>) => {
      respond = p;
    },
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
  });
  await respond;
  await Promise.all(waits);
}

async function fireActivate(handlers: Record<string, Handler>): Promise<void> {
  const waits: Array<Promise<unknown>> = [];
  handlers["activate"]({
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
  });
  await Promise.all(waits);
}

async function fireInstall(handlers: Record<string, Handler>): Promise<void> {
  const waits: Array<Promise<unknown>> = [];
  handlers["install"]({
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
  });
  await Promise.all(waits);
}

function has(cache: FakeCache, path: string): boolean {
  return cache.entries.has(new URL(path, ORIGIN).href);
}

describe("sw.js hash 资产治理（P2-7）", () => {
  it("put 时清同组（同名同扩展）旧 hash chunk，保留其它组与非 hash 资产", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    await cache.addAll([
      "/index.html",
      "/assets/index-OLDHASH01.js", // 同组旧 hash → 应删
      "/assets/index-OLDHASH01.css", // 同名不同扩展 → 不同组，保留
      "/assets/vendor-OLDHASH03.js", // 不同名 → 保留
      "/icons/icon-192.png", // 非 hash 资产 → 永不误删
      "/fonts/archivo-black-400-latin.woff2",
    ]);
    const fetchFn = async () => fakeResponse("// new chunk");
    const handlers = loadSw(caches, fetchFn);

    await fireFetch(handlers, "/assets/index-NEWHASH02.js", fetchFn);

    expect(has(cache, "/assets/index-NEWHASH02.js")).toBe(true); // 新 chunk 入缓存
    expect(has(cache, "/assets/index-OLDHASH01.js")).toBe(false); // 同组旧 hash 已清
    expect(has(cache, "/assets/index-OLDHASH01.css")).toBe(true); // 不同扩展不误删
    expect(has(cache, "/assets/vendor-OLDHASH03.js")).toBe(true); // 不同组不误删
    expect(has(cache, "/icons/icon-192.png")).toBe(true); // 非 hash 资产不误删
    expect(has(cache, "/fonts/archivo-black-400-latin.woff2")).toBe(true);
    expect(has(cache, "/index.html")).toBe(true);
  });

  it("activate 时按 index.html 引用清同 CACHE 内残留旧 hash chunk，旧 CACHE 整体删除", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    cache.entries.set(new URL("/index.html", ORIGIN).href, {
      url: new URL("/index.html", ORIGIN).href,
      body: '<script type="module" src="/assets/index-CURRHASH.js"></script><link href="/assets/index-CURRHASH.css">',
    });
    await cache.addAll([
      "/assets/index-CURRHASH.js", // 当前版本（被 index.html 引用）→ 保留
      "/assets/index-CURRHASH.css",
      "/assets/index-OLDHASH01.js", // 残留旧 hash → 应删
      "/assets/vendor-OLDHASH03.js", // 未被引用的旧 chunk → 应删
      "/icons/icon-512.png", // 非 hash 资产 → 保留
    ]);
    await caches.open("agent-hub-shell-v1"); // 旧版本 CACHE → 整体删除

    const handlers = loadSw(caches, async () => fakeResponse(""));
    await fireActivate(handlers);

    expect(has(cache, "/assets/index-CURRHASH.js")).toBe(true);
    expect(has(cache, "/assets/index-CURRHASH.css")).toBe(true);
    expect(has(cache, "/assets/index-OLDHASH01.js")).toBe(false);
    expect(has(cache, "/assets/vendor-OLDHASH03.js")).toBe(false);
    expect(has(cache, "/icons/icon-512.png")).toBe(true);
    expect(await caches.keys()).toEqual([CACHE]);
  });

  it("边界：index.html 不可读时保守清空全部 hashed assets（非 hash 资产保留）", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    await cache.addAll([
      "/assets/index-OLDHASH01.js",
      "/assets/index-OLDHASH01.css",
      "/manifest.json",
      "/icons/icon-192.png",
    ]);

    const handlers = loadSw(caches, async () => fakeResponse(""));
    await fireActivate(handlers);

    expect(has(cache, "/assets/index-OLDHASH01.js")).toBe(false);
    expect(has(cache, "/assets/index-OLDHASH01.css")).toBe(false);
    expect(has(cache, "/manifest.json")).toBe(true);
    expect(has(cache, "/icons/icon-192.png")).toBe(true);
  });

  it("边界：hash 短于 8 位/非 /assets/ 路径不参与清理（避免误删手写资产）", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    await cache.addAll(["/assets/v2.js", "/vendor/lib.js"]);
    const fetchFn = async () => fakeResponse("// new");
    const handlers = loadSw(caches, fetchFn);

    await fireFetch(handlers, "/assets/v1.js", fetchFn);

    expect(has(cache, "/assets/v2.js")).toBe(true); // 无 hash 形态 → 不按组清理
    expect(has(cache, "/vendor/lib.js")).toBe(true);
    expect(has(cache, "/assets/v1.js")).toBe(true); // 自身正常入缓存
  });
});

describe("sw.js 入口资产预缓存（发版后首访即预热）", () => {
  const INDEX_HTML =
    '<script type="module" crossorigin src="/assets/index-CURRHASH.js"></script>' +
    '<link rel="stylesheet" crossorigin href="/assets/index-CURRHASH.css">';

  it("install 时 index.html 引用的 /assets/*.js|css 入预缓存（连同 SHELL）", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    const fetchFn = async (req: unknown): Promise<FakeResponse> => {
      const url = String(req);
      if (url === "/index.html") return fakeResponse(INDEX_HTML);
      return fakeResponse(`// ${url}`);
    };
    const handlers = loadSw(caches, fetchFn);

    await fireInstall(handlers);

    expect(has(cache, "/assets/index-CURRHASH.js")).toBe(true); // 入口 JS 预热
    expect(has(cache, "/assets/index-CURRHASH.css")).toBe(true); // 入口 CSS 预热
    expect(has(cache, "/index.html")).toBe(true); // SHELL 同时入缓存
    expect(has(cache, "/manifest.json")).toBe(true);
    expect(has(cache, "/icons/icon-192.png")).toBe(true);
    expect(has(cache, "/fonts/space-grotesk-latin.woff2")).toBe(true);
  });

  it("单个资产 fetch 失败不阻塞安装（allSettled 容错，运行时 cache-first 再回填）", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    const fetchFn = async (req: unknown): Promise<FakeResponse> => {
      const url = String(req);
      if (url === "/index.html") return fakeResponse(INDEX_HTML);
      throw new TypeError("Failed to fetch"); // 资产拉取失败
    };
    const handlers = loadSw(caches, fetchFn);

    await expect(fireInstall(handlers)).resolves.toBeUndefined(); // install 不失败

    expect(has(cache, "/index.html")).toBe(true);
    expect(has(cache, "/assets/index-CURRHASH.js")).toBe(false); // 失败项跳过
  });

  it("index.html 不可得时跳过预缓存，SHELL 仍入缓存（不阻塞安装）", async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE);
    const fetchFn = async (): Promise<FakeResponse> => {
      throw new TypeError("Failed to fetch");
    };
    const handlers = loadSw(caches, fetchFn);

    await expect(fireInstall(handlers)).resolves.toBeUndefined();

    expect(has(cache, "/index.html")).toBe(true);
    expect(has(cache, "/manifest.json")).toBe(true);
    expect(has(cache, "/assets/index-CURRHASH.js")).toBe(false);
  });
});
