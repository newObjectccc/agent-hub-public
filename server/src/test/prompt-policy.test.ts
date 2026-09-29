/**
 * prompt mode 409（SESSION_BUSY）决策逻辑单测。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decidePromptAction, parsePromptMode } from "../sessions/prompt-policy.js";

describe("prompt-policy: SESSION_BUSY 决策", () => {
  it("空闲 + 未指定 mode → 直接发送（prompt）", () => {
    assert.deepEqual(decidePromptAction(false, undefined), { kind: "prompt" });
  });

  it("空闲 + 显式 prompt → 直接发送", () => {
    assert.deepEqual(decidePromptAction(false, "prompt"), { kind: "prompt" });
  });

  it("正忙 + 未指定 mode → busy（REST 层 409 SESSION_BUSY）", () => {
    assert.deepEqual(decidePromptAction(true, undefined), { kind: "busy" });
  });

  it("正忙 + 显式 prompt → busy（同 409 语义）", () => {
    assert.deepEqual(decidePromptAction(true, "prompt"), { kind: "busy" });
  });

  it("正忙 + steer → 转向当前运行", () => {
    assert.deepEqual(decidePromptAction(true, "steer"), { kind: "steer" });
  });

  it("正忙 + followUp → 排队到 run 结束后", () => {
    assert.deepEqual(decidePromptAction(true, "followUp"), { kind: "followUp" });
  });

  it("空闲 + steer/followUp → 保守退化为直接发送", () => {
    assert.deepEqual(decidePromptAction(false, "steer"), { kind: "prompt" });
    assert.deepEqual(decidePromptAction(false, "followUp"), { kind: "prompt" });
  });

  it("parsePromptMode：未指定 undefined、非法 null", () => {
    assert.equal(parsePromptMode(undefined), undefined);
    assert.equal(parsePromptMode(null), undefined);
    assert.equal(parsePromptMode("steer"), "steer");
    assert.equal(parsePromptMode("followUp"), "followUp");
    assert.equal(parsePromptMode("nope"), null);
    assert.equal(parsePromptMode(42), null);
  });
});
