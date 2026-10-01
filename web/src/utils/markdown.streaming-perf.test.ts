/**
 * 长文流式渲染性能对比（UX 审查 AC5）：全文逐次重解析（现状） vs 块级缓存/尾段增量。
 * 断言口径：解析行数与渲染块数（确定性指标，不依赖墙钟）；
 * 耗时仅作对比表输出，不做硬断言（CI 抖动不致红）。
 */
import { describe, expect, it } from "vitest";
import { MarkdownRenderCache, renderMarkdown } from "./markdown";

/** 构造长文档：blockCount 个块（段落/标题/列表/代码块轮换），模拟 agent 长回复 */
function buildLongDoc(blockCount: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < blockCount; i++) {
    const kind = i % 4;
    if (kind === 0) blocks.push(`## 小节 ${i}\n\n段落内容 ${i}：**粗体** 与 \`code\` 与 [链接](https://example.com/${i})。`);
    else if (kind === 1) blocks.push(`\`\`\`ts\nconst v${i} = ${i};\nconsole.log(v${i});\n\`\`\``);
    else if (kind === 2) blocks.push(`- 要点 ${i}-1\n- 要点 ${i}-2\n- 要点 ${i}-3`);
    else blocks.push(`> 引用 ${i}-1\n> 引用 ${i}-2`);
  }
  return blocks.join("\n\n");
}

describe("长文流式渲染性能对比（before/after）", () => {
  it("300 块长回复 × 60 步流式：缓存版解析量大幅下降且输出逐字符一致", () => {
    const fullDoc = buildLongDoc(300);
    const lines = fullDoc.split("\n");
    const steps = 60;
    const stepSize = Math.ceil(lines.length / steps);

    // 改造前：每步全文重新解析
    let beforeParsedLines = 0;
    let beforeMs = 0;
    // 改造后：块级缓存 + 尾段增量
    const cache = new MarkdownRenderCache();
    let afterMs = 0;

    let mismatches = 0;
    for (let s = 1; s <= steps; s++) {
      const partial = lines.slice(0, Math.min(lines.length, s * stepSize)).join("\n");

      const t0 = performance.now();
      const beforeHtml = renderMarkdown(partial);
      beforeMs += performance.now() - t0;
      beforeParsedLines += partial.split("\n").length;

      const t1 = performance.now();
      const afterHtml = cache.render(partial);
      afterMs += performance.now() - t1;

      // 硬约束：渲染输出逐字符一致
      if (beforeHtml !== afterHtml) mismatches++;
    }
    expect(mismatches).toBe(0);

    const afterParsedLines = cache.stats.parsedLines;
    const afterReusedBlocks = cache.stats.reusedBlocks;
    // 解析量：缓存版只解析尾段 → 至少降一个数量级
    expect(afterParsedLines).toBeLessThan(beforeParsedLines / 8);
    // 未变块确实被复用（而不是偷偷全量重渲染）
    expect(afterReusedBlocks).toBeGreaterThan(afterParsedLines * 5);

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "[perf] 300 块长回复流式渲染（60 步，jsdom）",
        "| 指标 | 改造前(全文重解析) | 改造后(块级缓存/尾段增量) | 提升 |",
        "| --- | --- | --- | --- |",
        `| 累计解析行数 | ${beforeParsedLines} | ${afterParsedLines} | ${(beforeParsedLines / Math.max(1, afterParsedLines)).toFixed(1)}x ↓ |`,
        `| 复用渲染块数 | 0 | ${afterReusedBlocks} | — |`,
        `| 累计耗时(ms) | ${beforeMs.toFixed(1)} | ${afterMs.toFixed(1)} | ${(beforeMs / Math.max(0.001, afterMs)).toFixed(1)}x ↓ |`,
        "",
      ].join("\n"),
    );
  });

  it("中途改早期段落（缓存失效场景）不劣化到不可用：输出仍一致", () => {
    const fullDoc = buildLongDoc(200);
    const lines = fullDoc.split("\n");
    const cache = new MarkdownRenderCache();
    cache.render(lines.slice(0, Math.floor(lines.length / 2)).join("\n"));
    // 早期块被修改 → 前缀失效 → 全量重解析兜底
    const edited = `改头换面的开头\n\n${fullDoc}`;
    expect(cache.render(edited)).toBe(renderMarkdown(edited));
    // 后续尾部增长继续走缓存
    expect(cache.render(`${edited}\n\n尾巴`)).toBe(renderMarkdown(`${edited}\n\n尾巴`));
  });
});
