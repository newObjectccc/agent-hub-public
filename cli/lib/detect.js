// 环境检测：node / pi / tmux / ttyd / tailscale。
// 检测失败=给出平台对应安装建议，不算错误（Node 版本过低时明确提示）。
import { findCommand, runCapture, isWindows } from './process.js';

/** 各工具元数据：检测命令、版本参数、安装建议（按平台）。 */
export const TOOLS = {
  node: {
    name: 'node',
    label: 'Node.js',
    required: true,
    minVersion: '22.19.0',
    versionArgs: ['--version'],
    hints: {
      darwin: 'brew install node  或使用 nvm：curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh',
      linux: '使用 nvm：curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh && nvm install 22',
      win32: '官方安装包：https://nodejs.org/（建议 LTS ≥ 22）',
    },
  },
  pi: {
    name: 'pi',
    label: 'pi（仅使用 pi 时需要全局 CLI）',
    required: false,
    versionArgs: ['--version'],
    hints: {
      any: 'npm install -g @earendil-works/pi-coding-agent\n         或免全局安装用 npx：npx @earendil-works/pi-coding-agent --version',
    },
  },
  tmux: {
    name: 'tmux',
    label: 'tmux（终端直连增强）',
    required: false,
    versionArgs: ['-V'],
    hints: {
      darwin: 'brew install tmux',
      linux: 'sudo apt install tmux   # Debian/Ubuntu；Fedora 用 sudo dnf install tmux',
      win32: '原生 Windows 不支持 tmux。可跳过（chat 不受影响），或安装 WSL：wsl --install，再在 WSL 内 sudo apt install tmux',
    },
  },
  ttyd: {
    name: 'ttyd',
    label: 'ttyd（浏览器真终端增强）',
    required: false,
    versionArgs: ['--version'],
    hints: {
      darwin: 'brew install ttyd',
      linux: 'sudo apt install ttyd   # Debian/Ubuntu；其余发行版参考 https://github.com/tsl0922/ttyd',
      win32: '官方二进制：https://github.com/tsl0922/ttyd/releases （或 scoop install ttyd）',
    },
  },
  tailscale: {
    name: 'tailscale',
    label: 'Tailscale（出门远程访问）',
    required: false,
    versionArgs: ['version'],
    hints: {
      darwin: 'brew install --cask tailscale  或 App Store 安装 Tailscale',
      linux: 'curl -fsSL https://tailscale.com/install.sh | sh',
      win32: '官方安装包：https://tailscale.com/download/windows',
    },
  },
};

/** 崩溃/异常输出特征：Fatal error / fatal / panic / error / exception / traceback / 段错误等。 */
export const CRASH_PATTERN = /(fatal\s*error|\bfatal\b|\bpanic(?:ked)?\b|\berror\b|exception|traceback|segmentation fault|stack overflow|assertion failed)/i;

/**
 * 解析命令版本输出（纯函数，供测试）：严格模式。
 * - 输出含崩溃特征（error / fatal / panic …）或提取不到 x.y 版本 → version=null（视为不可用，防假阳性）
 * - 否则取首个 x.y[.z] 与首个非空行
 */
export function parseVersionOutput(text) {
  const s = String(text ?? '');
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (CRASH_PATTERN.test(s)) return { version: null, firstLine };
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return { version: m ? m[0] : null, firstLine };
}

