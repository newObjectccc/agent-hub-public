/** 测试用 DashboardServiceLike 假实现（createApp 必填依赖） */
import type { DashboardServiceLike } from "../dashboard.js";

export function makeFakeDashboard(overrides: Partial<DashboardServiceLike> = {}): DashboardServiceLike {
  return {
    getStats: async () => ({
      working: 0,
      needAttention: 0,
      todayDone: 0,
      todayMessages: 0,
      weekCommits: 0,
      workingSessions: [],
      attentionSessions: [],
      todayDoneSessions: [],
    } as unknown as Awaited<ReturnType<DashboardServiceLike["getStats"]>>),
    listNotifications: async () => ({ notifications: [], unreadCount: 0 }),
    markAllRead: async () => undefined,
    ...overrides,
  };
}
