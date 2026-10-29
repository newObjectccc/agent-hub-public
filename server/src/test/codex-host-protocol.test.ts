import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildApprovalResult, buildDriverArgs, buildElicitationAccept, buildResumeParams, buildTurnInput, buildUserInputResult,
  codexMessageId, declinedRpcReply, hostRequestPreview, parseDriverMode, parseElicitationQuestions, parseUserInputQuestions,
  questionCardPreview, safePreview, serverRequestKind, snapshotRequestedPermissions, unansweredRpcReply, validateQuestionAnswers,
  type HostRequestKind,
} from "../adapters/codex-host-protocol.js";
import { ErrorCodes, HubError } from "../errors.js";
import type { HostUserQuestion } from "../types.js";

describe("Codex native protocol shapes", () => {
  it("inherits policies by default and uses only app-server process arguments", () => {
    assert.deepEqual(buildDriverArgs(), ["app-server"]);
    assert.deepEqual(buildResumeParams("s1"), { threadId: "s1", excludeTurns: true });
    assert.deepEqual(buildResumeParams("s1", { cwd: "/work", approvalPolicy: "on-request", sandbox: "read-only" }), {
      threadId: "s1", excludeTurns: true, cwd: "/work", approvalPolicy: "on-request", sandbox: "read-only",
    });
    assert.equal(JSON.stringify(buildDriverArgs()).includes("dangerously"), false);
  });

  it("sends native localImage inputs, never @path text or base64 in RPC", (t: TestContext) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-protocol-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const uploads = join(dir, ".agent-hub-uploads");
    mkdirSync(uploads, { recursive: true });
    const image = join(uploads, "a.png");
    writeFileSync(image, "png");
    const input = buildTurnInput("inspect", [{ path: image, mimeType: "image/png", data: "secret-image" }], dir);
    assert.deepEqual(input, [
      { type: "text", text: "inspect", text_elements: [] }, { type: "localImage", path: resolve(image) },
    ]);
    assert.equal(JSON.stringify(input).includes("secret-image"), false);
    assert.deepEqual(buildTurnInput("", [image], dir), [{ type: "localImage", path: resolve(image) }]);
    // P2-6：上传根之外的路径不下发 localImage，降级为脱敏后的纯文本提示（绝不静默丢）
    const downgraded = buildTurnInput("", ["/images/a.png"], dir);
    assert.equal(downgraded.some((item) => item.type === "localImage"), false);
    assert.match(JSON.stringify(downgraded), /已忽略 1 个不在上传目录内的图片路径/);
    for (const args of [["", [], "/w"], [null, [], "/w"], ["x", [null], "/w"], ["x", ["\0"], "/w"]] as const) {
      assert.throws(() => buildTurnInput(args[0], args[1], args[2]), /text|图片/);
    }
  });

  it("permission grants are an exact snapshot of requested permissions, scoped to one turn", () => {
    const requested = { network: { enabled: true }, fileSystem: { write: ["/work/out"] }, accessToken: "never-copy" };
    const snapshot = snapshotRequestedPermissions(requested);
    requested.fileSystem.write.push("/work/later");
    assert.deepEqual(buildApprovalResult("permissions", "allow", snapshot), {
      permissions: { network: { enabled: true }, fileSystem: { write: ["/work/out"] } }, scope: "turn",
    });
    assert.deepEqual(buildApprovalResult("permissions", "deny", snapshot), { permissions: {}, scope: "turn" });
    assert.deepEqual(buildApprovalResult("commandExecution", "allow"), { decision: "accept" });
    assert.deepEqual(buildApprovalResult("fileChange", "deny"), { decision: "decline" });
    assert.deepEqual(buildApprovalResult("fileChange", "deny", {}, true), { decision: "cancel" });
  });

  it("previews allowlist fields and redact credentials", () => {
    const preview = hostRequestPreview("commandExecution", { command: "TOKEN=normal OPENAI_API_KEY=sk-this-is-a-secret-value echo ok", reason: "Authorization: Bearer abc.def", accessToken: "do-not-send" });
    assert.equal(JSON.stringify(preview).includes("do-not-send"), false);
    assert.equal(JSON.stringify(preview).includes("this-is-a-secret"), false);
    assert.equal(JSON.stringify(preview).includes("abc.def"), false);
    assert.match(safePreview("REFRESH_TOKEN=abc"), /redacted/);
    const permissions = hostRequestPreview("permissions", { permissions: { network: { enabled: true }, unknownCredential: "hidden" } });
    assert.match(permissions.detail!, /网络/);
    assert.equal(JSON.stringify(permissions).includes("hidden"), false);
  });

  it("uses stable item IDs and rejects unsupported modes", () => {
    assert.equal(codexMessageId("s", "i"), codexMessageId("s", "i"));
    assert.notEqual(codexMessageId("a", "i"), codexMessageId("b", "i"));
    assert.equal(parseDriverMode(undefined), "prompt");
    assert.equal(parseDriverMode("steer"), "steer");
    assert.throws(() => parseDriverMode("unknown"), /prompt\|steer\|followUp/);
  });

  it("routes only interactive requests to the phone and keeps token refresh off the wire", () => {
    const kinds: Array<[string, HostRequestKind | null]> = [
      ["item/commandExecution/requestApproval", "approval"],
      ["item/tool/requestUserInput", "userInput"],
      ["mcpServer/elicitation/request", "elicitation"],
      ["account/chatgptAuthTokens/refresh", null],
      ["attestation/generate", null],
      ["unknown/method", null],
    ];
    for (const [method, expected] of kinds) assert.equal(serverRequestKind(method), expected);
  });

  it("maps requestUserInput questions with redaction, tolerant defaults and bounded size", () => {
    const questions = parseUserInputQuestions({
      questions: [
        { id: "language", header: "MY_API_KEY = head-secret-value", question: "Use sk-super-secret-token now?", options: [{ label: "TypeScript", description: "AUTH_TOKEN=desc-secret-value" }, { label: 42 }] },
        { id: "free" },
      ],
    });
    assert.equal(JSON.stringify(questions).includes("head-secret-value"), false);
    assert.equal(JSON.stringify(questions).includes("super-secret-token"), false);
    assert.equal(JSON.stringify(questions).includes("desc-secret-value"), false);
    assert.equal(questions![0].options![1], undefined); // 非字符串 label 容错跳过
    assert.deepEqual(questions![1], { id: "free", header: null, question: "free", options: null }); // 缺字段容错，自由文本
    // 无法安全映射 → null（拒绝建卡，绝不悄悄丢题）
    assert.equal(parseUserInputQuestions({}), null);
    assert.equal(parseUserInputQuestions({ questions: [] }), null);
    assert.equal(parseUserInputQuestions({ questions: Array.from({ length: 21 }, (_, i) => ({ id: `q${i}` })) }), null);
    assert.equal(parseUserInputQuestions({ questions: [{ id: "dup" }, { id: "dup" }] }), null);
    assert.equal(parseUserInputQuestions({ questions: [{ header: "no id" }] }), null);
    const long = parseUserInputQuestions({ questions: [{ id: "q", question: "x".repeat(50_000) }] });
    assert.equal(Buffer.byteLength(long![0].question) <= 4 * 1024, true);
    const card = questionCardPreview("userInput", questions!);
    assert.equal(card.toolName, "requestUserInput");
    assert.equal(card.title, "MY_API_KEY = [redacted]");
    assert.match(card.detail!, /\[redacted\]/);
    assert.equal(card.detail!.includes("super-secret-token"), false);
  });

  it("maps elicitation schema to questions and refuses nested shapes", () => {
    const parsed = parseElicitationQuestions({
      message: "Deploy info",
      requestedSchema: { properties: { mode: { type: "string", enum: ["fast", "safe"], description: "Mode" }, level: { type: "number", description: "Level" }, ok: { type: "boolean" } } },
    });
    assert.deepEqual(parsed?.types, { mode: "string", level: "number", ok: "boolean" });
    assert.deepEqual(parsed?.questions[1], { id: "level", header: "Deploy info", question: "Level", options: null });
    assert.deepEqual(parsed?.questions[0].options, [{ label: "fast", description: null }, { label: "safe", description: null }]);
    // 嵌套 object/array、缺 schema、非字符串 enum → 保持 decline（安全取消，不算挂起）
    assert.equal(parseElicitationQuestions({ message: "x", requestedSchema: { properties: { nested: { type: "object" } } } }), null);
    assert.equal(parseElicitationQuestions({ message: "x", requestedSchema: { properties: { list: { type: "array" } } } }), null);
    assert.equal(parseElicitationQuestions({ message: "x" }), null);
    assert.equal(parseElicitationQuestions({ message: "x", requestedSchema: { properties: { bad: { type: "string", enum: [1] } } } }), null);
    // accept/content：值按 schema type 基本归一
    assert.deepEqual(buildElicitationAccept(parsed!.types, { level: ["3"], ok: ["true"], mode: ["fast"] }), {
      action: "accept", content: { level: 3, ok: true, mode: "fast" },
    });
    assert.throws(() => buildElicitationAccept({ n: "number" }, { n: ["abc"] }), /数字/);
    assert.throws(() => buildElicitationAccept({ b: "boolean" }, { b: ["yes"] }), /true\|false/);
    assert.deepEqual(buildElicitationAccept({ s: "string" }, { s: ["free text"] }), { action: "accept", content: { s: "free text" } });
  });

  it("validates answers strictly and unanswered questions never get an auto answer", () => {
    const questions: HostUserQuestion[] = [{ id: "q", header: null, question: "Q?", options: null }];
    validateQuestionAnswers(questions, { q: ["a"] }); // 合法
    validateQuestionAnswers(questions, { q: ["a", "b"] }); // 允许部分回答 + 多选
    for (const bad of [{ nope: ["a"] }, { q: [] }, { q: [""] }, { q: ["x", ...Array.from({ length: 20 }, () => "y")] }, { q: ["x".repeat(5_000)] }, {}, { q: "not-array" }] as unknown[]) {
      assert.throws(() => validateQuestionAnswers(questions, bad), (error: unknown) => {
        assert.equal((error as HubError).code, ErrorCodes.INVALID_REQUEST);
        return true;
      });
    }
    // rpc 应答形状：requestUserInput 双层嵌套；未作答/拒绝一律 -32800，绝不带 answers
    assert.deepEqual(buildUserInputResult({ q: ["a"] }), { answers: { q: { answers: ["a"] } } });
    assert.deepEqual(unansweredRpcReply("userInput", null), { rpcError: { code: -32800, message: "user input timed out/cancelled without an answer" } });
    assert.deepEqual(declinedRpcReply("userInput", null), { rpcError: { code: -32800, message: "user declined to answer" } });
    assert.deepEqual(unansweredRpcReply("elicitation", null), { result: { action: "decline", content: null } });
    assert.deepEqual(declinedRpcReply("elicitation", null), { result: { action: "decline", content: null } });
    // 审批语义保持：取消 cancel / 超时与拒绝 decline
    assert.deepEqual(unansweredRpcReply("approval", "fileChange", {}, true), { result: { decision: "cancel" } });
    assert.deepEqual(unansweredRpcReply("approval", "commandExecution", {}, false), { result: { decision: "decline" } });
    assert.deepEqual(declinedRpcReply("approval", "permissions", { network: { enabled: true } }), { result: { permissions: {}, scope: "turn" } });
  });
});
