/**
 * 极简客户端路由（history API）：
 *   "/"            工作台（首页：概览 + 本周统计 + 工作中/等你处理精华）
 *   "/sessions"    会话（会话列表 + tab + 新建/搜索）
 *   "/system"      系统（指标 + 环境）
 *   "/terminal"    终端（ttyd Web 终端，F2；反代 /terminal/* 与本路由不冲突）
 *   "/settings"    设置（主题/提醒通道 + 关于）
 *   "/s/:id"       chat（可带 ?q=&m= 定位参数）
 *   "/s/:id/tree"  会话分支树
 * 不引入 react-router，控制依赖体积。
 */

export type Route =
  | { name: "home" }
  | { name: "sessions" }
  | { name: "system" }
  | { name: "terminal" }
  | { name: "settings" }
  | { name: "chat"; id: string }
  | { name: "tree"; id: string };

/** 一级菜单路径（导航/深链用） */
export const HOME_PATH = "/";
export const SESSIONS_PATH = "/sessions";
export const SYSTEM_PATH = "/system";
export const TERMINAL_PATH = "/terminal";
export const SETTINGS_PATH = "/settings";

export function parseRoute(pathname: string): Route {
  const tree = pathname.match(/^\/s\/([^/]+)\/tree\/?$/);
  if (tree) return { name: "tree", id: decodeURIComponent(tree[1]) };
  const m = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (m) return { name: "chat", id: decodeURIComponent(m[1]) };
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === SESSIONS_PATH) return { name: "sessions" };
  if (normalized === SYSTEM_PATH) return { name: "system" };
  if (normalized === TERMINAL_PATH) return { name: "terminal" };
  if (normalized === SETTINGS_PATH) return { name: "settings" };
  return { name: "home" };
}

/** 一级菜单（会话外页面）路径（导航高亮 / 返回目标判定用） */
export function listPathOf(route: Route): string {
  switch (route.name) {
    case "sessions":
      return SESSIONS_PATH;
    case "system":
      return SYSTEM_PATH;
    case "terminal":
      return TERMINAL_PATH;
    case "settings":
      return SETTINGS_PATH;
    case "home":
      return HOME_PATH;
    default:
      return HOME_PATH;
  }
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

/**
 * 新建会话入口路径（sidebar/drawer 的 ?new=1 深链）：
 * 会话页内保留当前 query（如 ?tab=）仅追加 new=1；其他页直接 /sessions?new=1。
 */
export function newSessionPath(): string {
  const { pathname, search } = window.location;
  if (parseRoute(pathname).name !== "sessions") return `${SESSIONS_PATH}?new=1`;
  const params = new URLSearchParams(search);
  params.set("new", "1");
  return `${SESSIONS_PATH}?${params.toString()}`;
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

/**
 * chat 页返回目标 = 来时的列表页（工作台 / 会话 / 系统 / 设置）。
 * 模块级单例：进入 chat/tree 前记录来源列表路径；深链直达 chat 时回落 "/"。
 */
let chatReturnTo: string = HOME_PATH;

function isListPath(path: string): boolean {
  const pathname = path.split("?")[0].replace(/\/+$/, "") || "/";
  return [HOME_PATH, SESSIONS_PATH, SYSTEM_PATH, SETTINGS_PATH].includes(pathname);
}

/** chat/树页返回按钮的目标路径（浏览器后退仍走 history，不受影响） */
export function chatReturnPath(): string {
  return chatReturnTo;
}

export function navigate(path: string): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === path) return;
  // 从列表页进入 chat/tree 时记忆来源（含 ?tab= 等参数，chat 返回目标 = 来时列表页）
  const targetPath = path.split("?")[0];
  if (isListPath(current) && /^\/s\//.test(targetPath)) {
    chatReturnTo = current;
  }
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function onRouteChange(handler: () => void): () => void {
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}
