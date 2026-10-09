/**
 * Agent Hub Service Worker
 *
 * 策略：
 * - 应用壳（HTML/manifest/图标）预缓存，离线可启动；
 * - JS/CSS 等静态资源：cache-first（运行时回填缓存，Vite 带 hash 天然安全）；
 * - hash 资产治理（P2-7）：同 CACHE 内旧 hash chunk 不清会随每次发版无限增长——
 *   put 时清同组（同名同扩展）旧 hash，activate 时按 index.html 引用清同 CACHE 内残留旧 assets；
 * - /api 与 /ws：纯网络，绝不缓存（WS 本身也不经过 SW）；
 * - 导航请求：network-first，失败或 404 时回退缓存的 index.html（离线启动 + SPA 路由兜底）。
 */
const CACHE = "agent-hub-shell-v2"; // v2: Neobrutalism UI — bump forces SW update, purges old shell
const SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/fonts/archivo-black-400-latin.woff2",
  "/fonts/space-grotesk-latin.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png",
];

/** Vite hash 产物形态：/assets/<name>-<hash>.<ext>（hash ≥ 8 位）；同名同扩展视为同组 */
const HASHED_ASSET_RE = /^\/assets\/(.+)-[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9]+)$/;

/** 归属组（name+ext）；非 hash 资产（壳/字体/图标）返回 null，永不参与清理 */
function hashedAssetGroup(pathname) {
  const m = HASHED_ASSET_RE.exec(pathname);
  return m ? m[1] + "|" + m[2] : null;
}

/**
 * put 时清同组旧 hash chunk（P2-7）：新 chunk 入缓存时把同名同扩展的旧 hash 版本删掉，
 * 同 CACHE 内旧 assets 不再随发版无限累积。group=null（非 hash 资产）不动。
 */
async function deleteStaleSiblings(cache, pathname) {
  const group = hashedAssetGroup(pathname);
  if (group === null) return;
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const p = new URL(req.url).pathname;
        return p !== pathname && hashedAssetGroup(p) === group;
      })
      .map((req) => cache.delete(req)),
  );
}

/**
 * activate 时清同 CACHE 内残留的旧 hash chunk（P2-7）：以缓存的 index.html 引用为
 * 「当前版本」白名单，其余 hashed assets 删除（下次访问 cache-first 自动回填，代价一次下载）；
 * 索引不可读时保守全清。
 */
async function purgeStaleAssets(cache) {
  const keep = new Set();
  try {
    const index = await cache.match("/index.html");
    if (index) {
      const html = await index.text();
      for (const m of html.matchAll(/\/assets\/[^"'\s)>]+/g)) {
        keep.add(new URL(m[0], self.location.origin).pathname);
      }
    }
  } catch {
    /* 索引不可读：保守全清 hashed assets */
  }
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const p = new URL(req.url).pathname;
        return hashedAssetGroup(p) !== null && !keep.has(p);
      })
      .map((req) => cache.delete(req)),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => caches.open(CACHE))
      .then((cache) => purgeStaleAssets(cache)) // 同 CACHE 内旧 hash chunk 治理（P2-7）
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API / WS 走网络，不缓存
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return;
  if (event.request.method !== "GET") return;

  // 导航：network-first，失败回退应用壳（离线启动 / SPA 路由）
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // 静态资源：cache-first + 运行时回填（put 时按 hash 清同组旧 chunk，P2-7）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          event.waitUntil(
            caches
              .open(CACHE)
              .then((cache) => deleteStaleSiblings(cache, url.pathname).then(() => cache.put(event.request, copy))),
          );
        }
        return res;
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
