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
 */
export function VoiceInputButton({ onTranscript, disabled }: VoiceInputButtonProps) {
  const availability = useMemo(
    () => getSpeechAvailability(typeof window === "undefined" ? null : window),
    [],
  );
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const finish = () => {
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
    const text = bufferRef.current.trim();
    bufferRef.current = "";
    if (text !== "") onTranscriptRef.current(text);
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
    setInterim("");
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

  const stopListening = () => {
    const rec = recRef.current;
    if (!rec) return;
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

  return (
    <span className="voice-wrap">
      {recording && interim !== "" && <span className="voice-interim">{interim}</span>}
      <button
        type="button"
        className={`voice-btn${recording ? " recording" : ""}`}
        aria-label={recording ? "松开结束语音输入" : "按住说话（需 HTTPS）"}
        aria-pressed={recording}
        title="按住说话（仅 HTTPS 可用）"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          startListening();
        }}
        onPointerUp={stopListening}
        onPointerCancel={stopListening}
        onPointerLeave={stopListening}
      >
        {recording ? "●" : "🎙"}
      </button>
    </span>
  );
}
