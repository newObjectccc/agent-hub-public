import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { WorkspaceSnapshot } from "../api/types";

const SEEN_KEY = "agent-hub.workspaceSeen.v1";
type Seen = { id: string; value: WorkspaceSnapshot };
function savedWorkspaces(): Seen[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    if (!Array.isArray(values)) return [];
    return values.filter((entry): entry is Seen => {
      const v = entry?.value;
      return typeof entry?.id === "string" && typeof v?.cwd === "string" && typeof v.projectName === "string"
        && typeof v.revision === "string" && /^[a-f0-9]{64}$/.test(v.revision)
        && [v.root, v.repositoryRoot, v.branch, v.head].every((s) => s === null || typeof s === "string")
        && typeof v.isWorktree === "boolean" && typeof v.detached === "boolean" && ["git", "directory"].includes(v.kind);
    }).slice(-50);
  } catch { return []; }
}
function rememberWorkspace(id: string | undefined, value: WorkspaceSnapshot): void {
  if (!id || !value.revision) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...savedWorkspaces().filter((item) => item.id !== id), { id, value }].slice(-50))); }
  catch { /* Unavailable storage doesn't block chat. */ }
}

const cache = new Map<string, { at: number; request: Promise<WorkspaceSnapshot> }>();
export function loadWorkspace(cwd: string, fresh = false): Promise<WorkspaceSnapshot> {
  const hit = cache.get(cwd);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.request;
  const request = api.getWorkspace(cwd, fresh);
  cache.delete(cwd);
  cache.set(cwd, { at: Date.now(), request });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  void request.catch(() => { if (cache.get(cwd)?.request === request) cache.delete(cwd); });
  return request;
}
export function clearWorkspaceCache(): void { cache.clear(); }

/** Active chat refreshes on foreground/reconnection; lists share a bounded 30s cache. */
export function useWorkspace(cwd: string | undefined, active = false, sessionKey?: string) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [previous, setPrevious] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const baseline = useRef<WorkspaceSnapshot | null>(null);
  const sequence = useRef(0);
  const cwdRef = useRef(cwd); cwdRef.current = cwd;
  const refresh = useCallback(async (fresh = true): Promise<WorkspaceSnapshot | null> => {
    if (!cwd) return null;
    const id = ++sequence.current;
    setLoading(true);
    try {
      const next = await loadWorkspace(cwd, fresh);
      if (id !== sequence.current || cwdRef.current !== cwd) return null;
      if (!baseline.current || !baseline.current.revision || (!sessionKey && baseline.current.cwd !== cwd)) {
        baseline.current = next; rememberWorkspace(sessionKey, next);
      }
      setPrevious(next.revision && baseline.current.revision !== next.revision ? baseline.current : null);
      setSnapshot(next);
      return next;
    } catch {
      if (id === sequence.current && cwdRef.current === cwd) setSnapshot(null);
      throw new Error("WORKSPACE_UNAVAILABLE");
    } finally { if (id === sequence.current) setLoading(false); }
  }, [cwd, sessionKey]);
  useEffect(() => {
    baseline.current = sessionKey ? savedWorkspaces().find((item) => item.id === sessionKey)?.value ?? null : null;
    setSnapshot(null); setPrevious(null);
    void refresh(active).catch(() => {});
    if (!active) return () => { sequence.current++; };
    const foreground = () => { if (document.visibilityState !== "hidden") void refresh(true).catch(() => {}); };
    window.addEventListener("focus", foreground); window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    const timer = setInterval(foreground, 30_000);
    return () => {
      sequence.current++; clearInterval(timer);
      window.removeEventListener("focus", foreground); window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh, active]);
  const current = snapshot?.cwd === cwd ? snapshot : null;
  const prior = sessionKey || previous?.cwd === cwd ? previous : null;
  /** No draft/attachment mutation before this check. Server repeats it at acceptance. */
  const verify = async (): Promise<string | null> => {
    if (prior) return null;
    let next: WorkspaceSnapshot | null;
    try { next = await refresh(true); }
    catch {
      // A known identity may be queued offline; the server still checks it on retry.
      const known = baseline.current;
      return known && known.cwd === cwd ? known.revision : null;
    }
    if (!next?.revision || next.revision !== baseline.current?.revision) return null;
    return next.revision;
  };
  const confirm = async (): Promise<boolean> => {
    const displayed = current?.revision;
    const next = await refresh(true).catch(() => null);
    if (!displayed || !next?.revision || displayed !== next.revision) return false;
    baseline.current = next; rememberWorkspace(sessionKey, next); setPrevious(null); return true;
  };
  return { snapshot: current, previous: prior, changed: !!prior, loading, refresh, verify, confirm };
}
