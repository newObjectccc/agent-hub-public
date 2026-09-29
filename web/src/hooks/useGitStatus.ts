/**
 * 会话 cwd 的 git 状态获取（带 30s 模块级缓存，避免会话列表 N 个卡片并发打爆 server）。
 * 失败静默：非 git 仓库/网络错误都返回 null（不渲染状态条），也不触发异步 setState（测试友好）。
 */
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { GitStatusResult } from "../api/types";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; status: GitStatusResult | null }>();

export function clearGitStatusCache(): void {
  cache.clear();
}

export function useGitStatus(cwd: string | null | undefined): GitStatusResult | null {
  const [status, setStatus] = useState<GitStatusResult | null>(() =>
    cwd ? (cache.get(cwd)?.status ?? null) : null,
  );

  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    const hit = cache.get(cwd);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setStatus(hit.status);
      return;
    }
    let alive = true;
    api
      .getGitStatus(cwd)
      .then((s) => {
        cache.set(cwd, { at: Date.now(), status: s });
        if (alive) setStatus(s);
      })
      .catch(() => {
        cache.set(cwd, { at: Date.now(), status: null });
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

  return status;
}
