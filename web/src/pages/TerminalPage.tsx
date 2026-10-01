/**
 * 终端页（/terminal）：ttyd Web 终端入口（F2，契约 §13）。
 * - ttyd 已安装：按钮按需拉起 ttyd，iframe 内嵌同源反代页面（/terminal/?t=<token>，免 CORS）。
 * - 未安装：灰色说明（macOS「brew install ttyd」/ Linux「sudo apt install ttyd」）。
 * - Windows：不支持降级提示（WSL 内可用）。
 * - 安全：token 能力 URL + HttpOnly cookie；ttyd 仅 loopback + 随机凭证（server 侧保证）。
 * 入口解锁（F1 应用锁）由 server 端 terminalUnlocked 门禁预留，本页不缓存/展示 token。
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { TerminalSession, TerminalStatus } from "../api/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";

async function fetchStatus(): Promise<TerminalStatus | null> {
  try {
    return await api.getTerminalStatus();
  } catch {
    return null;
  }
}

export function TerminalPage() {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await fetchStatus();
    if (s) setStatus(s);
  }, []);

  /** 按需拉起 ttyd 并进入终端（server 签发 token URL） */
  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.startTerminalSession();
      setSession(next);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "终端启动失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  /** 回收 ttyd 并退出终端视图 */
  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await api.stopTerminal();
    } catch {
      // 停止失败不阻塞退出视图
    }
    setSession(null);
    await refreshStatus();
    setBusy(false);
  }, [refreshStatus]);

  const unsupported = status !== null && !status.supported;
  const notInstalled = status !== null && status.supported && !status.installed;
  const hint = status?.hint ?? null;

  return (
    <div className="page terminal-page" aria-label="终端">
      <h2 className="section-title">🖥 终端</h2>
      <Card className="card syscard terminal-card">
        <div className="terminal-status" aria-live="polite">
          <span className={`syschip${status?.running ? "" : " off"}`}>
            <span className="dot" />
            <span className="label">ttyd</span>
            <span>
              {status === null
                ? "检测中…"
                : unsupported
                  ? "不支持"
                  : notInstalled
                    ? "未安装"
                    : status.running
                      ? `运行中${status.version ? ` v${status.version}` : ""}`
                      : "已安装"}
            </span>
          </span>
          {hint && <span className="hint-text terminal-hint">{hint}</span>}
        </div>

        {status === null && <span className="hint-text">正在检测 ttyd 环境…</span>}

        {unsupported && (
          <div className="terminal-fallback" role="note">
            <p className="hint-text">Windows 不支持 ttyd Web 终端（WSL 内可用）。</p>
            <p className="hint-text">可先用「💬 会话」驱动 agent；装了 WSL 后在 WSL 内安装 ttyd 即可解锁。</p>
          </div>
        )}

        {notInstalled && (
          <div className="terminal-fallback" role="note">
            <p className="hint-text">ttyd 未安装：装好后这里会出现「真终端」入口。</p>
            <p className="hint-text">{hint ?? "安装 ttyd 后可用"}</p>
          </div>
        )}

        {error && (
          <p className="terminal-error" role="alert">
            {error}
          </p>
        )}

        {status !== null && status.supported && status.installed && session === null && (
          <div className="terminal-launch">
            <p className="hint-text">打开后按需启动 ttyd（仅本机回环 + token 保护），关闭页面自动回收。</p>
            <Button onClick={() => void open()} disabled={busy} aria-label="打开真终端">
              {busy ? "启动中…" : "▶ 打开真终端"}
            </Button>
          </div>
        )}

        {session !== null && (
          <div className="terminal-shell">
            <div className="terminal-toolbar">
              <Button variant="secondary" onClick={() => void open()} disabled={busy} aria-label="重新连接终端">
                🔄 重新连接
              </Button>
              <Button variant="outline" onClick={() => void stop()} disabled={busy} aria-label="关闭终端">
                ⏹ 关闭终端
              </Button>
            </div>
            <iframe
              className="terminal-frame"
              src={session.url}
              title="ttyd Web 终端"
              referrerPolicy="no-referrer"
            />
          </div>
        )}
      </Card>
    </div>
  );
}
