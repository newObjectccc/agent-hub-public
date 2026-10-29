/**
 * 配置加载：config/hub.config.json（可覆盖端口/目录）。
 * 监听地址安全规则：绝不明文绑定公网（拒绝 0.0.0.0 / :: 等通配地址）。
 */
import { readFileSync } from "node:fs";
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
  /**
   * 权限档位，**同时管 parallel 与 driver 接管两路径**的 spawn `--permission-mode`
   *（默认 bypassPermissions = 全自动无人审批，产品决策：手机 = 对本机 agent 的全权遥控）。
   * `manual` / `default` / `acceptEdits` / `plan` = 需确认档位：**两条路径都走手机审批 bridge**
   *（同一套 HostRequestCard 审批卡片）。`inherit` = 不下发 flag，沿用用户 settings 判定
   *（缺省/损坏回退挂 bridge 兜底）。
   * 本字段允许显式选择任一合法档位；非法值或拼错的字段拒绝加载，避免意外回落最高权限。
   */
  permissionMode: ClaudePermissionMode;
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
  /** Codex CLI 命令名或二进制路径；parallel 与接管共用，绝不经 shell 执行。 */
  codexBin: string;
  codexDriver: CodexDriverConfig;
}

export interface CodexDriverConfig {
  enabled: boolean;
  defaultPolicy: "active-only" | "always" | "never";
  idleDetachMs: number;
  maxConcurrent: number;
  externalQuietMs: number;
  /** Hub 驱动两条通道的审批策略；默认 never（免审批），inherit 才沿用本机配置。 */
  approvalPolicy: "inherit" | "never" | "untrusted" | "on-request";
  /** 默认完整文件/网络访问；可显式收紧或沿用本机设置。 */
  sandbox: "inherit" | "danger-full-access" | "read-only" | "workspace-write";
}

export const CODEX_APPROVAL_POLICIES = ["inherit", "never", "untrusted", "on-request"] as const;
export const CODEX_SANDBOXES = ["inherit", "danger-full-access", "read-only", "workspace-write"] as const;

/**
 * claude 权限档位（对齐 CLI `--permission-mode` 字面量 + `inherit` 逃生口）。
 * 与 Codex 一样允许显式选择档位——默认 `bypassPermissions`（最高权限，
 * 产品决策），也可显式收紧到 manual 等需确认档位。白名单只限制拼写，不表达安全方向。
 */
