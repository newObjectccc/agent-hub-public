import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { SessionsPage } from "./pages/SessionsPage";
import { SystemPage } from "./pages/SystemPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ChatPage } from "./pages/ChatPage";
import { TreePage } from "./pages/TreePage";
import { LockScreen } from "./components/LockScreen";
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
        <LockScreen
          mode={lock.phase === "setup" ? "setup" : "unlock"}
          busy={lock.busy || lock.phase === "loading"}
          error={lock.error}
          webauthnAvailable={lock.webauthnAvailable}
          onUnlock={(secret) => void lock.unlock(secret)}
          onSetup={(secret) => void lock.setup(secret)}
          onBiometric={() => void lock.biometricUnlock()}
        />
        <ToastHost />
      </>
    );
  }

  // chat/树页保持全屏原布局（顶栏返回/复制菜单/子代理标记），不套导航框架
  if (route.name === "chat" || route.name === "tree") {
    return (
      <>
        <NoticeBanner />
        {route.name === "chat" ? (
          <ChatPage key={route.id} sessionId={route.id} />
        ) : (
          <TreePage key={route.id} sessionId={route.id} />
        )}
        <ToastHost />
      </>
    );
  }

  return (
    <>
      {/* 会话完结提醒横幅（应用内全局，含震动/提示音逻辑） */}
      <NoticeBanner />
      <AppShell route={route}>
        {route.name === "sessions" ? (
          <SessionsPage />
        ) : route.name === "system" ? (
          <SystemPage />
        ) : route.name === "settings" ? (
          <SettingsPage />
        ) : (
          <HomePage />
        )}
      </AppShell>
      <ToastHost />
    </>
  );
}
