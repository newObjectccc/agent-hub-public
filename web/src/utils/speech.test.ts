import { describe, expect, it } from "vitest";
import {
  collectFinalTranscript,
  collectInterimTranscript,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  SPEECH_LANG,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionResultLike,
} from "./speech";

function result(transcript: string, isFinal: boolean): SpeechRecognitionResultLike {
  return { isFinal, 0: { transcript } };
}

describe("isSpeechRecognitionSupported（语音可用性判断）", () => {
  it("原生 SpeechRecognition 可用", () => {
    class Fake {
      static noop() {}
    }
    expect(isSpeechRecognitionSupported({ SpeechRecognition: Fake })).toBe(true);
  });

  it("webkit 前缀可用（iOS Safari）", () => {
    class FakeWebkit {}
    expect(isSpeechRecognitionSupported({ webkitSpeechRecognition: FakeWebkit })).toBe(true);
    expect(getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeWebkit })).toBe(FakeWebkit);
  });

  it("不支持的浏览器 → false（UI 优雅隐藏的依据）", () => {
    expect(isSpeechRecognitionSupported({})).toBe(false);
    expect(isSpeechRecognitionSupported({ SpeechRecognition: "not-a-ctor" })).toBe(false);
    expect(isSpeechRecognitionSupported(null)).toBe(false);
    expect(isSpeechRecognitionSupported(undefined)).toBe(false);
    expect(isSpeechRecognitionSupported("window")).toBe(false);
  });
});

describe("识别文本提取（纯函数）", () => {
  it("collectFinalTranscript 只拼接最终结果", () => {
    const ev: SpeechRecognitionEventLike = {
      results: [result("你好", true), result("世界", true), result("草稿", false)],
    };
    expect(collectFinalTranscript(ev)).toBe("你好世界");
  });

  it("collectInterimTranscript 取最后一段非最终结果（实时预览）", () => {
    const ev: SpeechRecognitionEventLike = {
      results: [result("你好", true), result("正在说", false)],
    };
    expect(collectInterimTranscript(ev)).toBe("正在说");
    expect(collectInterimTranscript({ results: [result("你好", true)] })).toBe("");
  });

  it("空/异常事件安全", () => {
    expect(collectFinalTranscript({ results: [] })).toBe("");
    expect(collectFinalTranscript({} as SpeechRecognitionEventLike)).toBe("");
  });

  it("语言常量固定 zh-CN", () => {
    expect(SPEECH_LANG).toBe("zh-CN");
  });
});
