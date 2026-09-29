import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { KpiCard as KpiCardType, SessionSummary, SystemStatus } from "../api/types";
import { KpiCard } from "../components/KpiCard";
import { NewSessionForm } from "../components/NewSessionForm";
import { PullToRefresh } from "../components/PullToRefresh";
import { SessionList } from "../components/SessionList";
import { SystemStatusBar } from "../components/SystemStatus";
import { RefreshIcon } from "../components/icons";
import { chatPath, navigate } from "../utils/router";

export function HomePage() {
  const [cards, setCards] = useState<KpiCardType[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [kpiError, setKpiError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setKpiError(null);
    setListError(null);
    const [kpiRes, sessionRes, sysRes] = await Promise.allSettled([
      api.getKpi(),
      api.listSessions(),
      api.getSystem(),
    ]);
    if (kpiRes.status === "fulfilled") setCards(kpiRes.value.cards ?? []);
    else setKpiError(kpiRes.reason instanceof Error ? kpiRes.reason.message : "KPI 加载失败");
    if (sessionRes.status === "fulfilled") setSessions(sessionRes.value.sessions ?? []);
    else setListError(sessionRes.reason instanceof Error ? sessionRes.reason.message : "会话列表加载失败");
    if (sysRes.status === "fulfilled") setSystem(sysRes.value);
    // system 失败不阻塞面板：保持 null，组件显示"加载中"
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Agent Hub</h1>
        <button
          type="button"
          className="ghost"
          onClick={() => void refresh()}
          aria-label="刷新"
          disabled={refreshing}
        >
          <RefreshIcon />
        </button>
      </header>

      <SystemStatusBar system={system} />

      <h2 className="section-title">KPI</h2>
      {kpiError ? (
        <div className="error-banner">
          <span>{kpiError}</span>
          <button type="button" className="ghost" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : cards.length === 0 ? (
        <div className="card empty">{loaded ? "暂无 KPI 卡片" : "加载中…"}</div>
      ) : (
        <div className="kpi-grid">
          {cards.map((card) => (
            <KpiCard key={card.id} card={card} />
          ))}
        </div>
      )}

      <h2 className="section-title">
        会话
        <span className="hint-text">（{sessions.length}）</span>
      </h2>
      <PullToRefresh onRefresh={refresh} refreshing={refreshing}>
        {listError ? (
          <div className="error-banner">
            <span>{listError}</span>
            <button type="button" className="ghost" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="card empty">{loaded ? "暂无会话，点击下方新建" : "加载中…"}</div>
        ) : (
          <SessionList sessions={sessions} onSelect={(s) => navigate(chatPath(s.id))} />
        )}
      </PullToRefresh>

      <h2 className="section-title">新建</h2>
      <NewSessionForm
        onCreated={(session) => {
          void refresh();
          navigate(chatPath(session.id));
        }}
      />
    </div>
  );
}
