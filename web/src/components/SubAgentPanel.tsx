/**
 * 子代理活动面板（反馈轮 3 #4，用户核心诉求：像 pi TUI 面板一样"看到子 agent 在干活"）：
 * 父会话 chat 页输入框上方，展示 pi-subagents 派生的进行中子代理活动卡：
 * 🤖 子代理名 | ⏱ 已运行时长（秒级实时跳动）| 正在执行：<当前工具 summary> | 最新输出摘要（滚动更新，短渐变）。
 * - 多个子代理：卡片竖向堆叠，面板整体可折叠（默认展开进行中）
 * - 点击卡片展开详情（当前工具/输出全文）+「查看完整会话」跳转子代理会话
 * - 完成后卡片转「✅ 完成，点击查看结果」+ 结果摘要
 * - 动画克制：输出摘要更新短渐变；运行时长每秒数字跳动；reduced-motion 下无渐变
 */
import { useEffect, useRef, useState } from "react";
import type { SubAgentActivity } from "../api/types";
import { elapsedLabel } from "../chat/subAgents";
import { Button } from "./ui/button";

/** 秒级时钟（仅存在未完成子代理时跳动，避免空转） */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 已完成子代理默认可见条数（长会话面板收敛，其余进“点击展开”） */
const DONE_VISIBLE_LIMIT = 3;

/** 摘要短渐变：内容变化时重放一次淡入（key 随内容变化） */
function FadeText({ text, className }: { text: string; className: string }) {
  return (
    <span key={text} className={`${className} fade-swap`}>
      {text}
    </span>
  );
}

function SubAgentCard({
  agent,
  nowMs,
  expanded,
  onToggle,
  onOpenSession,
}: {
  agent: SubAgentActivity;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className={`subagent-card${agent.done ? " done" : ""}`}>
      <button
        type="button"
        className="subagent-head"
        aria-expanded={expanded}
        onClick={onToggle}
        title={expanded ? "收起详情" : "展开详情"}
      >
        <span className="subagent-name">🤖 {agent.name}</span>
        <span className="subagent-elapsed">{agent.done ? "✅ 完成" : `⏱ ${elapsedLabel(agent.startedAt, nowMs)}`}</span>
      </button>
      {agent.done ? (
        <div className="subagent-result">
          <FadeText
            className="subagent-result-text"
            text={
              agent.resultSummary !== null && agent.resultSummary !== ""
                ? `✅ 完成，点击查看结果：${agent.resultSummary}`
                : "✅ 完成，点击查看结果"
            }
          />
        </div>
      ) : (
        <>
          {agent.toolRunning && agent.currentTool !== null && agent.currentTool !== "" && (
            <div className="subagent-tool">
              <span className="subagent-tool-label">正在执行：</span>
              <FadeText className="subagent-tool-text" text={agent.currentTool} />
            </div>
          )}
          {!agent.toolRunning && agent.currentTool !== null && agent.currentTool !== "" && (
            <div className="subagent-tool idle">
              <span className="subagent-tool-label">最近工具：</span>
              <FadeText className="subagent-tool-text" text={agent.currentTool} />
            </div>
          )}
          {agent.lastOutput !== null && agent.lastOutput !== "" && (
            <div className="subagent-output">
              <FadeText className="subagent-output-text" text={agent.lastOutput} />
            </div>
          )}
          {agent.lastOutput === null && !agent.toolRunning && (
            <div className="subagent-output">
              <span className="subagent-output-text fade-swap">✍️ 回复中…</span>
            </div>
          )}
        </>
      )}
      {expanded && (
        <div className="subagent-detail">
          <div className="subagent-detail-row">
            <span className="hint-text">状态</span>
            <span>{agent.done ? "已完成" : agent.status === "running" ? "运行中" : agent.status}</span>
          </div>
          {agent.currentTool !== null && agent.currentTool !== "" && (
            <div className="subagent-detail-row">
              <span className="hint-text">工具</span>
              <span className="subagent-detail-mono">{agent.currentTool}</span>
            </div>
          )}
          {agent.lastOutput !== null && agent.lastOutput !== "" && (
            <div className="subagent-detail-row">
              <span className="hint-text">最新输出</span>
              <span className="subagent-detail-output">{agent.lastOutput}</span>
            </div>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenSession(agent.sessionId)}>
            查看完整会话 →
          </Button>
        </div>
      )}
    </div>
  );
}

export function SubAgentPanel({
  inline = false,
  agents,
  onOpenSession,
}: {
  /** inline：折叠头并入输入区工具行（与模式按钮同排），展开内容浮层 */
  inline?: boolean;
  agents: SubAgentActivity[];
  onOpenSession: (sessionId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const hasRunning = agents.some((a) => !a.done);
  const nowMs = useTicker(hasRunning);
  // 折叠偏好只在面板重新出现时生效一次
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (prevCountRef.current === 0 && agents.length > 0) setCollapsed(false);
    prevCountRef.current = agents.length;
  }, [agents.length]);

  if (agents.length === 0) return null;

  // 面板收敛（长会话可能累积几十个历史子代理）：进行中全显，已完成只留最近 3 个
  const running = agents.filter((a) => !a.done);
  const doneSorted = agents
    .filter((a) => a.done)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleDone = showAllDone ? doneSorted : doneSorted.slice(0, DONE_VISIBLE_LIMIT);
  const hiddenDone = doneSorted.length - visibleDone.length;
  const visible = [...running, ...visibleDone];

  return (
    <section className={`subagent-panel${inline ? " inline" : ""}`} aria-label="子代理活动">
      <div className="subagent-panel-head">
        <span className="subagent-panel-title">
          🤖 子代理 · 进行中 {running.length} · 历史 {agents.length}
        </span>
        <button
          type="button"
          className="subagent-panel-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "展开" : "折叠"}
        </button>
      </div>
      {!collapsed && (
        <div className="subagent-cards">
          {visible.map((agent) => (
            <SubAgentCard
              key={agent.sessionId}
              agent={agent}
              nowMs={nowMs}
              expanded={expandedId === agent.sessionId}
              onToggle={() => setExpandedId((v) => (v === agent.sessionId ? null : agent.sessionId))}
              onOpenSession={onOpenSession}
            />
          ))}
          {hiddenDone > 0 && !showAllDone && (
            <button type="button" className="subagent-more" onClick={() => setShowAllDone(true)}>
              还有 {hiddenDone} 个已完成子代理，点击展开
            </button>
          )}
          {showAllDone && doneSorted.length > DONE_VISIBLE_LIMIT && (
            <button type="button" className="subagent-more" onClick={() => setShowAllDone(false)}>
              收起已完成（只看最近 {DONE_VISIBLE_LIMIT} 个）
            </button>
          )}
        </div>
      )}
    </section>
  );
}
