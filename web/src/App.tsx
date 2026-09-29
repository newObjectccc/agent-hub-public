import { useEffect, useState } from "react";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { ToastHost } from "./components/ToastHost";
import { onRouteChange, parseRoute, type Route } from "./utils/router";

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => onRouteChange(() => setRoute(parseRoute(window.location.pathname))), []);

  return (
    <>
      {route.name === "chat" ? <ChatPage key={route.id} sessionId={route.id} /> : <HomePage />}
      <ToastHost />
    </>
  );
}
