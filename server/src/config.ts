/**
 * 配置加载：config/hub.config.json（可覆盖端口/目录）。
 * 监听地址安全规则：绝不明文绑定公网（拒绝 0.0.0.0 / :: 等通配地址）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isIPv4, isIPv6 } from "node:net";

/** claude hub 驱动接管配置（docs/CLAUDE_DRIVER.md） */
export interface ClaudeDriverConfig {
  /** 总开关（false = claude 接管路由回 400，前端回落 parallel） */
  enabled: boolean;
  /** 智能默认策略：active-only=活跃会话默认接管；always=打开即接管；never=只手动 */
  defaultPolicy: "active-only" | "always" | "never";
  /** 空闲自动 detach（ms，0=永不；turn 进行中不 detach） */
  idleDetachMs: number;
  /** 并发驱动进程上限 */
  maxConcurrent: number;
  /** 终端投屏：tmux 命名 pane（无 tmux 自动降级 off） */
  mirror: "tmux" | "off";
  /** attach 前 sessionFile 静默窗（ms，外部写入检测防双写） */
  externalQuietMs: number;
}

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
  /** 跨域白名单（精确 origin，如 https://app.example.com）；空数组 = 拒绝一切跨域 */
  allowOrigins: string[];
  /** 显式 opt-in 局域网暴露（允许 host 绑定通配地址）；默认 false = 绝不通配绑定 */
  allowLan: boolean;
  claudeDriver: ClaudeDriverConfig;
}

export const DEFAULT_CLAUDE_DRIVER_CONFIG: ClaudeDriverConfig = {
  enabled: true,
  defaultPolicy: "active-only",
  idleDetachMs: 30 * 60_000,
  maxConcurrent: 3,
  mirror: "tmux",
  externalQuietMs: 3_000,
};

export const DEFAULT_CONFIG: HubConfig = {
  port: 7700,
  host: "127.0.0.1",
  sessionDir: "~/.pi/agent/sessions",
  workspaceRoot: "~/Workspace",
  kpiRefreshMinutes: 5,
  auth: { enabled: false, token: "" },
  allowOrigins: [],
  allowLan: false,
  claudeDriver: { ...DEFAULT_CLAUDE_DRIVER_CONFIG },
};

/** 展开 `~` 前缀为用户主目录；相对路径按 baseDir 解析。 */
export function expandPath(p: string, baseDir: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/**
 * 通配/未指定地址判定（归一化后判定，防简写绕过）：
 * 0.0.0.0、* 与 IPv6 未指定地址的任意简写（:: / ::0 / 0:0:0:0:0:0:0:0 / 0:0::0）
 * 以及 IPv4-mapped 通配 ::ffff:0.0.0.0（含 ::ffff:0:0 写法）——全部绑定全接口。
 * 解析不了的 IPv6 字面量保守按通配拒绝。
 */
function isUnspecifiedBindAddress(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "" || h === "*") return true;
  const bare = h.replace(/^\[/, "").replace(/\]$/, "");
  if (isIPv4(bare)) return bare === "0.0.0.0";
  if (!isIPv6(bare)) return false; // 主机名 / 具体 IP 字符串：非通配
  // WHATWG URL 归一化 IPv6 简写（::0 → [::]、::ffff:0.0.0.0 → [::ffff:0:0]）
  let normalized = bare;
  try {
    normalized = new URL(`http://[${bare}]/`).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return true;
  }
  return normalized === "::" || normalized === "::ffff:0:0";
}

/** 拒绝通配绑定（0.0.0.0 / :: 及其任意简写 / IPv4-mapped 通配 / * / 空字符串）——绝不明文暴露公网。 */
export function isSafeBindHost(host: string): boolean {
  return !isUnspecifiedBindAddress(host);
}

/** 提取 host[:port] 的 hostname（兼容 [::1]:port 形式） */
function hostnameOfHostPort(hostPort: string): string {
  const h = hostPort.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  return h.split(":")[0];
}

/** 本机回环主机名（dev proxy 跨端口同源判定用） */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1"
  );
}

/**
 * 同源判定：Origin 的 host[:port] 与请求 Host 头一致（默认端口归一化）；
 * 提供连接 protocol 时 scheme 也必须一致（https 页面请求 http 接口也是跨域）。
 * 本机 dev 例外：Origin 与 Host 都是回环地址（仅端口不同，如 Vite 5173 → proxy 7700）
 * 视为同源（面板与 API 生产同源部署、开发期 proxy 同源语义）；远程访问不适用。
 */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined, protocol?: string): boolean {
  if (typeof origin !== "string" || origin === "" || typeof hostHeader !== "string" || hostHeader === "") {
    return false;
  }
  const normalizeHostPort = (hostPort: string, scheme: string): string => {
    const lower = hostPort.trim().toLowerCase();
    if (scheme === "http" && lower.endsWith(":80")) return lower.slice(0, -3);
    if (scheme === "https" && lower.endsWith(":443")) return lower.slice(0, -4);
    return lower;
  };
  try {
    const url = new URL(origin);
    const scheme = url.protocol.replace(":", "").toLowerCase();
    const hostHeader0 = hostHeader.split(",")[0];
    if (normalizeHostPort(url.host, scheme) === normalizeHostPort(hostHeader0, scheme)) {
      return protocol === undefined || scheme === protocol.toLowerCase();
    }
    // 本机 dev proxy（回环 ↔ 回环，仅端口/主机名写法不同）：同机浏览器访问同机服务
    return isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, "")) && isLoopbackHostname(hostnameOfHostPort(hostHeader0));
  } catch {
    return false; // "null" / 非法 Origin 一律不认同源
  }
}

