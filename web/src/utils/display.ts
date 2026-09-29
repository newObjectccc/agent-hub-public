/** 会话展示名等纯展示函数（SessionList / 运行看板 / 等你处理共用，单一口径） */

/** 标题优先级：会话 name > 文件夹名（basename(cwd)）> id 前缀 */
export function sessionTitle(s: { name?: string | null; cwd: string; id: string }): string {
  const name = s.name && s.name.trim() !== "" ? s.name.trim() : "";
  if (name !== "") return name;
  const base = s.cwd.replace(/[\\/]$/, "").split(/[\\/]/).filter(Boolean).pop();
  return base && base !== "" ? base : s.id.slice(0, 8);
}

/** 路径缩写：$HOME → ~，只用于副标题（完整路径在 title 提示/详情中查看） */
export function shortPath(cwd: string): string {
  return cwd.replace(/^\/(Users|home)\/[^/]+/, "~");
}
