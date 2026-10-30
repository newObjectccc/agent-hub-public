#!/usr/bin/env node
/**
 * 发布物冒烟（pack smoke，CI 用）。
 *
 * 用 `npm pack --dry-run --json` 拿到真实发布清单（不落 tarball），断言两件事：
 *   1. 关键文件都在包内：bridge.mjs、pi 扩展源码、cli 入口 + cli/lib 全部运行时模块、
 *      config 模板（hub.config.example.json）与 kpi-sources.json、server/web 构建产物、LICENSE
 *      （这些缺了要到用户 npm install 之后才炸，必须在 CI 就挡）；
 *   2. 根 package.json dependencies 声明 server/dist 的全部运行时依赖
 *      （@earendil-works/pi-coding-agent、fastify 系、ws——server/src 非 node: 内置 import；
 *        只写在 workspace 子包 dependencies 里发布后装不到）。
 * 任一缺失 → 打印缺什么并 exit 1。
 *
 * 用法：
 *   node scripts/pack-smoke.mjs
 *   （CI 中在 `pnpm -r build` 之后跑，保证 server/dist、web/dist 已产出）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根目录（scripts/ 的上一级）
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 发布包内必须存在的路径（对应 root package.json files 白名单 + 各运行时入口/源码/配置）
const REQUIRED_FILES = [
  "integrations/claude-perm-bridge/bridge.mjs",
  "integrations/pi-command/command.ts",
  "integrations/pi-live-feed/live-feed.ts",
  "cli/cli.js",
  "cli/package.json",
  "cli/mirror.js",
  // config 运行时必需：模板被 cli/lib/paths.js defaultConfigTemplatePath +
  // cli/lib/config.js ensureConfig 引用；kpi-sources.json 被 server/src/kpi.ts 读取
  "config/hub.config.example.json",
  "config/kpi-sources.json",
  // cli/lib/ 全部运行时模块（cli/*.js 启动/装配链 require，缺一个安装后就跑不起来）
  "cli/lib/args.js",
  "cli/lib/autostart.js",
  "cli/lib/color.js",
  "cli/lib/config.js",
  "cli/lib/detect.js",
  "cli/lib/codex-runtime.js",
  "cli/lib/entry.js",
  "cli/lib/extensions.js",
  "cli/lib/net.js",
  "cli/lib/tailscale.js",
  "cli/lib/paths.js",
  "cli/lib/paths.d.ts",
  "cli/lib/process.js",
  "server/dist/index.js",
  "server/dist/sessions/models.js",
  "server/dist/adapters/claude-driver.js",
  "server/dist/adapters/codex-driver.js",
  "server/dist/adapters/codex-host-protocol.js",
  "server/dist/adapters/codex-rpc.js",
  "server/dist/adapters/claude-host-protocol.js",
  "server/dist/adapters/claude-message.js",
  "server/dist/adapters/claude-mirror.js",
  "docs/CLAUDE_DRIVER.md",
  "docs/CODEX_DRIVER.md",
  "docs/INSTALL.md",
  "SECURITY.md",
  "web/dist/index.html",
  "LICENSE",
  "npm-shrinkwrap.json",
  "THIRD_PARTY_NOTICES.md",
  "patches/@earendil-works__pi-coding-agent@0.99.1.patch",
];

// 根 dependencies 必须声明的运行时依赖（发布后 npm 只装根 dependencies，装不到 workspace 子包的声明）
// 对照 server/src 非 node: 内置 import：@earendil-works/pi-coding-agent、@fastify/*、fastify、ws
const REQUIRED_DEPS = [
  "@earendil-works/pi-coding-agent",
  "@fastify/compress",
  "@fastify/cors",
  "@fastify/static",
  "fastify",
  "ws",
];

/** 跑 npm pack --dry-run，返回打包文件路径清单 + 原始报告。 */
function packReport() {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const raw = execFileSync(npmBin, ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    // 生产依赖随 CLI 打包，文件清单超过 Node 默认 1 MiB 缓冲区。
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"], // npm 的告警走 stderr 直通，stdout 只留 JSON
  });
  let report;
  try {
    [report] = JSON.parse(raw);
  } catch {
    console.error("pack smoke 失败：npm pack --dry-run --json 输出不是合法 JSON");
    process.exit(1);
  }
  const paths = new Set((report.files ?? []).map((f) => f.path));
  return { paths, filename: report.filename ?? "agent-hub.tgz" };
}

