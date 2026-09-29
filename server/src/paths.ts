/**
 * 路径解析：server 编译产物位于 <repo>/server/dist/，仓库根为 ../../。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const serverRoot = resolve(here, "..");
export const repoRoot = resolve(here, "../..");
export const configDir = resolve(repoRoot, "config");
export const webDistDir = resolve(repoRoot, "web", "dist");
