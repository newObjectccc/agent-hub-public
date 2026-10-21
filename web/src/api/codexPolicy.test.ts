import {describe, it, expect} from "vitest";
import {codexPolicySummary, normalizeCodexPolicy} from "./codexPolicy";
import {echoText} from "./attach";
describe("Codex 实际权限提示", () => {
  it("never 明确不请求审批，未知状态不承诺有门禁", () => {
    expect(codexPolicySummary({approval:"never",sandbox:"workspace-write",bypass:true})).toContain("不请求操作审批");
    expect(codexPolicySummary()).toContain("尚未确认");
    expect(codexPolicySummary()).not.toContain("会在这里询问");
  });
  it("untrusted 与 on-request 分别说明何时询问", () => {
    expect(codexPolicySummary({approval:"untrusted",sandbox:"read-only",bypass:false})).toContain("需要确认的操作");
    expect(codexPolicySummary({approval:"on-request",sandbox:"workspace-write",bypass:false})).toContain("模型提出申请时");
  });
  it("全文件访问与审批独立，兼容旧 server 的错误 bypass 字段", () => {
    const policy=normalizeCodexPolicy({approval:"untrusted",sandbox:"danger-full-access",bypass:true});
    expect(policy?.bypass).toBe(false);
    expect(codexPolicySummary(policy)).toContain("需要确认的操作");
    expect(codexPolicySummary(policy)).toContain("文件访问范围未限制");
  });
  it("回执展示实际设置，不固定保证审批同步", () => {
    const text=echoText({channel:"attach",phase:"acked",source:"codex",effectivePolicy:{approval:"never",sandbox:"read-only",bypass:true}});
    expect(text).toContain("不请求操作审批");
    expect(text).not.toContain("回复与审批将在此同步");
  });
});
