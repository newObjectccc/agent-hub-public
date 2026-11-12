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
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    // iOS 上 select() 对 readonly 隐藏 textarea 经常选不中 → 复制出空文本；
    // setSelectionRange 显式指定选区才可靠（execCommand 返回值不可信，成功判定保守：
    // 只有选区真实覆盖全文 + execCommand 返回 true 才算成功）
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(0, ta.value.length);
    const selected = ta.selectionEnd - ta.selectionStart === ta.value.length;
    const ok = selected && typeof document.execCommand === "function" && document.execCommand("copy") === true;
    return ok;
  } catch {
    return false;
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }
}
