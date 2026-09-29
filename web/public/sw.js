/**
 * Agent Hub Service Worker
 *
 * 策略：
 * - 应用壳（HTML/manifest/图标）预缓存，离线可启动；
 * - JS/CSS 等静态资源：cache-first（运行时回填缓存，Vite 带 hash 天然安全）；
 * - /api 与 /ws：纯网络，绝不缓存（WS 本身也不经过 SW）；
 * - 导航请求：network-first，失败或 404 时回退缓存的 index.html（离线启动 + SPA 路由兜底）。
 */
const CACHE = "agent-hub-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png",
];

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

  // 静态资源：cache-first + 运行时回填
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
