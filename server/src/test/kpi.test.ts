/**
 * KPI source 归一化、${ENV_VAR} 解析、jsonPath、错误隔离单测。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  KpiService,
  normalizeHttpCard,
  normalizeStaticCard,
  parseJsonPath,
  parseSources,
  resolveEnvRefs,
  resolveHeaders,
  type FetchLike,
} from "../kpi.js";

const NOW = "2026-02-18T12:00:00.000Z";

describe("kpi: ${ENV_VAR} 解析", () => {
  it("替换环境变量引用", () => {
    const env = { MY_TOKEN: "secret-value" } as NodeJS.ProcessEnv;
    assert.equal(resolveEnvRefs("Bearer ${MY_TOKEN}", env), "Bearer secret-value");
  });

  it("未设置的变量解析为空字符串（密钥不落文件/日志）", () => {
    assert.equal(resolveEnvRefs("Bearer ${NOT_SET_VAR}", {} as NodeJS.ProcessEnv), "Bearer ");
  });

  it("无占位符原样返回；多处引用全部替换", () => {
    const env = { A: "1", B: "2" } as NodeJS.ProcessEnv;
    assert.equal(resolveEnvRefs("plain", env), "plain");
    assert.equal(resolveEnvRefs("${A}-${B}", env), "1-2");
  });

  it("resolveHeaders 对 header 值解析环境变量", () => {
    const env = { MY_TOKEN: "t0k3n" } as NodeJS.ProcessEnv;
    const headers = resolveHeaders({ Authorization: "Bearer ${MY_TOKEN}", "X-Plain": "v" }, env);
    assert.deepEqual(headers, { Authorization: "Bearer t0k3n", "X-Plain": "v" });
  });
});

describe("kpi: jsonPath 简单路径解析", () => {
  const data = { data: { value: 98.2, label: "ok", list: [{ v: 1 }, { v: 2 }] } };

  it("$.data.value", () => {
    assert.equal(parseJsonPath("$.data.value")(data), 98.2);
  });

  it("$['data'].label / $[0] / $.data.list.1.v", () => {
    assert.equal(parseJsonPath("$['data'].label")(data), "ok");
    assert.deepEqual(parseJsonPath("$[0]")([{ a: 1 }]), { a: 1 });
    assert.equal(parseJsonPath("$.data.list.1.v")(data), 2);
    assert.equal(parseJsonPath("$.data.list[1].v")(data), 2);
  });

  it("路径不存在返回 undefined", () => {
    assert.equal(parseJsonPath("$.data.missing.deep")(data), undefined);
  });

  it("非法路径抛错", () => {
    assert.throws(() => parseJsonPath("data.value"));
    assert.throws(() => parseJsonPath("$.data["));
  });
});

describe("kpi: 卡片归一化", () => {
  it("static：unit/trend/delta/link，字段不缺省", () => {
    const card = normalizeStaticCard(
      { id: "s1", title: "静态", type: "static", value: "OK", trend: "flat", link: "https://x/" },
      NOW,
    );
    assert.deepEqual(card, {
      id: "s1",
      title: "静态",
      value: "OK",
      trend: "flat",
      delta: null,
      updatedAt: NOW,
      link: "https://x/",
      error: null,
    });
  });

  it("static：非法 trend 归一为 unknown", () => {
    const card = normalizeStaticCard({ id: "s2", title: "t", type: "static", value: 1, trend: "rising" }, NOW);
    assert.equal(card.trend, "unknown");
    assert.equal(card.value, "1");
  });

  it("http-json：数值附加 unit", () => {
    const card = normalizeHttpCard(
      { id: "h1", title: "完成率", type: "http-json", jsonPath: "$.data.value", unit: "%" },
      { data: { value: 98.2 } },
      NOW,
    );
    assert.equal(card.value, "98.2%");
    assert.equal(card.error, null);
  });

  it("http-json：字符串原样", () => {
    const card = normalizeHttpCard(
      { id: "h2", title: "s", type: "http-json", jsonPath: "$.data.value" },
      { data: { value: "OK" } },
      NOW,
    );
    assert.equal(card.value, "OK");
  });

  it("http-json：缺 jsonPath / 路径缺失 → error 字段", () => {
    const noPath = normalizeHttpCard({ id: "h3", title: "s", type: "http-json" }, {}, NOW);
    assert.ok(noPath.error);
    const missing = normalizeHttpCard(
      { id: "h4", title: "s", type: "http-json", jsonPath: "$.nope" },
      {},
      NOW,
    );
    assert.ok(missing.error?.includes("$.nope"));
  });
});

describe("kpi: KpiService 刷新与错误隔离", () => {
  let configDir: string;

  before(async () => {
    configDir = await mkdtemp(join(tmpdir(), "agent-hub-kpi-"));
    await writeFile(
      join(configDir, "kpi-sources.json"),
      JSON.stringify({
        sources: [
          {
            id: "auth-http",
            title: "带鉴权的 HTTP 指标",
            type: "http-json",
            url: "https://api.example.com/metric",
            headers: { Authorization: "Bearer ${TEST_KPI_TOKEN}" },
            jsonPath: "$.data.value",
            unit: "%",
          },
          { id: "bad-http", title: "失败的 HTTP 指标", type: "http-json", url: "https://api.example.com/broken", jsonPath: "$.v" },
          { id: "static-ok", title: "静态值", type: "static", value: "OK", trend: "flat" },
        ],
      }),
    );
  });

  after(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("单卡片失败只写 error，不影响其它卡片；header 走环境变量", async () => {
    const seenAuth: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      if (url.includes("broken")) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      seenAuth.push(init?.headers?.Authorization ?? "");
      return { ok: true, status: 200, json: async () => ({ data: { value: 77.7 } }) };
    };

    const service = new KpiService({
      configDir,
      kpiRefreshMinutes: 5,
      env: { TEST_KPI_TOKEN: "tok-123" } as NodeJS.ProcessEnv,
      fetchFn,
      now: () => new Date(NOW),
    });
    await service.refresh();
    const cards = service.getCards();
    assert.equal(cards.length, 3);

    const authCard = cards.find((c) => c.id === "auth-http")!;
    assert.equal(authCard.value, "77.7%");
    assert.equal(authCard.error, null);
    assert.deepEqual(seenAuth, ["Bearer tok-123"]);

    const badCard = cards.find((c) => c.id === "bad-http")!;
    assert.equal(badCard.error, "HTTP 500");

    const staticCard = cards.find((c) => c.id === "static-ok")!;
    assert.equal(staticCard.value, "OK");
    assert.equal(staticCard.error, null);
    assert.equal(staticCard.updatedAt, NOW);
  });

  it("parseSources：非法结构抛错、非法条目跳过", () => {
    assert.throws(() => parseSources("{oops"));
    assert.throws(() => parseSources('{"nope": 1}'));
    const sources = parseSources(JSON.stringify({ sources: [{ id: "a", title: "A", type: "static", value: 1 }, { title: "no-id" }] }));
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, "a");
  });
});
