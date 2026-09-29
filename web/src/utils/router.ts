/**
 * 极简客户端路由（history API）：只有 "/"（面板）与 "/s/:id"（chat）两条路由。
 * 不引入 react-router，控制依赖体积。
 */

export type Route = { name: "home" } | { name: "chat"; id: string };

export function parseRoute(pathname: string): Route {
  const m = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (m) return { name: "chat", id: decodeURIComponent(m[1]) };
  return { name: "home" };
}

export function chatPath(id: string): string {
  return `/s/${encodeURIComponent(id)}`;
}

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function onRouteChange(handler: () => void): () => void {
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}