/** 版本比较：version >= min（纯函数）。 */
export function versionAtLeast(version, min) {
  const parse = (v) => (String(v ?? '').match(/\d+/g) ?? []).slice(0, 3).map((x) => Number.parseInt(x, 10));
  const [a1 = 0, a2 = 0, a3 = 0] = parse(version);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(min);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

/** 平台对应的安装建议（原生 Windows 下 tmux 额外给 WSL 指引）。 */
export function hintFor(tool, platform = process.platform) {
  const hints = tool.hints ?? {};
  return hints[platform] ?? hints.any ?? '请参考官方文档安装';
}

/**
 * 「检测到二进制但不可用」（broken）的修复建议：
 * tailscale 先试 `tailscale up`，其余工具给重装指引。
 */
export function repairAdvice(toolOrName, platform = process.platform) {
  const name = typeof toolOrName === 'string' ? toolOrName : toolOrName?.name;
  const tool = TOOLS[name] ?? toolOrName;
  const install = hintFor(tool, platform);
  if (tool?.name === 'tailscale') {
    return `检测到 tailscale 二进制但无法获取版本（输出异常/崩溃）。可先执行 \`tailscale up\` 排查；仍异常请重装 Tailscale：${install}`;
  }
  return `检测到 ${tool?.label ?? name} 二进制但无法获取版本（输出异常/崩溃），请重装：${install}`;
}

/**
 * 检测单个工具：查命令 → 跑版本 → 严格解析。检测失败不算错误，只标记 found=false。
 * status: 'ok' 正常 | 'outdated' 版本过低 | 'broken' 检测到二进制但不可用（崩溃/无输出） | 'missing' 未安装。
 * @returns {{name, label, required, found, status, broken, path, version, raw, hint, ok}}
 */
export function detectTool(toolName, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    run = runCapture,
    find = findCommand,
  } = deps;
  const tool = TOOLS[toolName];
  if (!tool) throw new Error(`未知工具: ${toolName}`);

  const located = find(tool.name, { platform, env, run });
  if (!located.found) {
    return {
      name: tool.name,
      label: tool.label,
      required: tool.required,
      found: false,
      status: 'missing',
      broken: false,
      path: null,
      version: null,
      raw: '',
      hint: hintFor(tool, platform),
      ok: !tool.required ? true : false,
    };
  }

  const res = run(tool.name, tool.versionArgs, { env, shell: isWindows(platform) });
  const { version, firstLine } = parseVersionOutput(res.ok ? res.stdout || res.stderr : res.stderr || res.stdout);

  // 严格模式：提取不到版本（含崩溃特征 / 无输出）→「检测到二进制但不可用」，绝不能报 [OK]
  if (version === null) {
    return {
      name: tool.name,
      label: tool.label,
      required: tool.required,
      found: true,
      status: 'broken',
      broken: true,
      path: located.path,
      version: null,
      raw: firstLine,
      hint: repairAdvice(tool, platform),
      ok: false,
    };
  }

  const meetsMin = tool.minVersion ? versionAtLeast(version, tool.minVersion) : true;
  return {
    name: tool.name,
    label: tool.label,
    required: tool.required,
    found: true,
    status: meetsMin ? 'ok' : 'outdated',
    broken: false,
    path: located.path,
    version,
    raw: firstLine,
    hint: meetsMin ? null : `${tool.label} 版本过低（需 ≥ ${tool.minVersion}）。${hintFor(tool, platform)}`,
    ok: meetsMin,
  };
}

/** 检测全部工具，按核心/可选分组。 */
export function detectAll(deps = {}) {
  const order = ['node', 'pi', 'tmux', 'ttyd', 'tailscale'];
  const results = order.map((n) => detectTool(n, deps));
  return {
    tools: results,
    core: results.filter((t) => t.required),
    optional: results.filter((t) => !t.required),
    allCoreOk: results.filter((t) => t.required).every((t) => t.found && t.ok),
  };
}

/** 生成安装建议命令（tmux 在原生 Windows 显示 WSL 指引）。接受工具名或检测结果对象。 */
export function installAdvice(toolOrName, platform = process.platform) {
  const name = typeof toolOrName === 'string' ? toolOrName : toolOrName?.name;
  const tool = TOOLS[name] ?? toolOrName;
  if (tool?.name === 'tmux' && isWindows(platform)) {
    return [
      '原生 Windows 不支持 tmux：可跳过，或安装 WSL 后在 WSL 内使用：',
      '  wsl --install',
      '  wsl -e bash -lc "sudo apt install tmux"',
    ].join('\n');
  }
  return hintFor(tool, platform);
}