export const CLAUDE_PERMISSION_MODES = [
  "bypassPermissions",
  "manual",
  "default",
  "acceptEdits",
  "plan",
  "inherit",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export const DEFAULT_CODEX_DRIVER_CONFIG: CodexDriverConfig = {
  enabled: true,
  defaultPolicy: "never",
  idleDetachMs: 30 * 60_000,
  maxConcurrent: 3,
  externalQuietMs: 3_000,
  approvalPolicy: "never",
  sandbox: "danger-full-access",
};

export const DEFAULT_CLAUDE_DRIVER_CONFIG: ClaudeDriverConfig = {
  enabled: true,
  defaultPolicy: "active-only",
  idleDetachMs: 30 * 60_000,
  maxConcurrent: 3,
  mirror: "tmux",
  externalQuietMs: 3_000,
  // 产品决策：手机创建/驱动的 Claude 会话默认最高权限（bypassPermissions，全自动无人审批）
  permissionMode: "bypassPermissions",
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
  codexBin: "codex",
  codexDriver: { ...DEFAULT_CODEX_DRIVER_CONFIG },
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
  codexBin?: unknown;
  codexDriver?: unknown;
}

export interface LoadedConfig {
  config: HubConfig;
  warnings: string[];
}

function invalidConfig(message: string): Error & { code: "CONFIG_INVALID" } {
  return Object.assign(new Error(`hub.config.json ${message}`), { code: "CONFIG_INVALID" as const });
}

/** 不回显未知键或原始值，避免把配置中的凭据/损坏 JSON 片段写入日志。 */
function assertKnownConfigKeys(object: Record<string, unknown>, keys: readonly string[], section: string): void {
  if (Object.keys(object).some(key => !key.startsWith("//") && !keys.includes(key))) {
    throw invalidConfig(`${section}含未知或位置错误的字段；请按示例检查键名与所属层级`);
  }
}

export function loadHubConfig(configDir: string, home = homedir()): LoadedConfig {
  const warnings: string[] = [];
  const file = join(configDir, "hub.config.json");
  let raw: RawConfig = {};
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw invalidConfig("无法读取；请修复文件访问权限后重新启动");
    }
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidConfig("不是合法 JSON；请修复后重新启动，不会回落默认权限");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw invalidConfig("顶层必须是对象；请修复后重新启动");
    }
    assertKnownConfigKeys(parsed as Record<string, unknown>, [
      "port", "host", "sessionDir", "workspaceRoot", "kpiRefreshMinutes", "auth",
      "allowOrigins", "allowLan", "claudeDriver", "codexBin", "codexDriver",
    ], "顶层");
    raw = parsed as RawConfig;
  }

  const config: HubConfig = {
    ...DEFAULT_CONFIG, auth: { ...DEFAULT_CONFIG.auth },
    claudeDriver: { ...DEFAULT_CLAUDE_DRIVER_CONFIG }, codexDriver: { ...DEFAULT_CODEX_DRIVER_CONFIG },
  };

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
  if (raw.auth !== undefined) {
    if (typeof raw.auth !== "object" || raw.auth === null || Array.isArray(raw.auth)) {
      throw invalidConfig("的 auth 必须是对象");
    }
    assertKnownConfigKeys(raw.auth as Record<string, unknown>, ["enabled", "token"], "auth ");
    if (raw.auth.enabled !== undefined && typeof raw.auth.enabled !== "boolean") {
      throw invalidConfig("的 auth.enabled 必须是布尔值");
    }
    if (raw.auth.token !== undefined && typeof raw.auth.token !== "string") {
      throw invalidConfig("的 auth.token 必须是字符串");
    }
    config.auth = {
      enabled: raw.auth.enabled === true,
      token: typeof raw.auth.token === "string" ? raw.auth.token : "",
    };
  }
  // 显式开启鉴权后必须有可用密钥；拒绝空值，避免带着“已开启”的配置无鉴权监听。
  if (config.auth.enabled && config.auth.token.trim() === "") {
    throw invalidConfig("的 auth.enabled=true 时必须填写非空 auth.token；拒绝无鉴权启动");
  }

  // 权限配置不做静默容错：拼错、误放或损坏时在构造驱动/监听端口前拒绝加载。
  if (raw.claudeDriver !== undefined) {
    if (typeof raw.claudeDriver === "object" && raw.claudeDriver !== null && !Array.isArray(raw.claudeDriver)) {
      const d = raw.claudeDriver as Record<string, unknown>;
      assertKnownConfigKeys(d, [
        "enabled", "defaultPolicy", "idleDetachMs", "maxConcurrent", "mirror", "externalQuietMs", "permissionMode",
      ], "claudeDriver ");
      let permissionMode: ClaudePermissionMode = DEFAULT_CLAUDE_DRIVER_CONFIG.permissionMode;
      if (d.permissionMode !== undefined) {
        if (
          typeof d.permissionMode === "string" &&
          (CLAUDE_PERMISSION_MODES as readonly string[]).includes(d.permissionMode)
        ) {
          permissionMode = d.permissionMode as ClaudePermissionMode;
        } else {
          throw invalidConfig(`的 claudeDriver.permissionMode 必须是 ${CLAUDE_PERMISSION_MODES.join(" | ")}；拒绝回落默认权限`);
        }
      }
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
        permissionMode,
      };
    } else {
      throw invalidConfig("的 claudeDriver 必须是对象；拒绝回落默认权限");
    }
  }

  if (raw.codexBin !== undefined) {
    if (typeof raw.codexBin === "string" && raw.codexBin.trim() !== "" && !/[\0\r\n]/.test(raw.codexBin)) {
      const bin = raw.codexBin.trim();
      config.codexBin = /[\\/]/.test(bin) || bin === "~" ? expandPath(bin, configDir, home) : bin;
    } else warnings.push("hub.config.json 的 codexBin 必须是命令名或路径，已使用 codex");
  }
  if (raw.codexDriver !== undefined) {
    if (raw.codexDriver && typeof raw.codexDriver === "object" && !Array.isArray(raw.codexDriver)) {
      const d = raw.codexDriver as Record<string, unknown>;
      assertKnownConfigKeys(d, ["enabled", "defaultPolicy", "idleDetachMs", "maxConcurrent", "externalQuietMs", "approvalPolicy", "sandbox"], "codexDriver ");
      const defaults = DEFAULT_CODEX_DRIVER_CONFIG;
      const enumValue = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
        if (d[key] === undefined) return fallback;
        if (values.includes(d[key] as T)) return d[key] as T;
        warnings.push(`hub.config.json 的 codexDriver.${key} 非法，使用 ${fallback}`);
        return fallback;
      };
      const policyValue = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
        if (d[key] === undefined) return fallback;
        if (typeof d[key] === "string" && values.includes(d[key] as T)) return d[key] as T;
        throw invalidConfig(`的 codexDriver.${key} 非法；拒绝回落默认权限`);
      };
      const numberValue = (key: string, min: number, fallback: number): number => {
        if (d[key] === undefined) return fallback;
        if (typeof d[key] === "number" && Number.isSafeInteger(d[key]) && d[key] >= min && d[key] <= 2_147_483_647) return d[key];
        warnings.push(`hub.config.json 的 codexDriver.${key} 非法，使用 ${fallback}`);
        return fallback;
      };
      if (d.enabled !== undefined && typeof d.enabled !== "boolean") throw invalidConfig("的 codexDriver.enabled 必须是布尔值");
      config.codexDriver = {
        enabled: d.enabled !== false,
        defaultPolicy: enumValue("defaultPolicy", ["never", "active-only", "always"], defaults.defaultPolicy),
        idleDetachMs: numberValue("idleDetachMs", 0, defaults.idleDetachMs),
        maxConcurrent: numberValue("maxConcurrent", 1, defaults.maxConcurrent),
        externalQuietMs: numberValue("externalQuietMs", 0, defaults.externalQuietMs),
        approvalPolicy: policyValue("approvalPolicy", CODEX_APPROVAL_POLICIES, defaults.approvalPolicy),
        sandbox: policyValue("sandbox", CODEX_SANDBOXES, defaults.sandbox),
      };
    } else throw invalidConfig("的 codexDriver 必须是对象；拒绝回落默认权限");
  }

  // sessionDir / workspaceRoot 统一展开 `~`（默认值同样处理）
  config.sessionDir = expandPath(config.sessionDir, configDir, home);
  config.workspaceRoot = expandPath(config.workspaceRoot, configDir, home);

  return { config, warnings };
}
