import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {planPolicyOverrides, assertPolicyNotWeaker} from "../adapters/codex-policy.js";
import {parseEffectivePolicy} from "../adapters/codex-host-protocol.js";
const echo=(approvalPolicy="on-request",type="workspaceWrite",extra:Record<string,unknown>={})=>({approvalPolicy,sandbox:{type,networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:false,excludeSlashTmp:false,...extra}});
describe("Codex 权限覆盖必须单向收紧",()=>{
  it("默认 inherit 不要求读取原配置，也不下发覆盖",()=>assert.deepEqual(planPolicyOverrides({},{}),{}));
  it("只读不能覆盖为可写，untrusted 不能覆盖为 on-request",()=>{
    assert.throws(()=>planPolicyOverrides(echo("untrusted","readOnly"),{sandbox:"workspace-write"}),/更宽松/);
    assert.throws(()=>planPolicyOverrides(echo("untrusted"),{approvalPolicy:"on-request"}),/更宽松/);
  });
  it("未知/细粒度策略不得用已知模式直接覆盖",()=>{
    assert.throws(()=>planPolicyOverrides({approvalPolicy:{granular:{}}},{approvalPolicy:"untrusted"}),/无法确认/);
    assert.throws(()=>planPolicyOverrides({},{sandbox:"read-only"}),/无法确认/);
  });
  it("相同策略无需重建；更严策略明确列出",()=>{
    assert.deepEqual(planPolicyOverrides(echo(),{approvalPolicy:"on-request",sandbox:"workspace-write"}),{});
    assert.deepEqual(planPolicyOverrides(echo(),{approvalPolicy:"untrusted",sandbox:"read-only"}),{approvalPolicy:"untrusted",sandbox:"read-only"});
  });
  it("有效收紧通过；被忽略的覆盖必须拒绝",()=>{
    assert.doesNotThrow(()=>assertPolicyNotWeaker(echo(),echo("untrusted","readOnly"),{approvalPolicy:"untrusted",sandbox:"read-only"},"/work"));
    assert.throws(()=>assertPolicyNotWeaker(echo(),echo(),{approvalPolicy:"untrusted"},"/work"),/未应用/);
  });
  it("收紧文件写入时不能附带放开网络",()=>assert.throws(()=>assertPolicyNotWeaker(echo(),echo("untrusted","readOnly",{networkAccess:true}),{sandbox:"read-only"},"/work"),/网络/));
  it("额外可写目录、临时目录与未知权限维度均拒绝",()=>{
    assert.throws(()=>assertPolicyNotWeaker(echo(),echo("untrusted","workspaceWrite",{writableRoots:["/private"]}),{approvalPolicy:"untrusted"},"/work"),/可写目录/);
    assert.throws(()=>assertPolicyNotWeaker(echo("on-request","workspaceWrite",{excludeSlashTmp:true}),echo("untrusted"),{approvalPolicy:"untrusted"},"/work"),/临时目录/);
    assert.throws(()=>assertPolicyNotWeaker(echo(),echo("untrusted","workspaceWrite",{access:{}}),{approvalPolicy:"untrusted"},"/work"),/尚未支持/);
  });
  it("danger-full-access 不等于关闭审批",()=>{
    assert.equal(parseEffectivePolicy(echo("untrusted","dangerFullAccess"))?.bypass,false);
    assert.equal(parseEffectivePolicy(echo("never","readOnly"))?.bypass,true);
  });
});
