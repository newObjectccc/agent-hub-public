/**
 * claude-mirror 纯函数单测（D7 投屏）：tmux 命名、spawn 计划引号安全、镜像脚本路径。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTmuxSpawnPlan, mirrorSessionName, hasTmux } from "../adapters/claude-mirror.js";

describe("mirrorSessionName", () => {
  it("取会话 id 前 8 位字母数字并去连字符", () => {
    assert.equal(mirrorSessionName("8d2ccdea-419b-45ae-9c82-e251ded548e4"), "hub-8d2ccdea");
    assert.equal(mirrorSessionName("abc"), "hub-abcxxxxx");
  });
});

describe("buildTmuxSpawnPlan", () => {
  it("tmux new-session 命名 detach + node 渲染器", () => {
    const plan = buildTmuxSpawnPlan("8d2ccdea-419b-45ae-9c82-e251ded548e4", "/w/s.jsonl", "/x/mirror.js");
    assert.equal(plan.bin, "tmux");
    assert.equal(plan.sessionName, "hub-8d2ccdea");
    assert.deepEqual(plan.args.slice(0, 4), ["new-session", "-d", "-s", "hub-8d2ccdea"]);
    const cmd = plan.args[4];
    assert.match(cmd, /node '\/x\/mirror\.js'/);
    assert.match(cmd, /--file '\/w\/s\.jsonl'/);
    assert.match(cmd, /--label /);
  });

  it("单引号路径安全（shQuote 转义）", () => {
    const plan = buildTmuxSpawnPlan("s1", "/w/it's/s.jsonl", "/x/mirror.js");
    const cmd = plan.args[4];
    assert.ok(cmd.includes(`'/w/it'\\''s/s.jsonl'`));
    assert.equal(plan.sessionName, "hub-s1xxxxxx");
  });
});

describe("hasTmux", () => {
  it("探测失败返回 false（不抛）", async () => {
    const fake = ((_f: string, _a: string[], cb: (err: Error | null) => void) => {
      cb(new Error("no tmux"));
    }) as Parameters<typeof hasTmux>[0];
    assert.equal(await hasTmux(fake), false);
    const fakeOk = ((_f: string, _a: string[], cb: (err: Error | null) => void) => {
      cb(null);
    }) as Parameters<typeof hasTmux>[0];
    assert.equal(await hasTmux(fakeOk), true);
  });
});
