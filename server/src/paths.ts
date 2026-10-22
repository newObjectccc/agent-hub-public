/**
 * 路径解析：server 编译产物位于 <repo>/server/dist/，仓库根为 ../../。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDirs } from "../../cli/lib/paths.js";

const here = dirname(fileURLToPath(import.meta.url));

export const serverRoot = resolve(here, "..");
export const repoRoot = resolve(here, "../..");
const runtime = runtimeDirs(repoRoot);
export const configDir = runtime.configDir;
export const webDistDir = resolve(repoRoot, "web", "dist");
/** 运行时状态目录（通知 read 标记等，gitignore 覆盖） */
export const dataDir = runtime.dataDir;