/** 跨域白名单精确匹配（大小写不敏感）；白名单空 = 拒绝一切跨域。 */
export function isAllowedCrossOrigin(origin: string | undefined, allowOrigins: readonly string[]): boolean {
  if (typeof origin !== "string" || origin === "" || allowOrigins.length === 0) return false;
  const lower = origin.trim().toLowerCase();
  return allowOrigins.some((allowed) => allowed.trim().toLowerCase() === lower);
}

interface RawConfig {
  port?: unknown;
  host?: unknown;
  sessionDir?: unknown;
  workspaceRoot?: unknown;
  kpiRefreshMinutes?: unknown;
  auth?: { enabled?: unknown; token?: unknown };
  allowOrigins?: unknown;
  allowLan?: unknown;
  claudeDriver?: unknown;
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

  config.allowLan = raw.allowLan === true;
  if (typeof raw.host === "string" && raw.host.trim() !== "") {
    const host = raw.host.trim();
    if (isSafeBindHost(host)) {
      config.host = host;
    } else if (config.allowLan) {
      // --lan 语义 = 显式 opt-in 局域网：config 显式确认（allowLan: true）后才允许通配绑定
      config.host = host;
      warnings.push(
        `hub.config.json 已显式开启 allowLan：host "${host}" 将监听所有网络接口（含局域网/公网），请确认所在网络可信`,
      );
    } else {
      warnings.push(
        `hub.config.json 的 host "${host}" 是通配/公网绑定地址，已拒绝并回落到 127.0.0.1（如需局域网访问请同时设置 "allowLan": true）`,
      );
    }
  }

  if (raw.allowOrigins !== undefined) {
    if (Array.isArray(raw.allowOrigins)) {
      const valid: string[] = [];
      for (const item of raw.allowOrigins) {
        if (typeof item === "string" && item.trim() !== "") {
          valid.push(item.trim());
        } else {
          warnings.push(`hub.config.json 的 allowOrigins 含非法条目（${String(item)}），已忽略`);
        }
      }
      config.allowOrigins = valid;
    } else {
      warnings.push("hub.config.json 的 allowOrigins 必须是字符串数组，已忽略（跨域全部拒绝）");
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
  // 鉴权 fail-open 告警（D4）：enabled=true 且 token 为空（含缺失/非字符串被吞成空串）时，
  // routes/ws 均「enabled 且 token 非空才校验」→ 鉴权不生效却无人知晓，必须显式告警（行为不变，防锁死零配置部署）
  if (config.auth.enabled && config.auth.token === "") {
    warnings.push("auth.enabled=true 但 token 为空：鉴权不会生效，请填写 auth.token 或关闭 enabled");
  }

  // claudeDriver：逐字段校验，非法回默认（容错，不阻断启动）
  if (raw.claudeDriver !== undefined) {
    if (typeof raw.claudeDriver === "object" && raw.claudeDriver !== null) {
      const d = raw.claudeDriver as Record<string, unknown>;
      config.claudeDriver = {
        enabled: d.enabled !== false,
        defaultPolicy:
          d.defaultPolicy === "always" || d.defaultPolicy === "never" ? d.defaultPolicy : "active-only",
        idleDetachMs:
          typeof d.idleDetachMs === "number" && d.idleDetachMs >= 0
            ? d.idleDetachMs
            : DEFAULT_CLAUDE_DRIVER_CONFIG.idleDetachMs,
        maxConcurrent:
          typeof d.maxConcurrent === "number" && d.maxConcurrent > 0
            ? Math.floor(d.maxConcurrent)
            : DEFAULT_CLAUDE_DRIVER_CONFIG.maxConcurrent,
        mirror: d.mirror === "off" ? "off" : "tmux",
        externalQuietMs:
          typeof d.externalQuietMs === "number" && d.externalQuietMs >= 0
            ? d.externalQuietMs
            : DEFAULT_CLAUDE_DRIVER_CONFIG.externalQuietMs,
      };
    } else {
      warnings.push("hub.config.json 的 claudeDriver 必须是对象，已使用默认配置");
    }
  }

  // sessionDir / workspaceRoot 统一展开 `~`（默认值同样处理）
  config.sessionDir = expandPath(config.sessionDir, configDir, home);
  config.workspaceRoot = expandPath(config.workspaceRoot, configDir, home);

  return { config, warnings };
}