const { paths, filename } = packReport();
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const shrinkwrap = JSON.parse(readFileSync(join(repoRoot, "npm-shrinkwrap.json"), "utf8"));
if (shrinkwrap.name !== pkg.name || shrinkwrap.version !== pkg.version
  || JSON.stringify(shrinkwrap.packages?.[""]?.dependencies) !== JSON.stringify(pkg.dependencies)
  || JSON.stringify(pkg.overrides) !== JSON.stringify(pkg.pnpm?.overrides)) {
  throw Error("npm 发布锁或依赖覆盖与 package.json 不一致；运行 pnpm release:shrinkwrap 更新");
}
const lockedUndici = Object.entries(shrinkwrap.packages ?? {}).filter(([key]) => /(?:^|\/)node_modules\/undici$/.test(key));
if (lockedUndici.length === 0 || lockedUndici.some(([, value]) => value.version !== "8.12.2")) {
  throw Error("npm 发布锁缺少修补版 Undici");
}

const missingFiles = REQUIRED_FILES.filter((p) => !paths.has(p));
// 入口存在还不够：沿实际编译代码的相对 import 核对依赖闭包，防止漏打 sessions 等子目录。
const visited = new Set();
const queue = ["server/dist/index.js", "cli/cli.js"];
while (queue.length) {
  const file = queue.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  if (!paths.has(file)) missingFiles.push(file);
  const absolute = resolve(repoRoot, file);
  if (!existsSync(absolute) || !/\.(?:m?js)$/.test(file)) continue;
  const code = readFileSync(absolute, "utf8");
  const imports = [
    ...code.matchAll(/\b(?:import|export)\s+(?:[^;"']+?\s+from\s*)?["'](\.[^"']+)["']/g),
    ...code.matchAll(/\b(?:import|require)\s*\(\s*["'](\.[^"']+)["']/g),
  ];
  for (const match of imports) {
    const dependency = relative(repoRoot, resolve(dirname(absolute), match[1])).replaceAll("\\", "/");
    if (dependency.startsWith("../")) throw Error("运行时 import 超出发布根目录");
    queue.push(dependency);
  }
}
const missingDeps = REQUIRED_DEPS.filter((d) => !(pkg.dependencies && d in pkg.dependencies));
for (const dependency of REQUIRED_DEPS) {
  const manifest = `node_modules/${dependency}/package.json`;
  if (!paths.has(manifest)) missingFiles.push(manifest);
  if (!pkg.bundledDependencies?.includes(dependency)) missingDeps.push(`bundledDependencies: ${dependency}`);
}
// 发布物内的 node_modules 是声明的运行时 bundle，保留上游自己的许可/测试等文件。
// 第一方源码/配置仍用原隐私白名单；禁止把 pnpm 虚拟仓整体打进包。
const forbidden = [...paths].filter(p => p.startsWith('node_modules/')
  ? p.startsWith('node_modules/.pnpm/')
  : /(^|\/)(\.git|\.claude|evidence|data|test)(\/|$)|\.map$|\.src\.(png|gif)$|(^|\/)\.env(?:\.|$)|(^|\/)(auth|hub\.config(?:\.local)?)\.json$/.test(p));
for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
  if (![...paths].some(p => p.endsWith(`@esbuild/${platform}/package.json`))) {
    throw Error(`运行时 bundle 缺少 esbuild 平台包 ${platform}`);
  }
}
const invalidName = !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(pkg.name);

if (missingFiles.length > 0 || missingDeps.length > 0 || forbidden.length > 0 || invalidName) {
  console.error("pack smoke 失败 / failed：发布物不完整");
  for (const p of missingFiles) console.error(`  - 包内缺文件 / missing in pack: ${p}`);
  for (const d of missingDeps) console.error(`  - 根 dependencies 缺依赖 / missing in root dependencies: ${d}`);
  for (const p of forbidden) console.error(`  - 包内含运行状态、测试或隐私文件 / forbidden: ${p}`);
  if (invalidName) console.error("  - npm 包名必须是全小写且属于发布账号的作用域");
  console.error("（检查 root package.json 的 files 白名单 / dependencies 声明）");
  process.exit(1);
}

console.log(
  `pack smoke 通过：${REQUIRED_FILES.length} 个关键文件在包内，${REQUIRED_DEPS.length} 个运行时依赖声明齐全（${filename}）`,
);
