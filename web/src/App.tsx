import { useEffect, useState } from "react";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { TreePage } from "./pages/TreePage";
import { ToastHost } from "./components/ToastHost";
import { NoticeBanner } from "./components/NoticeBanner";
import { primeAudio } from "./utils/notify";
import { loadTheme, applyTheme } from "./utils/theme";
import { onRouteChange, parseRoute, type Route } from "./utils/router";

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

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

  return (
    <>
      {/* 会话完结提醒横幅（应用内全局，含震动/提示音逻辑） */}
      <NoticeBanner />
      {route.name === "chat" ? (
        <ChatPage key={route.id} sessionId={route.id} />
      ) : route.name === "tree" ? (
        <TreePage key={route.id} sessionId={route.id} />
      ) : (
        <HomePage />
      )}
      <ToastHost />
    </>
  );
}
