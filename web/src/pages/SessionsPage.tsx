/**
 * 会话管理页（/sessions）：承载现有全部会话列表能力——tab 过滤 + 滑块、优先级排序
 * （等你处理 > 工作中 > 其他，含"全部"tab）、虚拟列表、子代理树形/兜底折叠、
 * ➕新建会话、下拉刷新、滚动记忆、seenIds 进场动画纪律（搜索统一走 header 全局入口，不重复设工具栏入口）。
 * 深链：?tab=working|attention|done|all 指定分类；?new=1 直接打开新建表单（drawer 入口）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { api } from "../api/client";
import type {
  DashboardStats,
  SessionSummary,
  UsageTotals,
} from "../api/types";
import { NewSessionForm } from "../components/NewSessionForm";
import { PullToRefresh } from "../components/PullToRefresh";
import { SessionList } from "../components/SessionList";
import { SessionTabs } from "../components/SessionTabs";
import { SessionListSkeleton } from "../components/Skeletons";
import { RefreshIcon, PlusIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { SESSION_TABS, filterSessionsByTab, type SessionTab } from "../utils/sessionTabs";
import { peekListScrollTop, saveListScrollTop } from "../utils/scrollMemory";
import { usageBySession } from "../utils/usage";
import { chatPath, navigate, onRouteChange } from "../utils/router";

/** 刷新超过此时长才显示顶部进度条（快速静默刷新保持视觉安静） */
const PROGRESS_REVEAL_MS = 400;

