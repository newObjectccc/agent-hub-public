import { useMemo, useRef, useState } from "react";
import {
  collectFinalTranscript,
  collectInterimTranscript,
  getSpeechAvailability,
  getSpeechRecognitionCtor,
  SPEECH_HTTP_HINT,
  SPEECH_LANG,
  type SpeechRecognitionLike,
} from "../utils/speech";
import { isPointInRect, rectOf } from "../utils/pointer";
import { showToast } from "../utils/toast";

export interface VoiceInputButtonProps {
  /** 识别完成（松开后）回传最终文本 */
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

const END_FALLBACK_MS = 800;

/**
 * 语音输入：按住说话、松开转文字进输入框（Web Speech API，zh-CN）。
 * - 浏览器不支持 SpeechRecognition：整颗按钮隐藏（原行为）
 * - 支持但非安全上下文（HTTP 部署）：禁用态 + tooltip/点击提示"语音需 HTTPS"，
 *   不做点击无反应的死按钮（Web Speech API 仅 HTTPS/localhost 可用）
 * - HTTPS：按住说话，录音中有野兽派脉冲反馈
 *
 * 手势（UX 审查 AC4）：pointer capture 让手指移出按钮不再截断录音——
 * 移出显示「松开取消」，在按钮外松开 = 取消（IM 惯例，不写回半句）；
 * 只有在按钮内松开才把最终文本写回输入框。
 */
export function VoiceInputButton({ onTranscript, disabled }: VoiceInputButtonProps) {
  const availability = useMemo(
    () => getSpeechAvailability(typeof window === "undefined" ? null : window),
    [],
  );
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  /** 手指是否已移出按钮（移出 = 松开即取消） */
  const [outside, setOutside] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 按下到松开全程命中跟踪（pointer capture 下坐标判定，不靠 pointerleave） */
  const insideRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // 不支持 API → 优雅隐藏（原行为）
  if (!availability.supported) return null;

  // HTTP（非安全上下文）→ 禁用态 + 明确提示（长按/点击均给反馈，不是死按钮）
  if (!availability.usable) {
    return (
      <span className="voice-wrap">
        <button
          type="button"
          className="voice-btn unavailable"
          aria-label="语音输入不可用：需 HTTPS 部署"
          aria-disabled="true"
          title={SPEECH_HTTP_HINT}
          onPointerDown={(e) => {
            e.preventDefault();
            showToast(SPEECH_HTTP_HINT);
          }}
          onClick={() => showToast(SPEECH_HTTP_HINT)}
        >
          🎙
          <span className="voice-slash" aria-hidden="true">
            /
          </span>
        </button>
      </span>
    );
  }

  /** 停止识别器并复位 UI（不决定文本去留） */
  const teardown = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // 已停止
      }
    }
    setRecording(false);
    setInterim("");
    setOutside(false);
    insideRef.current = true;
  };

  /** 松开在按钮内：最终文本写回输入框 */
  const finish = () => {
    teardown();
    const text = bufferRef.current.trim();
    bufferRef.current = "";
    if (text !== "") onTranscriptRef.current(text);
  };

  /** 松开在按钮外/手势取消：丢弃识别内容，不写回半句（IM 惯例） */
  const cancel = () => {
    teardown();
    bufferRef.current = "";
  };

  const startListening = () => {
    if (disabled || recRef.current) return;
    const Ctor = getSpeechRecognitionCtor(window);
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = SPEECH_LANG;
    rec.interimResults = true;
    rec.continuous = true;
    bufferRef.current = "";
    insideRef.current = true;
    setInterim("");
    setOutside(false);
    rec.onresult = (ev) => {
      bufferRef.current = collectFinalTranscript(ev);
      setInterim(collectInterimTranscript(ev));
    };
    rec.onerror = () => finish();
    rec.onend = () => finish();
    recRef.current = rec;
    setRecording(true);
    try {
      rec.start();
    } catch {
      finish();
    }
  };

  const stopListening = (commit: boolean) => {
    const rec = recRef.current;
    if (!rec) return;
    if (!commit) {
      cancel();
      return;
    }
    try {
      rec.stop();
    } catch {
      finish();
      return;
    }
    // 兜底：个别实现不回调 onend 时也要把结果提交进输入框
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => finish(), END_FALLBACK_MS);
    }
  };

  /** pointer capture 下手指移出按钮仍收到 move：坐标命中判定 + 提示「松开取消」 */
  const trackPointer = (e: { clientX: number; clientY: number; currentTarget: EventTarget | null }) => {
    const el = e.currentTarget as HTMLElement | null;
    const rect = rectOf(el);
    // 无布局（jsdom/隐藏态）→ 保守按在内处理（保持旧行为不误取消）
    const inside = rect === null ? true : isPointInRect(rect, e.clientX, e.clientY);
    if (inside !== insideRef.current) {
      insideRef.current = inside;
      setOutside(!inside);
    }
  };

  return (
    <span className="voice-wrap">
      {recording && outside && (
        <span className="voice-cancel-hint" role="status">
          松开取消
        </span>
      )}
      {recording && !outside && interim !== "" && <span className="voice-interim">{interim}</span>}
      <button
        type="button"
        className={`voice-btn${recording ? " recording" : ""}`}
        aria-label={recording ? (outside ? "松开取消录音" : "松开结束语音输入") : "按住说话（需 HTTPS）"}
        aria-pressed={recording}
        title="按住说话（仅 HTTPS 可用）"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          // 指针捕获：手指移出按钮不再丢事件（旧 onPointerLeave 截断写回半句的根因）
          const el = e.currentTarget as HTMLElement;
          if (typeof el.setPointerCapture === "function" && e.pointerId !== undefined) {
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              // 不支持的实现：降级为普通指针跟踪（坐标判定仍生效）
            }
          }
          startListening();
        }}
        onPointerMove={(e) => {
          if (recRef.current) trackPointer(e);
        }}
        onPointerUp={(e) => {
          trackPointer(e);
          stopListening(insideRef.current);
        }}
        onPointerCancel={() => stopListening(false)}
      >
        {recording ? "●" : "🎙"}
      </button>
    </span>
  );
}
