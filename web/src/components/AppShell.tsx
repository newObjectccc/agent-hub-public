/**
 * 全局导航框架（野兽派，移动优先）：
 * - 移动端（<768px）：固定顶部 header（左上角汉堡 → 抽屉 drawer 滑出菜单，
 *   遮罩点击 / 右滑关闭）；header 中间页面标题、右侧搜索 + 通知铃铛。
 * - 大屏（≥768px）：左侧固定 sidebar 菜单（常驻可见 ~220px），内容区居中限宽；
 *   header 保留（标题 + 搜索 + 铃铛），汉堡隐藏。
 * - 菜单：🏠 工作台 / 💬 会话 / 🖥 系统 / ⚙️ 设置；drawer 内含 ➕新建会话。
 * - 动画 220ms 开合（reduced-motion 直接显隐）；路由可深链，菜单项即一级路由。
 */
import { useMemo, useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { api } from "../api/client";
import type { NotificationItem } from "../api/types";
import { unreadCountOf } from "../utils/notifications";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  HOME_PATH,
  SESSIONS_PATH,
  SETTINGS_PATH,
  SYSTEM_PATH,
  TERMINAL_PATH,
  navigate,
  newSessionPath,
  type Route,
} from "../utils/router";
import { NotificationCenter } from "./NotificationCenter";
import { SearchPanel } from "./SearchPanel";
import { MenuIcon, PlusIcon, SearchIcon, CloseIcon } from "./icons";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/provider";
import type { MessageKey } from "../i18n";

export interface NavItem {
  path: string;
  icon: string;
  label: MessageKey;
  routeName: Route["name"];
}

/** 一级菜单（drawer / sidebar 共用）：label 为 i18n key，渲染时 t() 出文案 */
export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { path: HOME_PATH, icon: "🏠", label: "nav.home", routeName: "home" },
  { path: SESSIONS_PATH, icon: "💬", label: "nav.sessions", routeName: "sessions" },
  { path: SYSTEM_PATH, icon: "🖥", label: "nav.system", routeName: "system" },
  { path: TERMINAL_PATH, icon: "⌨️", label: "nav.terminal", routeName: "terminal" },
  { path: SETTINGS_PATH, icon: "⚙️", label: "nav.settings", routeName: "settings" },
];

export const PAGE_TITLES: Record<Route["name"], MessageKey> = {
  home: "page.title.home",
  sessions: "page.title.sessions",
  system: "page.title.system",
  terminal: "page.title.terminal",
  settings: "page.title.settings",
  chat: "page.title.chat",
  tree: "page.title.tree",
};

/** 右滑关闭阈值（px） */
const SWIPE_CLOSE_PX = 60;

export interface AppShellProps {
  route: Route;
  children: ReactNode;
}

