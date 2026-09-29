/**
 * 复制文本：优先 Clipboard API（HTTPS/localhost），降级 execCommand（HTTP tailnet 场景）。
 * 返回是否复制成功，由调用方决定 toast 文案。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof text !== "string" || text === "") return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到降级路径
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
