/**
 * 配置加载：config/hub.config.json（可覆盖端口/目录）。
 * 监听地址安全规则：绝不明文绑定公网（拒绝 0.0.0.0 / :: 等通配地址）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface HubConfig {
  port: number;
  host: string;
  sessionDir: string;
  workspaceRoot: string;
  kpiRefreshMinutes: number;
  auth: {
    enabled: boolean;
    token: string;
  };
}

export const DEFAULT_CONFIG: HubConfig = {
  port: 7700,
  host: "127.0.0.1",
  sessionDir: "~/.pi/agent/sessions",
  workspaceRoot: "~/Workspace",
  kpiRefreshMinutes: 5,
  auth: { enabled: false, token: "" },
};

/** 展开 `~` 前缀为用户主目录；相对路径按 baseDir 解析。 */
export function expandPath(p: string, baseDir: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/** 拒绝通配绑定（0.0.0.0 / :: / * / 空字符串）——绝不明文暴露公网。 */
export function isSafeBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "") return false;
  if (h === "0.0.0.0" || h === "::" || h === "[::]" || h === "*") return false;
  return true;
}

interface RawConfig {
  port?: unknown;
  host?: unknown;
  sessionDir?: unknown;
  workspaceRoot?: unknown;
  kpiRefreshMinutes?: unknown;
  auth?: { enabled?: unknown; token?: unknown };
}

export interface LoadedConfig {
  config: HubConfig;
  warnings: string[];
}

export function loadHubConfig(configDir: string, home = homedir()): LoadedConfig {
  const warnings: string[] = [];
  const file = join(configDir, "hub.config.json");
  let raw: RawConfig = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as RawConfig;
    } catch (err) {
      warnings.push(`hub.config.json 解析失败，使用默认配置: ${(err as Error).message}`);
      raw = {};
    }
  }

  const config: HubConfig = { ...DEFAULT_CONFIG, auth: { ...DEFAULT_CONFIG.auth } };

  if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535) {
    config.port = raw.port;
  } else if (raw.port !== undefined) {
    warnings.push(`hub.config.json 的 port 非法，使用默认 ${DEFAULT_CONFIG.port}`);
  }

  if (typeof raw.host === "string" && raw.host.trim() !== "") {
    if (isSafeBindHost(raw.host)) {
      config.host = raw.host.trim();
    } else {
      warnings.push(`hub.config.json 的 host "${raw.host}" 是通配/公网绑定地址，已拒绝并回落到 127.0.0.1`);
    }
  }

  if (typeof raw.sessionDir === "string" && raw.sessionDir.trim() !== "") {
    config.sessionDir = expandPath(raw.sessionDir.trim(), configDir, home);
  }
  if (typeof raw.workspaceRoot === "string" && raw.workspaceRoot.trim() !== "") {
    config.workspaceRoot = expandPath(raw.workspaceRoot.trim(), configDir, home);
  }
  if (typeof raw.kpiRefreshMinutes === "number" && raw.kpiRefreshMinutes > 0) {
    config.kpiRefreshMinutes = raw.kpiRefreshMinutes;
  }
  if (raw.auth && typeof raw.auth === "object") {
    config.auth = {
      enabled: raw.auth.enabled === true,
      token: typeof raw.auth.token === "string" ? raw.auth.token : "",
    };
  }

  // sessionDir / workspaceRoot 统一展开 `~`（默认值同样处理）
  config.sessionDir = expandPath(config.sessionDir, configDir, home);
  config.workspaceRoot = expandPath(config.workspaceRoot, configDir, home);

  return { config, warnings };
}
