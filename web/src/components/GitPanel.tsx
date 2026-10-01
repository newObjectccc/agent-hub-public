/**
 * Git 面板（chat 页“变更”入口打开）：变更 diff / 提交历史时间线 / 分支列表 三个 tab。
 * 全部只读：只调 /api/git/diff|log|branches。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { GitBranchInfo, GitCommit, GitDiffResult } from "../api/types";
import { DiffView } from "./DiffView";
import { GitStatusBadge } from "./GitStatusBadge";
import { Sheet } from "./Sheet";
import { Button } from "./ui/button";

type Tab = "diff" | "log" | "branches";

export interface GitPanelProps {
  cwd: string;
  initialTab?: Tab;
  /** 只看某文件的 diff（从文件弹层“看 diff”跳转过来） */
  initialFile?: string | null;
  onClose: () => void;
}

const TAB_LABEL: Record<Tab, string> = {
  diff: "变更",
  log: "提交",
  branches: "分支",
};

export function GitPanel({ cwd, initialTab = "diff", initialFile = null, onClose }: GitPanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [file, setFile] = useState<string | null>(initialFile);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "diff") {
        setDiff(await api.getGitDiff(cwd, file));
      } else if (tab === "log") {
        const out = await api.getGitLog(cwd, 30);
        setCommits(out.commits);
      } else {
        const out = await api.getGitBranches(cwd);
        setBranches(out.branches);
        setCurrentBranch(out.current);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [cwd, tab, file]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Sheet
      title="Git"
      subtitle={file ? `仅看 ${file}` : undefined}
      onClose={onClose}
      action={
        tab === "diff" && file ? (
          <Button type="button" variant="outline" size="xs" onClick={() => setFile(null)}>
            看全部
          </Button>
        ) : undefined
      }
    >
      {/* i1 头部收纳：git 状态 chips 从 chat subbar 移入面板（信息零损失） */}
      <GitStatusBadge cwd={cwd} />
      <div className="git-tabs" role="tablist" aria-label="Git 面板">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`git-tab${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {loading && <div className="empty">加载中…</div>}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      {!loading && !error && tab === "diff" && diff && (
        <>
          {diff.truncated && <div className="chat-notice">diff 过大已截断，仅显示前 512KB</div>}
          <DiffView diff={diff.diff} />
        </>
      )}

      {!loading && !error && tab === "log" && commits && (
        commits.length === 0 ? (
          <div className="empty">暂无提交</div>
        ) : (
          <ol className="log-list" aria-label="提交历史">
            {commits.map((c) => (
              <li key={c.hash} className="log-item">
                <span className="log-hash">{c.hash}</span>
                <div className="log-main">
                  <div className="log-subject">{c.subject}</div>
                  <div className="log-meta">
                    {c.author} · {c.relativeTime}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )
      )}

      {!loading && !error && tab === "branches" && branches && (
        branches.length === 0 ? (
          <div className="empty">暂无分支</div>
        ) : (
          <ul className="branch-list" aria-label="分支列表">
            {branches.map((b) => (
              <li key={b.name} className="branch-item">
                <span className={`git-chip ${b.current ? "branch" : "plain"}`}>
                  {b.current ? "🌿 " : ""}
                  {b.name}
                </span>
                {b.upstream && <span className="hint-text">→ {b.upstream}</span>}
                {b.name === currentBranch && <span className="hint-text">当前</span>}
              </li>
            ))}
          </ul>
        )
      )}
    </Sheet>
  );
}
