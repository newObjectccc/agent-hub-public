/**
 * 极简客户端路由（history API）：
 *   "/"            面板
 *   "/s/:id"       chat（可带 ?q=&m= 定位参数）
 *   "/s/:id/tree"  会话分支树
 * 不引入 react-router，控制依赖体积。
 */

export type Route = { name: "home" } | { name: "chat"; id: string } | { name: "tree"; id: string };

export function parseRoute(pathname: string): Route {
  const tree = pathname.match(/^\/s\/([^/]+)\/tree\/?$/);
  if (tree) return { name: "tree", id: decodeURIComponent(tree[1]) };
  const m = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (m) return { name: "chat", id: decodeURIComponent(m[1]) };
  return { name: "home" };
}

export interface ChatLocate {
  /** 搜索关键词（chat 页高亮/滚动到首个匹配消息） */
  q?: string;
  /** 命中消息 entry id（精确锚点，优先于 q） */
  messageId?: string;
}

/** chat 路径（可选定位参数 ?q=&m=） */
export function chatPath(id: string, locate?: ChatLocate): string {
  const base = `/s/${encodeURIComponent(id)}`;
  const params = new URLSearchParams();
  if (locate?.q) params.set("q", locate.q);
  if (locate?.messageId) params.set("m", locate.messageId);
  const qs = params.toString();
  return qs === "" ? base : `${base}?${qs}`;
}

export function treePath(id: string): string {
  return `/s/${encodeURIComponent(id)}/tree`;
}

/** 当前 URL 的定位参数 */
export function currentLocate(): ChatLocate {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q") ?? "";
  const m = params.get("m") ?? "";
  return { q: q === "" ? undefined : q, messageId: m === "" ? undefined : m };
}

export function navigate(path: string): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function onRouteChange(handler: () => void): () => void {
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}
