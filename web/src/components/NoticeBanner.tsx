/**
 * 会话完结提醒（应用内横幅 + 震动 + 提示音）：
 * WS notification（源自 agent_settled / error 事件）→ 按设置逐通道提醒。
 * 设置存 localStorage（可静音/关震动/关横幅）；移动端震动 navigator.vibrate，
 * 提示音 WebAudio 短促音；均不支持时优雅降级（只留横幅）。
 *
 * 手动收起（✕ 按钮 / 横向滑动 / 点击进入=已读）：记入 localStorage 已关闭列表，
 * 刷新后同一条通知不重复弹（参照 ChatPage bgHintDismissed 模式）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationItem } from "../api/types";
import { useGlobalEvents } from "../hooks/useGlobalEvents";
import { useSwipeDismiss } from "../hooks/useSwipeDismiss";
import { loadDismissedIds, recordDismissedId } from "../utils/noticeDismiss";
import { alertChannels, loadNotifySettings, playChime, vibrate } from "../utils/notify";
import { safeStorage } from "../utils/recentRefs";
import { navigate } from "../utils/router";

/** 横幅自动消失时间 */
const BANNER_TIMEOUT_MS = 8000;

/** 单条通知 → 提醒（横幅/震动/声音，按设置逐通道），返回是否弹横幅（纯决策外的副作用入口） */
export function notifyAlert(
  notification: NotificationItem,
  settings = loadNotifySettings(typeof localStorage !== "undefined" ? localStorage : null),
): { banner: boolean; vibrated: boolean; sounded: boolean } {
  const channels = alertChannels(notification.kind, settings);
  const vibrated = channels.vibrate ? vibrate(120) : false;
  const sounded = channels.sound ? playChime() : false;
  return { banner: channels.banner, vibrated, sounded };
}

export function NoticeBanner() {
  const [banner, setBanner] = useState<NotificationItem | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已关闭/已读通知 id（localStorage 持久，刷新后同条不重复弹） */
  const dismissedRef = useRef<string[] | null>(null);
  if (dismissedRef.current === null) dismissedRef.current = loadDismissedIds(safeStorage());

  const dismiss = useCallback(() => {
    setBanner(null);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 手动收起（✕ / 滑动 / 点击进入）：记住该条已关闭/已读，刷新后不重复弹 */
  const dismissAndRemember = useCallback(
    (item: NotificationItem) => {
      dismissedRef.current = recordDismissedId(safeStorage(), item.id, dismissedRef.current ?? []);
      dismiss();
    },
    [dismiss],
  );

  const onNotification = useCallback((notification: NotificationItem) => {
    // 已手动关闭/已读过的通知不重复提醒（横幅 + 震动 + 声音全跳过）
    if (dismissedRef.current?.includes(notification.id) === true) return;
    const { banner: showBanner } = notifyAlert(notification);
    if (!showBanner) return;
    setBanner(notification);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setBanner(null), BANNER_TIMEOUT_MS);
  }, []);

  useGlobalEvents({ onNotification });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const swipe = useSwipeDismiss();

  if (!banner) return null;
  return (
    <div
      className="notice-banner"
      aria-live="polite"
      onTouchStart={swipe.onTouchStart}
      onTouchEnd={(e) => swipe.onTouchEnd(e, () => dismissAndRemember(banner))}
    >
      <button
        type="button"
        className="notice-banner-hit"
        onClick={() => {
          if (swipe.consumeSwipeClick()) return;
          dismissAndRemember(banner);
          navigate(`/s/${encodeURIComponent(banner.sessionId)}`);
        }}
      >
        <span className={`notif-kind ${banner.kind}`}>
          {banner.kind === "error" ? "出错了" : "干完了"}
        </span>
        <span className="notice-banner-body">
          <span className="notice-banner-title">{banner.sessionName ?? banner.sessionId.slice(0, 8)}</span>
          <span className="notice-banner-text">{banner.text}</span>
        </span>
        <span className="notice-banner-hint">点击进入 ›</span>
      </button>
      <button
        type="button"
        className="icon-btn notice-banner-close"
        aria-label="关闭提示"
        onClick={() => {
          if (swipe.consumeSwipeClick()) return;
          dismissAndRemember(banner);
        }}
      >
        ✕
      </button>
    </div>
  );
}
