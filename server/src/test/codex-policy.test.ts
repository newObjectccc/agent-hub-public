import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {planPolicyOverrides, assertPolicyApplied, configuredCodexPolicy, buildExecPolicyArgs} from "../adapters/codex-policy.js";
import {DEFAULT_CODEX_DRIVER_CONFIG} from "../config.js";
import {parseEffectivePolicy} from "../adapters/codex-host-protocol.js";
const echo=(approvalPolicy="on-request",type="workspaceWrite",extra:Record<string,unknown>={})=>({approvalPolicy,sandbox:{type,networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:false,excludeSlashTmp:false,...extra}});
describe("Codex 权限覆盖遵从 Hub 的显式配置",()=>{
  it("默认配置为两条通道提供完整权限，显式 inherit 不产生覆盖",()=>{
    assert.deepEqual(configuredCodexPolicy(DEFAULT_CODEX_DRIVER_CONFIG),{approvalPolicy:"never",sandbox:"danger-full-access"});
    assert.deepEqual(configuredCodexPolicy({approvalPolicy:"inherit",sandbox:"inherit"}),{});
    assert.deepEqual(buildExecPolicyArgs({approvalPolicy:"never",sandbox:"danger-full-access"}),["-c",'approval_policy="never"',"-c",'sandbox_mode="danger-full-access"']);
  });
  it("默认 inherit 不要求读取原配置，也不下发覆盖",()=>assert.deepEqual(planPolicyOverrides({},{}),{}));
  it("允许把受限基线显式切换为最高权限",()=>{
    const requested={approvalPolicy:"never",sandbox:"danger-full-access"} as const;
    assert.deepEqual(planPolicyOverrides(echo("untrusted","readOnly"),requested),requested);
    assert.doesNotThrow(()=>assertPolicyApplied(echo("untrusted","readOnly"),echo("never","dangerFullAccess"),requested,"/work"));
  });
  it("未知基线可申请明确档位，但最终回显必须符合申请",()=>{
    const requested={approvalPolicy:"never",sandbox:"danger-full-access"} as const;
    assert.deepEqual(planPolicyOverrides({},requested),requested);
    assert.doesNotThrow(()=>assertPolicyApplied({},echo("never","dangerFullAccess"),requested,"/work"));
    assert.doesNotThrow(()=>assertPolicyApplied({approvalPolicy:"never"},echo("never","dangerFullAccess"),{sandbox:"danger-full-access"},"/work"));
    assert.throws(()=>assertPolicyApplied({}, {},requested,"/work"),/无法确认/);
  });
  it("申请最高权限不能顺便改变未覆盖的维度",()=>{
    assert.throws(()=>assertPolicyApplied(echo("untrusted","readOnly"),echo("never","dangerFullAccess"),{approvalPolicy:"never"},"/work"),/未申请/);
  });
  it("相同策略无需重建；更严策略明确列出",()=>{
    assert.deepEqual(planPolicyOverrides(echo(),{approvalPolicy:"on-request",sandbox:"workspace-write"}),{});
    assert.deepEqual(planPolicyOverrides(echo(),{approvalPolicy:"untrusted",sandbox:"read-only"}),{approvalPolicy:"untrusted",sandbox:"read-only"});
  });
  it("有效收紧通过；被忽略的覆盖必须拒绝",()=>{
    assert.doesNotThrow(()=>assertPolicyApplied(echo(),echo("untrusted","readOnly"),{approvalPolicy:"untrusted",sandbox:"read-only"},"/work"));
    assert.throws(()=>assertPolicyApplied(echo(),echo(),{approvalPolicy:"untrusted"},"/work"),/未应用/);
  });
  it("收紧文件写入时不能附带放开网络",()=>assert.throws(()=>assertPolicyApplied(echo(),echo("on-request","readOnly",{networkAccess:true}),{sandbox:"read-only"},"/work"),/网络/));
  it("额外可写目录、临时目录与未知权限维度均拒绝",()=>{
    assert.throws(()=>assertPolicyApplied(echo(),echo("untrusted","workspaceWrite",{writableRoots:["/private"]}),{approvalPolicy:"untrusted"},"/work"),/可写目录/);
    assert.throws(()=>assertPolicyApplied(echo("on-request","workspaceWrite",{excludeSlashTmp:true}),echo("untrusted"),{approvalPolicy:"untrusted"},"/work"),/临时目录/);
    assert.throws(()=>assertPolicyApplied(echo(),echo("untrusted","workspaceWrite",{access:{}}),{approvalPolicy:"untrusted"},"/work"),/尚未支持/);
  });
  it("danger-full-access 不等于关闭审批",()=>{
    assert.equal(parseEffectivePolicy(echo("untrusted","dangerFullAccess"))?.bypass,false);
    assert.equal(parseEffectivePolicy(echo("never","readOnly"))?.bypass,true);
  });
});
