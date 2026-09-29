import { useCallback, useEffect, useState } from "react";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { api } from "../api/client";
import type { KpiCard as KpiCardType, SessionSummary, SystemStatus } from "../api/types";
import { KpiCard } from "../components/KpiCard";
import { NewSessionForm } from "../components/NewSessionForm";
import { PullToRefresh } from "../components/PullToRefresh";
import { SessionList } from "../components/SessionList";
import { KpiSkeleton, SessionListSkeleton } from "../components/Skeletons";
import { SystemStatusBar } from "../components/SystemStatus";
import { RefreshIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
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

  // 全局会话变更流：终端里跑的 pi 落盘 → 面板列表自动刷新（5s 粒度）
  useGlobalEvents({ onSessionsChanged: () => void refresh() });

  return (
    <div className="app">
      {/* stale-while-revalidate：有旧数据时保留旧数据，顶部细进度条提示刷新 */}
      {refreshing && loaded && <div className="refresh-bar" role="progressbar" aria-label="刷新中" />}
      <header className="app-header">
        <h1 className="app-title">Agent Hub</h1>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="min-h-[44px] min-w-[44px]"
          onClick={() => void refresh()}
          aria-label="刷新"
          disabled={refreshing}
        >
          <RefreshIcon />
        </Button>
      </header>

      <SystemStatusBar system={system} />

      <h2 className="section-title">KPI</h2>
      {kpiError ? (
        <div className="error-banner">
          <span>{kpiError}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      ) : cards.length === 0 ? (
        loaded ? (
          <Card className="card empty">暂无 KPI 卡片</Card>
        ) : (
          <KpiSkeleton />
        )
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
            <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        ) : sessions.length === 0 ? (
          loaded ? (
            <Card className="card empty">暂无会话，点击下方新建</Card>
          ) : (
            <SessionListSkeleton />
          )
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