/** URL ?tab= 值 → SessionTab（非法回落 all） */
function tabFromSearch(search: string): SessionTab {
  const value = new URLSearchParams(search).get("tab");
  return SESSION_TABS.some((t) => t.value === value) ? (value as SessionTab) : "all";
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  /** 会话 Token 用量索引（/api/usage；失败安静降级为空表，行内不显示） */
  const [usageMap, setUsageMap] = useState<Map<string, UsageTotals>>(() => new Map());
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [progressVisible, setProgressVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<SessionTab>(() =>
    typeof window === "undefined" ? "all" : tabFromSearch(window.location.search),
  );
  const [createOpen, setCreateOpen] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1",
  );
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 会话虚拟列表滚动容器（列表 scrollTop 记忆 + 下拉刷新到顶判定） */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  /** 进场动画 seen：提升到页面层（跨 tab 卸载/重挂持久）——空分类往返零动画（AC3-b） */
  const seenIdsRef = useRef<Set<string>>(new Set());

  // 侧边栏/抽屉 ?new=1 深链：已在会话页时组件不重挂载，挂载初值不再重算，
  // 靠 popstate 同步弹出新建表单（浏览器前进/后退到带 new=1 的历史条目同样生效）。
  // 只开不关：工具栏 ➕ 手动打开的表单不因 URL 无 new=1 被强制关闭。
  useEffect(
    () =>
      onRouteChange(() => {
        if (new URLSearchParams(window.location.search).get("new") === "1") setCreateOpen(true);
      }),
    [],
  );

  /** 清掉 URL ?new=1（表单关闭/创建后，刷新或后退不再自动弹出） */
  const clearNewParam = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("new")) return;
    params.delete("new");
    const qs = params.toString();
    window.history.replaceState({}, "", qs === "" ? window.location.pathname : `${window.location.pathname}?${qs}`);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setListError(null);
    // 慢刷新才露出进度条：连续快速刷新视觉上零变化（不闪不跳）
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => setProgressVisible(true), PROGRESS_REVEAL_MS);
    // 会话列表独立先回：不被 dashboard（git 全仓扫描，可能数分钟）拖住
    const sessionsPromise = api.listSessions().then(
      (res) => {
        setSessions(res.sessions ?? []);
        setListError(null);
      },
      (err: unknown) => {
        setListError(err instanceof Error ? err.message : "会话列表加载失败");
      },
    );
    // token 用量与 dashboard 并行拉取：失败安静降级（行内不显示），不拖住列表
    const [statsRes, usageRes] = await Promise.all([
      api.getDashboardStats().catch(() => null),
      api.getUsage().catch(() => null),
    ]);
    await sessionsPromise;
    if (progressTimer.current) {
      clearTimeout(progressTimer.current);
      progressTimer.current = null;
    }
    setProgressVisible(false);
    if (statsRes) setStats(statsRes);
    if (usageRes) setUsageMap(usageBySession(usageRes.sessions));
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
    };
  }, [refresh]);

  // 全局会话变更流：终端里跑的 pi 落盘 → 列表自动刷新（fs.watch 事件驱动）；
  // status/新通知 → 优先级（等你处理）实时联动
  useGlobalEvents({
    onSessionsChanged: () => void refresh(),
    onSessionStatus: () => void refresh(),
    onNotification: () => void refresh(),
  });

  const attentionIds = useMemo(
    () => new Set((stats?.attentionSessions ?? []).map((a) => a.id)),
    [stats],
  );
  const doneIds = useMemo(() => new Set(stats?.todayDoneSessions ?? []), [stats]);
  /** 排序优先级：等你处理 > 工作中 > 其他（组内 updatedAt 倒序，sortSessions 内保证） */
  const listPriority = useMemo(
    () => ({ attentionIds, isRunning: (s: SessionSummary) => s.status === "running" }),
    [attentionIds],
  );
  /** 运行中会话起点（行内"已运行 X 分钟"） */
  const runningSince = useMemo(() => {
    const map = new Map<string, number>();
    for (const card of stats?.workingSessions ?? []) {
      const t = card.startedAt ? Date.parse(card.startedAt) : NaN;
      if (Number.isFinite(t)) map.set(card.id, t);
    }
    return map;
  }, [stats]);
  const tabSessions = useMemo(
    () => filterSessionsByTab(sessions, tab, { attentionIds, doneIds }),
    [sessions, tab, attentionIds, doneIds],
  );
  /** 最近使用工作目录：按会话更新时间倒序去重（新建 sheet 的 cwd 下拉用） */
  const recentCwds = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return sorted.map((s) => s.cwd).filter((c) => c.trim() !== "");
  }, [sessions]);
  const tabCounts = useMemo(
    () => ({
      all: sessions.length,
      working: sessions.filter((s) => s.status === "running").length,
      attention: sessions.filter((s) => attentionIds.has(s.id)).length,
      done: sessions.filter((s) => doneIds.has(s.id)).length,
    }),
    [sessions, attentionIds, doneIds],
  );

  /** 切换 tab 同步 ?tab=（深链可分享；all 不带参数保持 URL 干净） */
  const changeTab = (next: SessionTab): void => {
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "all") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    window.history.replaceState({}, "", qs === "" ? window.location.pathname : `${window.location.pathname}?${qs}`);
  };

  return (
    <div className="page sessions-page">
      {progressVisible && loaded && <div className="refresh-bar" role="progressbar" aria-label="刷新中" />}

      <div className="sessions-toolbar">
        <Button
          type="button"
          size="icon"
          className="min-h-[44px] min-w-[44px]"
          onClick={() => setCreateOpen(true)}
          aria-label="新建会话"
        >
          <PlusIcon />
        </Button>
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
      </div>

      <h2 className="section-title">
        🕓 会话列表
        <span className="hint-text">（{sessions.length}）</span>
      </h2>
      <SessionTabs value={tab} counts={tabCounts} onChange={changeTab} />
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
              {tab === "all" ? "暂无会话，点击上方新建" : "该分类下暂无会话"}
            </Card>
          ) : (
            <SessionListSkeleton />
          )
        ) : (
          <SessionList
            sessions={tabSessions}
            priority={listPriority}
            runningSince={runningSince}
            usageBySession={usageMap}
            scrollRef={listScrollRef}
            initialScrollTop={peekListScrollTop()}
            onScrollTop={saveListScrollTop}
            seenIds={seenIdsRef.current}
            onSelect={(s) => {
              saveListScrollTop(listScrollRef.current?.scrollTop ?? 0);
              navigate(chatPath(s.id));
            }}
          />
        )}
      </PullToRefresh>

      <NewSessionForm
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          clearNewParam();
        }}
        recentCwds={recentCwds}
        onCreated={(session) => {
          setCreateOpen(false);
          clearNewParam();
          void refresh();
          navigate(chatPath(session.id));
        }}
      />

    </div>
  );
}
