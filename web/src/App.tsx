import { useEffect, useState } from "react";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { TreePage } from "./pages/TreePage";
import { onRouteChange, parseRoute, type Route } from "./utils/router";

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => onRouteChange(() => setRoute(parseRoute(window.location.pathname))), []);

  if (route.name === "chat") {
    return <ChatPage key={route.id} sessionId={route.id} />;
  }
  if (route.name === "tree") {
    return <TreePage key={route.id} sessionId={route.id} />;
  }
  return <HomePage />;
}
