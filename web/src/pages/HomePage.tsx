/**
 * 工作台（/）= 首页瘦身版：今日概览 + 本周统计 + 🔥工作中精华卡 + ⚠️等你处理精华卡。
 * 会话长列表整体迁至"会话"页（/sessions）；点击卡直达 chat 会话。
 * 数据全部真实推导（/api/dashboard/stats + WS 实时事件）。刷新安静：key 稳定、
 * 进场动画一次性（seen 提升跨 tab 持久）、进度条仅慢刷新显示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { api } from "../api/client";
import type { DashboardStats, UsageWindows } from "../api/types";
import { AttentionList } from "../components/AttentionList";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { OverviewBar } from "../components/OverviewBar";
import { PullToRefresh } from "../components/PullToRefresh";
import { WorkingBoard } from "../components/WorkingBoard";
import { WeekStatsCard } from "../components/WeekStatsCard";
import { Button } from "../components/ui/button";
import { chatPath, navigate, SESSIONS_PATH } from "../utils/router";
/** 刷新超过此时长才显示顶部进度条（快速静默刷新保持视觉安静） */
const PROGRESS_REVEAL_MS = 400;

/** 今日概览折叠状态 localStorage 键（"1" 展开 / "0" 收起，默认展开） */
const OVERVIEW_OPEN_KEY = "agent-hub.home.overview-open";

/** 精华卡条数上限（长列表去 /sessions 看全部） */
const HOME_CARD_LIMIT = 3;

export function HomePage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [usage, setUsage] = useState<UsageWindows | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [progressVisible, setProgressVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    // 慢刷新才露出进度条：连续快速刷新视觉上零变化（不闪不跳）
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => setProgressVisible(true), PROGRESS_REVEAL_MS);
    const statsRes = await api.getDashboardStats().catch(() => null);
    // Token 用量独立拉取：失败安静降级（占位），不拖垮概览其它格
    const usageRes = await api.getUsage().catch(() => null);
    if (progressTimer.current) {
      clearTimeout(progressTimer.current);
      progressTimer.current = null;
    }
    setProgressVisible(false);
    if (statsRes) setStats(statsRes);
    if (usageRes) setUsage(usageRes.windows);
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
    };
  }, [refresh]);

  // 全局会话变更流：status/新通知 → 运行看板与今日概览实时联动（fs.watch 事件驱动）
  useGlobalEvents({
    onSessionsChanged: () => void refresh(),
    onSessionStatus: () => void refresh(),
    onNotification: () => void refresh(),
  });

  const working = stats?.workingSessions ?? [];
  const attention = stats?.attentionSessions ?? [];
  return (
    <div className="page home-page">
      {/* stale-while-revalidate：有旧数据时保留旧数据；慢刷新才显示顶部细进度条 */}
      {progressVisible && loaded && <div className="refresh-bar" role="progressbar" aria-label="刷新中" />}

      <PullToRefresh onRefresh={refresh} refreshing={refreshing}>
        <CollapsibleSection title="今日概览" storageKey={OVERVIEW_OPEN_KEY}>
          <OverviewBar stats={stats} loaded={loaded} usage={usage} />
          <WeekStatsCard stats={stats} loaded={loaded} />
        </CollapsibleSection>

        <h2 className="section-title">
          🔥 工作中
          {working.length > 0 && <span className="hint-text">（{working.length}）</span>}
        </h2>
        {working.length === 0 ? (
          <div className="card empty">{loaded ? "当前没有运行中的会话" : "加载中…"}</div>
        ) : (
          <>
            <WorkingBoard sessions={working.slice(0, HOME_CARD_LIMIT)} onSelect={(id) => navigate(chatPath(id))} />
            {working.length > HOME_CARD_LIMIT && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="more-link"
                onClick={() => navigate(`${SESSIONS_PATH}?tab=working`)}
              >
                查看全部 {working.length} 个 →
              </Button>
            )}
          </>
        )}

        <h2 className="section-title">
          ⚠️ 等你处理
          {attention.length > 0 && <span className="hint-text">（{attention.length}）</span>}
        </h2>
        {attention.length === 0 ? (
          <div className="card empty">{loaded ? "没有等你处理的会话" : "加载中…"}</div>
        ) : (
          <>
            <AttentionList
              sessions={attention.slice(0, HOME_CARD_LIMIT)}
              onSelect={(id) => navigate(chatPath(id))}
            />
            {attention.length > HOME_CARD_LIMIT && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="more-link"
                onClick={() => navigate(`${SESSIONS_PATH}?tab=attention`)}
              >
                查看全部 {attention.length} 个 →
              </Button>
            )}
          </>
        )}
      </PullToRefresh>
    </div>
  );
}
