/**
 * 错误信封测试：500 不泄漏内部 message（固定 "internal error"），4xx 保留语义，HubError 原样透传。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ErrorCodes, HubError, INTERNAL_ERROR_MESSAGE, toErrorEnvelope } from "../errors.js";

describe("errors: toErrorEnvelope 500 信息泄漏防护", () => {
  it("非 HubError 的 500 固定回 \"internal error\"（真实 message 不出网）", () => {
    const secret = new Error("ECONNREFUSED /Users/me/.pi/secret-path with token abc123");
    const { statusCode, body } = toErrorEnvelope(secret);
    assert.equal(statusCode, 500);
    assert.equal(body.error.code, ErrorCodes.INTERNAL);
    assert.equal(body.error.message, INTERNAL_ERROR_MESSAGE);
    assert.equal(body.error.message.includes("secret-path"), false);
    assert.equal(body.error.message.includes("abc123"), false);
  });

  it("非 Error 抛出物（字符串/对象）同样不泄漏", () => {
    assert.equal(toErrorEnvelope("db password=hunter2").body.error.message, INTERNAL_ERROR_MESSAGE);
    assert.equal(toErrorEnvelope({ message: "internal-path /etc/shadow" }).body.error.message, INTERNAL_ERROR_MESSAGE);
    assert.equal(toErrorEnvelope(undefined).body.error.message, INTERNAL_ERROR_MESSAGE);
  });

  it("Fastify 框架 5xx 错误也隐藏 message；4xx 保留原语义", () => {
    const fastify5xx = Object.assign(new Error("schema validation stack /internal"), { statusCode: 503, code: "FST_ERR" });
    const five = toErrorEnvelope(fastify5xx);
    assert.equal(five.statusCode, 500);
    assert.equal(five.body.error.message, INTERNAL_ERROR_MESSAGE);

    const fastify4xx = Object.assign(new Error("Request body is too large"), {
      statusCode: 413,
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
    });
    const four = toErrorEnvelope(fastify4xx);
    assert.equal(four.statusCode, 413);
    assert.equal(four.body.error.code, "FST_ERR_CTP_BODY_TOO_LARGE");
    assert.equal(four.body.error.message, "Request body is too large");
  });

  it("HubError（含 500 GIT_FAILED）原样透传显式受控文案", () => {
    const explicit = new HubError(ErrorCodes.GIT_FAILED, "git status 失败", 500);
    const { statusCode, body } = toErrorEnvelope(explicit);
    assert.equal(statusCode, 500);
    assert.equal(body.error.code, ErrorCodes.GIT_FAILED);
    assert.equal(body.error.message, "git status 失败");

    const notFound = new HubError(ErrorCodes.SESSION_NOT_FOUND, "会话不存在: x", 404);
    assert.equal(toErrorEnvelope(notFound).statusCode, 404);
  });
});
