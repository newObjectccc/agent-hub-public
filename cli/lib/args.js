// 极简跨平台参数解析（--key value / --key=value / 布尔 flag / --no-color）。
// 不依赖任何包；未知选项报错，帮助用户发现拼写错误。

/** 'session-dir' / 'sessionDir' → sessionDir */
function toCamel(key) {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {{booleans?: string[], values?: string[], allowPositionals?: boolean}} spec
 * @returns {{options: Record<string, string|boolean>, positionals: string[]}}
 */
export function parseCliArgs(argv, spec = {}) {
  const booleans = new Set((spec.booleans ?? []).map(toCamel));
  const values = new Set((spec.values ?? []).map(toCamel));
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (key.startsWith('no-')) {
        const bare = toCamel(key.slice(3));
        if (booleans.has(bare)) {
          options[bare] = false;
          continue;
        }
      }
      const camel = toCamel(key);
      if (booleans.has(camel)) {
        options[camel] = value === undefined ? true : value !== 'false';
        continue;
      }
      if (values.has(camel)) {
        if (value === undefined) {
          value = argv[++i];
          if (value === undefined) throw new Error(`选项 --${key} 缺少值`);
        }
        options[camel] = value;
        continue;
      }
      throw new Error(`未知选项: --${key}（用 --help 查看用法）`);
    }
    if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      for (const ch of arg.slice(1)) {
        const camel = toCamel(ch);
        if (booleans.has(camel)) {
          options[camel] = true;
        } else if (values.has(camel)) {
          const value = argv[++i];
          if (value === undefined) throw new Error(`选项 -${ch} 缺少值`);
          options[camel] = value;
        } else {
          throw new Error(`未知选项: -${ch}（用 --help 查看用法）`);
        }
      }
      continue;
    }
    if (spec.allowPositionals === false) throw new Error(`多余参数: ${arg}`);
    positionals.push(arg);
  }
  return { options, positionals };
}

/** CLI 总帮助（中英双语）。 */
export function rootHelpText() {
  return `agent-hub — pi agent 会话中枢 / pi agent session hub

用法 / Usage:
  node cli/cli.js <command> [options]
  node cli/setup.js [options]      # 等价 agent-hub setup
  node cli/start.js [options]      # 等价 agent-hub start

命令 / Commands:
  setup    环境检测、生成 config、可选自启注册
           detect environment, write config, optional autostart
  start    安装依赖、构建 web/server 并启动面板
           install deps, build web/server and start the panel
  check    只读环境检测报告 / read-only environment report
  open     在浏览器打开面板 / open the panel in your browser

通用选项 / Common options:
  -h, --help       显示帮助 / show help
  --no-color       禁用彩色输出 / disable ANSI colors
  -V, --version    显示版本 / show version

示例 / Examples:
  node cli/cli.js setup --port 8080 --session-dir "~/.pi/agent/sessions"
  node cli/cli.js setup --autostart
  node cli/cli.js start --lan
  node cli/cli.js start --tailscale
  node cli/cli.js check
  node cli/cli.js open
`;
}

export function setupHelpText() {
  return `agent-hub setup — 环境检测 + 生成配置 + 可选自启 / detect env, write config, optional autostart

用法 / Usage:
  node cli/setup.js [options]

选项 / Options:
  --port <n>               写入配置端口 / write hub port (1-65535)
  --session-dir <path>     会话目录（支持 ~）/ pi session dir (~ supported)
  --workspace-root <path>  工作区根目录（支持 ~）/ workspace root (~ supported)
  --autostart              注册开机自启（macOS launchd / Linux systemd / Windows 任务计划）
                           register autostart, platform-adapted
  --dry-run                只打印将写入内容，不落盘 / print only, write nothing
  --no-color               禁用彩色 / disable colors
  -h, --help               显示帮助 / show help

说明 / Notes:
  - pi 缺失时只提示安装方式（npm i -g @earendil-works/pi-coding-agent 或 npx），不会自动全局安装。
  - tmux / ttyd / tailscale 为可选增强，缺失不算错误；
    原生 Windows 的 tmux 会给出 WSL 指引。
`;
}

export function startHelpText() {
  return `agent-hub start — 安装依赖、构建并启动 / install deps, build and start

用法 / Usage:
  node cli/start.js [options]

选项 / Options:
  --lan            监听局域网（host 写为 0.0.0.0）并打印本机 IP / bind LAN, print local IPs
  --tailscale      引导 tailscale serve 并打印 ts.net 地址 / set up tailscale serve, print ts.net URL
  --port <n>       覆盖配置端口 / override config port
  --skip-build     跳过 vite build / tsc / skip build steps
  --dry-run        只打印将执行的步骤，不执行 / print steps only, execute nothing
  --no-color       禁用彩色 / disable colors
  -h, --help       显示帮助 / show help

流程 / Pipeline:
  1. node_modules 缺失时 pnpm install（pnpm 缺失回退 npm install）
  2. web 构建（vite build，经包管理器 run build）
  3. server 构建（tsc，经包管理器 run build）
  4. node server/dist/index.js（继承 stdio，Ctrl+C 干净退出）

安全 / Safety:
  默认只绑 127.0.0.1；--lan / --tailscale 均需显式开启。绝不明文暴露 0.0.0.0 到公网。
`;
}

export function checkHelpText() {
  return `agent-hub check — 只读环境检测报告 / read-only environment report

用法 / Usage:
  node cli/check.js [options]

选项 / Options:
  --no-color   禁用彩色 / disable colors
  -h, --help   显示帮助 / show help

退出码 / Exit code: 核心依赖（node ≥ 20 / pi）齐备为 0，否则为 1。
`;
}
