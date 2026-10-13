import { lazy, Suspense, useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { NewVersionBanner } from "./components/NewVersionBanner";
import { LockScreen } from "./components/LockScreen";
import { PageSkeleton } from "./components/Skeletons";

// 路由级代码分割（弱网首屏传输量）：页面各自懒加载，公共层（AppShell/锁屏/骨架/路由）留主 bundle
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const SessionsPage = lazy(() => import("./pages/SessionsPage").then((m) => ({ default: m.SessionsPage })));
const SystemPage = lazy(() => import("./pages/SystemPage").then((m) => ({ default: m.SystemPage })));
const TerminalPage = lazy(() => import("./pages/TerminalPage").then((m) => ({ default: m.TerminalPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const ChatPage = lazy(() => import("./pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const TreePage = lazy(() => import("./pages/TreePage").then((m) => ({ default: m.TreePage })));
import { ToastHost } from "./components/ToastHost";
import { NoticeBanner } from "./components/NoticeBanner";
import { flushOfflineQueue } from "./chat/offlineFlush";
import { useAppLock } from "./hooks/useAppLock";
import { primeAudio } from "./utils/notify";
import { loadTheme, applyTheme } from "./utils/theme";
import { onRouteChange, parseRoute, type Route } from "./utils/router";

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  // 应用锁（F1）：未解锁只挂解锁屏（页面组件不挂载 → 不拉任何会话数据）
  const lock = useAppLock();

  // 主题初始化：跟随系统 / 手动浅色 / 手动深色（data-theme 覆盖 prefers-color-scheme）
  useEffect(() => {
    applyTheme(loadTheme(typeof localStorage !== "undefined" ? localStorage : null));
  }, []);

  // 首次用户手势解锁 AudioContext（移动端自动播放策略），提示音才能发声
  useEffect(() => {
    const unlock = (): void => {
      primeAudio();
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => onRouteChange(() => setRoute(parseRoute(window.location.pathname))), []);

  // 离线队列（F1）：网络恢复（online 事件）自动按序补发，成功出队 toast
  useEffect(() => {
    if (lock.phase !== "unlocked") return;
    const onOnline = () => {
      void flushOfflineQueue({ notify: true });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [lock.phase]);

  // 锁屏门控（F1）：token 失效/过期 → 解锁屏；解锁前不挂载任何业务页面
  if (lock.phase !== "unlocked") {
    return (
      <>
        <NewVersionBanner />
        <LockScreen
          mode={lock.phase === "setup" ? "setup" : "unlock"}
          busy={lock.busy || lock.phase === "loading"}
          error={lock.error}
          webauthnAvailable={lock.webauthnAvailable}
          onUnlock={(secret) => void lock.unlock(secret)}
          onSetup={(secret) => void lock.setup(secret)}
          onBiometric={() => void lock.biometricUnlock()}
          onRetry={() => void lock.retry()}
        />
        <ToastHost />
      </>
    );
  }

  // chat/树页保持全屏原布局（顶栏返回/复制菜单/子代理标记），不套导航框架；
  // key={route.id} 保持原行为：换会话即重挂页面（不复用滚动/草稿等内部状态）
  if (route.name === "chat" || route.name === "tree") {
    return (
      <>
        <NoticeBanner />
        <Suspense fallback={<PageSkeleton label="会话页面加载中" />}>
          {route.name === "chat" ? (
            <ChatPage key={route.id} sessionId={route.id} />
          ) : (
            <TreePage key={route.id} sessionId={route.id} />
          )}
        </Suspense>
        <ToastHost />
      </>
    );
  }

  return (
    <>
      {/* 产物新版本提示（不丢代码/跑最新代码原则）：陈旧产物可见化 */}
      <NewVersionBanner />
      {/* 会话完结提醒横幅（应用内全局，含震动/提示音逻辑） */}
      <NoticeBanner />
      <AppShell route={route}>
        <Suspense fallback={<PageSkeleton />}>
          {route.name === "sessions" ? (
            <SessionsPage />
          ) : route.name === "system" ? (
            <SystemPage />
          ) : route.name === "terminal" ? (
            <TerminalPage />
          ) : route.name === "settings" ? (
            <SettingsPage />
          ) : (
            <HomePage />
          )}
        </Suspense>
      </AppShell>
      <ToastHost />
    </>
  );
}
