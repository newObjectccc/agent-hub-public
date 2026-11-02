import { useLayoutEffect, useRef, useState } from "react";
import type { SessionSummary, WorkspaceSnapshot } from "../api/types";
import { useWorkspace } from "../hooks/useWorkspace";
import { useT } from "../i18n/provider";
import { sessionTitle } from "../utils/display";
import { GitBranchIcon } from "./icons";
import { Sheet } from "./Sheet";
import "./workspace.css";

export function workspaceBranch(value: WorkspaceSnapshot | null, labels: { unknown: string; directory: string; detached: string }): string {
  if (!value || value.kind === "unavailable") return labels.unknown;
  if (value.kind === "directory") return labels.directory;
  return value.detached ? `${labels.detached} @ ${value.head?.slice(0, 8) ?? "?"}` : value.branch ?? labels.unknown;
}
export function workspaceLabel(value: WorkspaceSnapshot): string {
  return `${value.cwd} · ${value.branch ?? value.head?.slice(0, 8) ?? value.kind}`;
}

/** CSS supplies the available width; only presentation is shortened, never the identity. */
function BranchName({ name, preserveStart }: { name: string; preserveStart: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(ref.current?.clientWidth ?? 0);
    const observer = new ResizeObserver(measure); observer.observe(ref.current); measure();
    return () => observer.disconnect();
  }, []);
  const chars = Array.from(name);
  const budget = width > 0 ? Math.max(5, Math.floor(width / 7.3)) : chars.length;
  const prefix = name.includes("/") ? name.slice(0, name.indexOf("/") + 1) : "";
  const text = chars.length <= budget ? name : preserveStart ? `${chars.slice(0, budget - 1).join("")}…`
    : prefix.length + 6 < budget ? `${prefix}…${chars.slice(-(budget - prefix.length - 1)).join("")}` : `…${chars.slice(-(budget - 1)).join("")}`;
  return <span className="workspace-branch-text" ref={ref} title={name}>{text}</span>;
}

export function WorkspaceLine({ value, cwd }: { value: WorkspaceSnapshot | null; cwd: string }) {
  const t = useT();
  const branch = workspaceBranch(value, { unknown: t("workspace.unknown"), directory: t("workspace.directory"), detached: t("workspace.detached") });
  const project = value?.projectName ?? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "…";
  return <span className="workspace-identity">
    <span className="workspace-project" title={project}>{project}</span>
    <span className={`workspace-branch${!value || value.kind === "unavailable" ? " unverified" : ""}`}><GitBranchIcon /><BranchName name={branch} preserveStart={value?.detached === true || value?.kind !== "git"} /></span>
  </span>;
}

export function ChatWorkspaceIdentity({ value, session, mode, onOpen }: {
  value: WorkspaceSnapshot | null; session: SessionSummary; mode: string; onOpen: () => void;
}) {
  const t = useT();
  const long = (value?.projectName.length ?? 0) > 18 || (value?.branch?.length ?? 0) > 27;
  return <button type="button" className={`chat-workspace${long ? " context-priority" : ""}`} onClick={onOpen}
    aria-label={`${t("workspace.title")}: ${value?.projectName ?? session.cwd} · ${value?.branch ?? value?.head ?? t("workspace.unknown")}`} aria-haspopup="dialog">
    <WorkspaceLine value={value} cwd={session.cwd} />
    <span className="workspace-subtitle" title={sessionTitle(session)}>{value?.isWorktree ? `${t("workspace.worktree")} · ` : ""}{session.source === "codex" ? "Codex" : session.source === "claude" ? "Claude" : "pi"} · {mode} · {sessionTitle(session)}</span>
  </button>;
}

export function SessionWorkspaceLabel({ cwd }: { cwd: string }) {
  const { snapshot } = useWorkspace(cwd);
  return <div className="session-workspace"><WorkspaceLine value={snapshot} cwd={cwd} /></div>;
}

export function WorkspaceDetails({ value, previous, session, mode, loading, queuedTarget, onRefresh, onConfirm, onGit, onClose }: {
  value: WorkspaceSnapshot | null; previous: WorkspaceSnapshot | null; session: SessionSummary; mode: string;
  loading: boolean; queuedTarget?: string; onRefresh: () => void; onConfirm: () => void; onGit: () => void; onClose: () => void;
}) {
  const t = useT();
  const branch = (v: WorkspaceSnapshot | null) => workspaceBranch(v, { unknown: t("workspace.unknown"), directory: t("workspace.directory"), detached: t("workspace.detached") });
  const review = !!previous || queuedTarget !== undefined;
  return <Sheet title={t("workspace.title")} onClose={onClose} footer={<div className="workspace-sheet-actions">
    <button type="button" onClick={onRefresh} disabled={loading}>{t("workspace.refresh")}</button>
    <button type="button" className="workspace-confirm" disabled={loading || (review && !value?.revision)} onClick={review ? onConfirm : onClose}>{review ? t("workspace.confirm") : t("workspace.close")}</button>
  </div>}>
    {previous && <p className="workspace-warning" role="alert">{t("workspace.changedDetail")}<span>{workspaceLabel(previous)}</span><span>→ {value ? workspaceLabel(value) : t("workspace.unknown")}</span></p>}
    {queuedTarget !== undefined && <p className="workspace-warning" role="alert">{t("workspace.queuedReview")}<span>{queuedTarget || t("workspace.legacyQueue")}</span></p>}
    {(!value || value.kind === "unavailable") && <p className="workspace-warning" role="status">{t("workspace.unavailable")}</p>}
    <dl className="workspace-fields">
      <div><dt>{t("workspace.project")}</dt><dd>{value?.projectName ?? session.cwd.split(/[\\/]/).pop()}{value?.isWorktree && <span className="workspace-worktree-tag">{t("workspace.worktree")}</span>}</dd></div>
      <div><dt>{t("workspace.branch")}</dt><dd className="workspace-mono">{branch(value)}</dd></div>
      <div><dt>{t("workspace.cwd")}</dt><dd className="workspace-mono">{value?.cwd ?? session.cwd}</dd></div>
      {value?.repositoryRoot && <div><dt>{t("workspace.repository")}</dt><dd className="workspace-mono">{value.repositoryRoot}</dd></div>}
      <div><dt>{t("workspace.session")}</dt><dd>{sessionTitle(session)}</dd><dd className="workspace-mono">{session.id}</dd></div>
      <div><dt>{t("workspace.mode")}</dt><dd>{session.source} · {mode}</dd></div>
    </dl>
    {value?.kind === "git" && <button type="button" className="workspace-git-link" onClick={onGit}><GitBranchIcon />{t("workspace.git")}</button>}
  </Sheet>;
}
