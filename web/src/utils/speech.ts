/**
 * 语音输入（Web Speech API，zh-CN）。
 * 可用性判断与转写提取为纯函数，便于单测；不支持的浏览器由 UI 优雅隐藏。
 */

export const SPEECH_LANG = "zh-CN";

/** HTTP（非安全上下文）下的语音降级提示（按钮禁用态 + tooltip/toast） */
export const SPEECH_HTTP_HINT = "语音输入需 HTTPS 部署后可用（当前 HTTP 环境浏览器禁用语音识别）";

/** 语音可用性（纯函数）：支持 API 且在安全上下文（HTTPS/localhost）才真正可用 */
export interface SpeechAvailability {
  /** 浏览器是否提供 SpeechRecognition 构造器 */
  supported: boolean;
  /** 是否安全上下文（isSecureContext；HTTP 部署为 false） */
  secure: boolean;
  /** 实际可用 = supported && secure */
  usable: boolean;
  /** 不可用原因（UI 提示用；可用为 null） */
  reason: "unsupported" | "insecure" | null;
}

export function getSpeechAvailability(globalObj: unknown): SpeechAvailability {
  const supported = getSpeechRecognitionCtor(globalObj) !== null;
  const g = (typeof globalObj === "object" && globalObj !== null ? globalObj : {}) as Record<string, unknown>;
  const secure = g.isSecureContext === true;
  return {
    supported,
    secure,
    usable: supported && secure,
    reason: supported ? (secure ? null : "insecure") : "unsupported",
  };
}

/** SpeechRecognition 实例的最小形状（只用到这些成员） */
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

export interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

/** 语音可用性判断（纯函数）：是否提供 SpeechRecognition 构造器 */
export function isSpeechRecognitionSupported(globalObj: unknown): boolean {
  return getSpeechRecognitionCtor(globalObj) !== null;
}

/** 取构造器（原生或 webkit 前缀），不可用返回 null */
export function getSpeechRecognitionCtor(globalObj: unknown): SpeechRecognitionCtor | null {
  if (typeof globalObj !== "object" || globalObj === null) return null;
  const g = globalObj as Record<string, unknown>;
  for (const key of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    const ctor = g[key];
    if (typeof ctor === "function") return ctor as SpeechRecognitionCtor;
  }
  return null;
}

/** 从识别事件提取最终转写文本（纯函数）：仅取 isFinal 结果拼接 */
export function collectFinalTranscript(ev: SpeechRecognitionEventLike): string {
  const parts: string[] = [];
  const results = ev?.results;
  if (!results) return "";
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    if (item?.isFinal && typeof item[0]?.transcript === "string") {
      parts.push(item[0].transcript);
    }
  }
  return parts.join("").trim();
}

/** 从识别事件提取实时预览文本（纯函数）：取最后一段非最终结果 */
export function collectInterimTranscript(ev: SpeechRecognitionEventLike): string {
  const results = ev?.results;
  if (!results) return "";
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const item = results[i];
    if (item && !item.isFinal && typeof item[0]?.transcript === "string") {
      return item[0].transcript;
    }
  }
  return "";
}
