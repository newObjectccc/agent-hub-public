import type { spawn } from 'node:child_process';
import type { access, open, opendir, realpath } from 'node:fs/promises';

export interface CodexRuntimeReport {
  configuredBin: string;
  resolvedBin: string | null;
  runtimeVersion: string | null;
  /** 有限元数据采样中观察到的最高数字版本主干。 */
  historyVersion: string | null;
  compatibility: 'compatible' | 'warning' | 'unknown';
  warnings: string[];
  sampledFiles: number;
  historyLimited: boolean;
}

export interface CodexRuntimeOptions {
  codexBin?: string;
  codexHome?: string;
  sessionsDir?: string;
  archivedSessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  budgetMs?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  deps?: Partial<{
    spawn: typeof spawn;
    access: typeof access;
    realpath: typeof realpath;
    opendir: typeof opendir;
    open: typeof open;
    now: () => number;
  }>;
}

export function inspectCodexRuntime(options?: CodexRuntimeOptions): Promise<CodexRuntimeReport>;
export function compareCodexVersions(left: unknown, right: unknown): -1 | 0 | 1 | null;
export function formatCodexRuntimeDiagnostics(report: CodexRuntimeReport): string[];
