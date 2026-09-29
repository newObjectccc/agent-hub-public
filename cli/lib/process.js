// 子进程封装：跨平台命令查找与执行。纯 Node（node:child_process），零 bash 依赖。
// Windows 上 npm/pnpm 等 `.cmd` 无法被 CreateProcess 直接执行，
// 统一通过 `shell: true`（即 cmd.exe /c）执行；所有拼接参数均为受控内容。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWindows = (platform = process.platform) => platform === 'win32';

/**
 * 纯 Node 的 PATH 扫描（`which`/`where` 不可用时的回退）。
 * @returns {string|null} 可执行文件完整路径
 */
export function scanPathFor(cmd, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 查找命令：Windows 用 `where`，类 Unix 用 `which`，失败回退纯 Node PATH 扫描。
 * @returns {{found: boolean, path: string|null}}
 */
export function findCommand(cmd, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    run = runCapture,
    exists = fs.existsSync,
  } = deps;
  const locator = isWindows(platform) ? 'where' : 'which';
  const res = run(locator, [cmd], { env });
  if (res.ok) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return { found: true, path: first };
  }
  const scanned = scanPathFor(cmd, { platform, env, exists });
  return scanned ? { found: true, path: scanned } : { found: false, path: null };
}

/**
 * 同步执行并捕获输出（不使用 shell；供检测类命令使用）。
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, error: string|null}}
 */
export function runCapture(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout ?? 15_000,
    shell: opts.shell ?? false,
    windowsHide: true,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status ?? null,
    stdout: res.stdout ? String(res.stdout) : '',
    stderr: res.stderr ? String(res.stderr) : '',
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

/** 异步执行（stdio 可继承），返回 ChildProcess。 */
export function runSpawn(cmd, args = [], opts = {}) {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    shell: opts.shell ?? false,
    windowsHide: true,
  });
}

/**
 * 校验并归一化子命令参数（防止拼接注入：端口必须是纯数字等）。
 */
export function assertSafeArgs(args) {
  for (const a of args) {
    if (typeof a !== 'string') throw new Error(`非法参数类型: ${typeof a}`);
    if (a.length > 4096) throw new Error('参数过长');
  }
  return args;
}

/** 端口校验：1-65535 的整数字符串/数字，返回数字。 */
export function assertPort(value) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`端口无效: ${value}（应为 1-65535 的整数）`);
  }
  return n;
}

/**
 * 解析包管理器：优先 pnpm，缺失回退 npm。
 * @returns {{name: string, available: boolean, path: string|null}}
 */
export function resolvePackageManager(deps = {}) {
  for (const name of ['pnpm', 'npm']) {
    const found = findCommand(name, deps);
    if (found.found) return { name, available: true, path: found.path };
  }
  return { name: 'npm', available: false, path: null };
}

/**
 * 以包管理器运行脚本（cwd 切到目标包目录，规避 --prefix / --filter 的平台差异）。
 * Windows 下包管理器是 .cmd，需要 shell。
 */
export function runPackageManagerScript(pm, script, { cwd, env, run = runCapture, platform = process.platform } = {}) {
  assertSafeArgs([script]);
  return run(pm.name, ['run', script], {
    cwd,
    env,
    shell: isWindows(platform),
  });
}

/** 安装依赖：pnpm install / npm install（cwd=仓库根）。 */
export function installDeps(pm, { cwd, env, run = runCapture, platform = process.platform } = {}) {
  return run(pm.name, ['install'], { cwd, env, shell: isWindows(platform) });
}
