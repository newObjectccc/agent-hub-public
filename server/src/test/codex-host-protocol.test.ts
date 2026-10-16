import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalResult, buildDriverArgs, buildResumeParams, buildTurnInput, codexMessageId,
  hostRequestPreview, parseDriverMode, safePreview, snapshotRequestedPermissions,
} from "../adapters/codex-host-protocol.js";

describe("Codex native protocol shapes", () => {
  it("inherits policies by default and uses only app-server process arguments", () => {
    assert.deepEqual(buildDriverArgs(), ["app-server"]);
    assert.deepEqual(buildResumeParams("s1"), { threadId: "s1", excludeTurns: true });
    assert.deepEqual(buildResumeParams("s1", { cwd: "/work", approvalPolicy: "on-request", sandbox: "read-only" }), {
      threadId: "s1", excludeTurns: true, cwd: "/work", approvalPolicy: "on-request", sandbox: "read-only",
    });
    assert.equal(JSON.stringify(buildDriverArgs()).includes("dangerously"), false);
  });

  it("sends native localImage inputs, never @path text or base64 in RPC", () => {
    assert.deepEqual(buildTurnInput("inspect", [{ path: "images/a.png", mimeType: "image/png", data: "secret-image" }], "/work"), [
      { type: "text", text: "inspect", text_elements: [] }, { type: "localImage", path: "/work/images/a.png" },
    ]);
    assert.deepEqual(buildTurnInput("", ["/images/a.png"], "/work"), [{ type: "localImage", path: "/images/a.png" }]);
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
});
