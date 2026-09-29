import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { api } from "../api/client";
import type {
  AttentionSessionCard,
  DashboardStats,
  NotificationItem,
  SessionSummary,
  SystemStatus,
  WorkingSessionCard,
} from "../api/types";
import { AttentionList } from "../components/AttentionList";
import { NewSessionForm } from "../components/NewSessionForm";
import { NotificationCenter } from "../components/NotificationCenter";
import { OverviewBar } from "../components/OverviewBar";
import { PullToRefresh } from "../components/PullToRefresh";
import { SessionList } from "../components/SessionList";
import { SessionTabs } from "../components/SessionTabs";
import { SessionListSkeleton } from "../components/Skeletons";
import { SettingsMenu } from "../components/SettingsMenu";
import { SystemStatusBar } from "../components/SystemStatus";
import { WeekStatsCard } from "../components/WeekStatsCard";
import { WorkingBoard } from "../components/WorkingBoard";
import { RefreshIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { filterSessionsByTab, type SessionTab } from "../utils/sessionTabs";
import { chatPath, navigate } from "../utils/router";

/** 通用小节骨架（野兽派斜纹条） */
function SectionSkeleton({ bars = 2 }: { bars?: number }) {
  return (
    <div className="session-list" role="status" aria-label="加载中">
      {Array.from({ length: bars }, (_, i) => (
        <div key={i} className="skeleton session-item" aria-hidden>
          <div className="skeleton-bar w-1/2" />
          <div className="skeleton-bar w-full" />
        </div>
      ))}
    </div>
  );
}

/** 刷新超过此时长才显示顶部进度条（快速静默刷新保持视觉安静） */
const PROGRESS_REVEAL_MS = 400;

/**
 * 首页 = 按注意力组织的个人 vibe coding 工作台：
 * 今日概览条 + 本周统计卡 → 🔥工作中 → ⚠️等你处理 → 🕓最近会话（tab 过滤）→ 🖥系统状态。
 * 数据全部真实推导（/api/dashboard/stats + /api/sessions + WS 实时事件）。
 * 刷新安静：key 稳定、进场动画一次性、进度条仅慢刷新显示。
 */
export function HomePage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [progressVisible, setProgressVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<SessionTab>("all");
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setListError(null);
    // 慢刷新才露出进度条：连续快速刷新视觉上零变化（不闪不跳）
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => setProgressVisible(true), PROGRESS_REVEAL_MS);
    const [sessionRes, sysRes, statsRes, notifRes] = await Promise.allSettled([
      api.listSessions(),
      api.getSystem(),
      api.getDashboardStats(),
      api.getNotifications(),
    ]);
    if (progressTimer.current) {
      clearTimeout(progressTimer.current);
      progressTimer.current = null;
    }
    setProgressVisible(false);
    if (sessionRes.status === "fulfilled") setSessions(sessionRes.value.sessions ?? []);
    else setListError(sessionRes.reason instanceof Error ? sessionRes.reason.message : "会话列表加载失败");
    if (sysRes.status === "fulfilled") setSystem(sysRes.value);
    // system 失败不阻塞面板：保持 null，组件显示"加载中"
    if (statsRes.status === "fulfilled") setStats(statsRes.value);
    if (notifRes.status === "fulfilled") {
      setNotifications(notifRes.value.notifications ?? []);
      setUnreadCount(notifRes.value.unreadCount ?? 0);
    }
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
    };
  }, [refresh]);

  // 全局会话变更流：终端里跑的 pi 落盘 → 面板列表自动刷新（SWR）；
  // status/新通知 → 运行看板与今日概览实时联动
  useGlobalEvents({
    onSessionsChanged: () => void refresh(),
    onSessionStatus: () => void refresh(),
    onNotification: () => void refresh(),
  });

  const markAllRead = useCallback(async () => {
    // 乐观清零 + 服务端持久化（失败时下次刷新对齐）
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await api.markNotificationsRead();
    } catch {
      // 持久化失败不阻塞 UI
    }
  }, []);

  const working: WorkingSessionCard[] = stats?.workingSessions ?? [];
  const attention: AttentionSessionCard[] = stats?.attentionSessions ?? [];
  const attentionIds = useMemo(
    () => new Set((stats?.attentionSessions ?? []).map((a) => a.id)),
    [stats],
  );
  const doneIds = useMemo(() => new Set(stats?.todayDoneSessions ?? []), [stats]);
  const tabSessions = useMemo(
    () => filterSessionsByTab(sessions, tab, { attentionIds, doneIds }),
    [sessions, tab, attentionIds, doneIds],
  );
  const tabCounts = useMemo(
    () => ({
      all: sessions.length,
      working: sessions.filter((s) => s.status === "running").length,
      attention: sessions.filter((s) => attentionIds.has(s.id)).length,
      done: sessions.filter((s) => doneIds.has(s.id)).length,
    }),
    [sessions, attentionIds, doneIds],
  );

  return (
    <div className="app">
      {/* stale-while-revalidate：有旧数据时保留旧数据；慢刷新才显示顶部细进度条 */}
      {progressVisible && loaded && <div className="refresh-bar" role="progressbar" aria-label="刷新中" />}
      <header className="app-header">
        <h1 className="app-title">Agent Hub</h1>
        <NotificationCenter
          notifications={notifications}
          unreadCount={unreadCount}
          loading={!loaded}
          onReload={() => void refresh()}
          onMarkAllRead={() => void markAllRead()}
          onOpenSession={(id) => navigate(chatPath(id))}
        />
        <SettingsMenu />
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

      <h2 className="section-title">今日概览</h2>
      <OverviewBar stats={stats} loaded={loaded} />
      <WeekStatsCard stats={stats} loaded={loaded} />

      <h2 className="section-title">
        🔥 工作中
        <span className="hint-text">（{stats ? stats.working : "…"}）</span>
      </h2>
      {!loaded ? (
        <SectionSkeleton bars={1} />
      ) : working.length === 0 ? (
        <Card className="card empty">当前没有运行中的会话</Card>
      ) : (
        <WorkingBoard sessions={working} onSelect={(id) => navigate(chatPath(id))} />
      )}

      <h2 className="section-title">
        ⚠️ 等你处理
        <span className="hint-text">（{stats ? stats.needAttention : "…"}）</span>
      </h2>
      {!loaded ? (
        <SectionSkeleton bars={1} />
      ) : attention.length === 0 ? (
        <Card className="card empty">没有待处理的会话 🎉</Card>
      ) : (
        <AttentionList sessions={attention} onSelect={(id) => navigate(chatPath(id))} />
      )}

      <h2 className="section-title">
        🕓 最近会话
        <span className="hint-text">（{sessions.length}）</span>
      </h2>
      <SessionTabs value={tab} counts={tabCounts} onChange={setTab} />
      <PullToRefresh onRefresh={refresh} refreshing={refreshing}>
        {listError ? (
          <div className="error-banner">
            <span>{listError}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        ) : tabSessions.length === 0 ? (
          loaded ? (
            <Card className="card empty">
              {tab === "all" ? "暂无会话，点击下方新建" : "该分类下暂无会话"}
            </Card>
          ) : (
            <SessionListSkeleton />
          )
        ) : (
          <SessionList sessions={tabSessions} onSelect={(s) => navigate(chatPath(s.id))} />
        )}
      </PullToRefresh>

      <h2 className="section-title">🖥 系统状态</h2>
      <SystemStatusBar system={system} />

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
