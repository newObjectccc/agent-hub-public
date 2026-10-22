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
  node cli/dev.js [options]        # 等价 npm run dev / pnpm dev
  node cli/start.js [options]      # 等价 agent-hub start

命令 / Commands:
  setup    环境检测、安装依赖、生成 config、安装 pi 扩展、可选自启注册
           detect environment, install deps, write config, install pi extensions, optional autostart
  dev      开发模式一条命令：server 热重载 + web Vite HMR
           dev mode: server hot reload + web Vite HMR in one command
  start    安装依赖、构建 web/server 并启动面板（配置缺失自动生成）
           install deps, build web/server and start the panel (config auto-generated)
  remote   初始化并启动：推荐 Tailscale，可选 --lan / --no-tailscale（幂等）
           auto-setup and start: Tailscale recommended, --lan / --no-tailscale optional
  check    只读环境检测报告（doctor 为同义别名）/ read-only environment report
  open     在浏览器打开面板 / open the panel in your browser

通用选项 / Common options:
  -h, --help       显示帮助 / show help
  --no-color       禁用彩色输出 / disable ANSI colors
  -V, --version    显示版本 / show version

示例 / Examples:
  node cli/cli.js setup --port 8080 --session-dir "~/.pi/agent/sessions"
  node cli/cli.js setup --autostart
  node cli/cli.js dev
  node cli/cli.js start --lan
  node cli/cli.js start --tailscale
  node cli/cli.js remote          # 等价 npm run remote：一键远程
  node cli/cli.js check
  node cli/cli.js doctor
  node cli/cli.js open
`;
}

export function devHelpText() {
  return `agent-hub dev — 开发模式（热重载）/ dev mode with hot reload

用法 / Usage:
  node cli/dev.js [options]        # 等价 npm run dev / pnpm dev

流程 / Pipeline:
  1. 配置缺失自动生成（config/hub.config.json，从模板生成）
  2. node_modules 缺失时安装依赖
  3. server 初始构建（tsc）后并行启动三个进程：
     - server:tsc  tsc --watch（增量编译）
     - server      node --watch server/dist/index.js（改代码自动重启）
     - web         Vite dev server（HMR，/api /ws 代理到 server）

选项 / Options:
  --port <n>       覆盖 server 端口 / override server port
  --web-port <n>   Vite dev server 端口（默认 5173）/ Vite port (default 5173)
  --no-color       禁用彩色 / disable colors
  -h, --help       显示帮助 / show help

说明 / Notes:
  - 前端调试地址是 Vite（默认 http://localhost:5173），不是 server 的 7700。
  - Ctrl+C 一次停止全部子进程。
`;
}

export function setupHelpText() {
  return `agent-hub setup — 一键准备 / one-shot bootstrap: detect env, install deps, write config, install pi extensions

用法 / Usage:
  node cli/setup.js [options]

选项 / Options:
  --port <n>               写入配置端口 / write hub port (1-65535)
  --session-dir <path>     会话目录（支持 ~）/ pi session dir (~ supported)
  --workspace-root <path>  工作区根目录（支持 ~）/ workspace root (~ supported)
  --skip-deps              跳过依赖安装 / skip dependency installation
  --extensions             强制安装 pi 扩展（默认检测到 pi 才装）
                           force install pi extensions (default: only when pi found)
  --no-extensions          跳过 pi 扩展安装 / skip pi extension installation
  --autostart              注册开机自启（macOS launchd / Linux systemd / Windows 任务计划）
                           register autostart, platform-adapted; auto-adds --tailscale when tailscale is found
  --lan                    autostart 纯局域网模式（覆盖自动 --tailscale）/ LAN-only autostart
  --tailscale              autostart 显式带 --tailscale / explicitly add --tailscale to autostart
  --no-tailscale           autostart 跳过 Tailscale（沿用绑定配置）/ skip Tailscale in autostart
  --dry-run                只打印将写入内容，不落盘 / print only, write nothing
  --no-color               禁用彩色 / disable colors
  -h, --help               显示帮助 / show help

说明 / Notes:
  - 使用 Claude/Codex 不要求全局安装 pi；使用 pi 时只提示安装方式（npm i -g @earendil-works/pi-coding-agent 或 npx），不会自动全局安装。
  - pi 扩展（live-feed / pi-command）拷贝到 ~/.pi/agent/extensions/，幂等可重跑。
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
  npm 包直接运行内置产物，配置位于 ~/.agent-hub；以下安装/构建仅适用于源码仓。
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

包含远程链路延迟体检（tailscale netcheck 解析 + 可操作优化建议）。
Includes a remote-link latency check (tailscale netcheck parsing + actionable advice).

选项 / Options:
  --no-color   禁用彩色 / disable colors
  -h, --help   显示帮助 / show help

退出码 / Exit code: Node.js ≥ 22.19 为 0，否则为 1；各 agent 需自行安装并登录。
`;
}

export function remoteHelpText() {
  return `agent-hub remote — 一键远程入口 / one-command remote entry

用法 / Usage:
  node cli/remote.js [options]     # 等价 npm run remote / agent-hub remote

流程 / Pipeline（幂等，可重复执行）:
  1. 初始化检查：缺 config / 依赖时自动跑 setup（已初始化则跳过）
  2. 启动面板（源码仓先构建；npm 包直接使用内置产物）
  3. 默认尝试 Tailscale Serve（推荐，可选）；未就绪时仍启动本机面板并给安装/登录指引

选项 / Options:
  --tailscale      使用推荐的 Tailscale 远程方案（默认）/ use Tailscale (default)
  --lan            跳过 Tailscale，开放可信局域网 / LAN access without Tailscale
  --no-tailscale   跳过 Tailscale，沿用配置绑定地址 / keep configured bind host, skip Tailscale
  --port <n>       覆盖配置端口 / override config port
  --skip-setup     即使未初始化也不跑 setup / never run setup
  --skip-build     跳过 vite build / tsc / skip build steps
  --dry-run        只打印将执行的步骤，不执行 / print steps only, execute nothing
  --no-color       禁用彩色 / disable colors
  -h, --help       显示帮助 / show help

Tailscale 为可选系统客户端，由本人安装并登录；本命令不自动安装 VPN 或更换账号。
仅本机使用可运行 agent-hub start（默认绑定 127.0.0.1）。
`;
}
