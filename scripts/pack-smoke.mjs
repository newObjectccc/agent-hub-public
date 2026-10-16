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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根目录（scripts/ 的上一级）
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 发布包内必须存在的路径（对应 root package.json files 白名单 + 各运行时入口/源码/配置）
const REQUIRED_FILES = [
  "integrations/claude-perm-bridge/bridge.mjs",
  "integrations/pi-command/command.ts",
  "integrations/pi-live-feed/live-feed.ts",
  "cli/cli.js",
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
  "cli/lib/paths.js",
  "cli/lib/process.js",
  "server/dist/index.js",
  "server/dist/adapters/claude-driver.js",
  "server/dist/adapters/codex-driver.js",
  "server/dist/adapters/codex-host-protocol.js",
  "server/dist/adapters/codex-rpc.js",
  "server/dist/adapters/claude-host-protocol.js",
  "server/dist/adapters/claude-message.js",
  "server/dist/adapters/claude-mirror.js",
  "docs/CLAUDE_DRIVER.md",
  "docs/CODEX_DRIVER.md",
  "web/dist/index.html",
  "LICENSE",
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

const missingFiles = REQUIRED_FILES.filter((p) => !paths.has(p));
const missingDeps = REQUIRED_DEPS.filter((d) => !(pkg.dependencies && d in pkg.dependencies));

if (missingFiles.length > 0 || missingDeps.length > 0) {
  console.error("pack smoke 失败 / failed：发布物不完整");
  for (const p of missingFiles) console.error(`  - 包内缺文件 / missing in pack: ${p}`);
  for (const d of missingDeps) console.error(`  - 根 dependencies 缺依赖 / missing in root dependencies: ${d}`);
  console.error("（检查 root package.json 的 files 白名单 / dependencies 声明）");
  process.exit(1);
}

console.log(
  `pack smoke 通过：${REQUIRED_FILES.length} 个关键文件在包内，${REQUIRED_DEPS.length} 个运行时依赖声明齐全（${filename}）`,
);