export function AppShell({ route, children }: AppShellProps) {
  const isMobile = useIsMobile();
  const t = useT();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  /** 未读角标从列表派生（角标数 = 列表未读数 = 点击后递减） */
  const unreadCount = useMemo(() => unreadCountOf(notifications), [notifications]);
  const [notifLoaded, setNotifLoaded] = useState(false);
  /** drawer 右滑手势起点（null = 未在滑动） */
  const swipeRef = useRef<{ startX: number; startY: number } | null>(null);

  const refreshNotifications = useCallback(async () => {
    try {
      const res = await api.getNotifications();
      setNotifications(res.notifications ?? []);
    } catch {
      // 通知拉取失败静默：保持上次数据（铃铛面板内可手动刷新）
    } finally {
      setNotifLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  // WS 新通知实时并入（与面板页共用一份通知数据源口径）；断线重连补拉（断线期间广播全丢）
  useGlobalEvents({
    onNotification: () => void refreshNotifications(),
    onReconnect: () => void refreshNotifications(),
  });

  /** 点击通知条目：标记该条已读（乐观递减角标） */
  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await api.markNotificationsRead([id]);
    } catch {
      void refreshNotifications();
    }
  }, [refreshNotifications]);

  const markAllRead = useCallback(async () => {
    // 乐观清零 + 服务端持久化（失败时回滚对齐服务端状态，参照单条 markRead 的回滚模式）
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await api.markNotificationsRead();
    } catch {
      void refreshNotifications();
    }
  }, [refreshNotifications]);

  const go = (path: string): void => {
    setDrawerOpen(false);
    navigate(path);
  };

  // 路由变化（含浏览器前进后退）自动收起 drawer
  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  // 抽屉右滑关闭（touch 手势）；reduced-motion 下同样可用（非动画路径）
  const onTouchStart = (e: ReactTouchEvent): void => {
    const t = e.touches[0];
    swipeRef.current = { startX: t.clientX, startY: t.clientY };
  };
  const onTouchEnd = (e: ReactTouchEvent): void => {
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.startX;
    const dy = Math.abs(t.clientY - swipe.startY);
    if (dx > SWIPE_CLOSE_PX && dy < SWIPE_CLOSE_PX) setDrawerOpen(false);
  };

  const activeName = route.name;

  return (
    <div className="app-shell">
      <header className="shell-header">
        {isMobile ? (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="min-h-[44px] min-w-[44px] shell-burger"
            aria-label="菜单"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <MenuIcon />
          </Button>
        ) : (
          <span className="shell-burger-slot" aria-hidden />
        )}
        <h1 className="shell-title">{t(PAGE_TITLES[activeName])}</h1>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="min-h-[44px] min-w-[44px]"
          onClick={() => setSearchOpen(true)}
          aria-label="搜索"
        >
          <SearchIcon />
        </Button>
        <NotificationCenter
          notifications={notifications}
          unreadCount={unreadCount}
          loading={!notifLoaded}
          onReload={() => void refreshNotifications()}
          onMarkAllRead={() => void markAllRead()}
          onMarkRead={(id) => void markRead(id)}
          onOpenSession={(id) => navigate(`/s/${encodeURIComponent(id)}`)}
        />
        {/* 会话页专属：右上角 ➕ 新建（肌肉记忆位）；与 drawer/侧边栏同一 ?new=1 深链机制，行为一致 */}
        {activeName === "sessions" && (
          <Button
            type="button"
            size="icon"
            className="min-h-[44px] min-w-[44px]"
            onClick={() => go(newSessionPath())}
            aria-label="新建会话"
          >
            <PlusIcon />
          </Button>
        )}
      </header>

      {/* 大屏常驻 sidebar（≥768px） */}
      <nav className="shell-sidebar" aria-label="主导航">
        <div className="sidebar-brand">Agent Hub</div>
        <ul className="nav-list">
          {NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <button
                type="button"
                className={cn("nav-item", activeName === item.routeName && "active")}
                aria-current={activeName === item.routeName ? "page" : undefined}
                onClick={() => go(item.path)}
              >
                <span className="nav-icon" aria-hidden>
                  {item.icon}
                </span>
                <span>{t(item.label)}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button type="button" className="sidebar-create" onClick={() => go(newSessionPath())}>
          <PlusIcon />
          <span>新建会话</span>
        </Button>
      </nav>

      {/* 移动端抽屉（<768px）：遮罩点击 / 右滑关闭，220ms 开合（常驻 DOM 保证关合动画） */}
      <div
        className={cn("drawer-root", drawerOpen && "open")}
        aria-hidden={!drawerOpen}
      >
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
        <nav
          className="drawer-panel"
          aria-label="主导航"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
            <div className="drawer-head">
              <span className="drawer-brand">Agent Hub</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="min-h-[44px] min-w-[44px]"
                aria-label="关闭菜单"
                onClick={() => setDrawerOpen(false)}
              >
                <CloseIcon />
              </Button>
            </div>
            <ul className="nav-list">
              {NAV_ITEMS.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    className={cn("nav-item", activeName === item.routeName && "active")}
                    aria-current={activeName === item.routeName ? "page" : undefined}
                    onClick={() => go(item.path)}
                  >
                    <span className="nav-icon" aria-hidden>
                      {item.icon}
                    </span>
                    <span>{t(item.label)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <Button type="button" className="drawer-create" onClick={() => go(newSessionPath())}>
              <PlusIcon />
              <span>新建会话</span>
            </Button>
          </nav>
      </div>

      <main className="shell-content">{children}</main>

      <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
