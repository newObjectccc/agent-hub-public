# 贡献指南

感谢关注 Agent Hub！以下是开发协作约定。

## 开发流程

1. 从 `main` 建功能分支（`feat/*` / `fix/*`），开发在独立 worktree 更佳
2. 实现 + 测试（**测试只增不减**），`pnpm -r build && pnpm -r lint && pnpm -r test` 全绿
3. 验收：功能需真实浏览器验证（移动优先，响应式 320/360/390/430/768/1024 六档）、关键链路实测（截图留证）
4. 合并前解决冲突，保持行为语义不回退

## 代码约定

- **TypeScript strict**、ESM；server 纯函数与 IO 分层（便于单测）
- **UI**：紧凑野兽派（`web/src/styles.css` 设计 token）；深浅色、`prefers-reduced-motion`、触控 ≥44px 全覆盖
- **安全**：git/文件 API 只读 + 路径校验；密钥走 `${ENV_VAR}` 不入库；子进程 `execFile` 数组传参无 shell
- **跨平台**：CLI 纯 Node 内置模块（零 bash）；平台差异优雅降级
- 注释与文档用中文（项目惯例），标识符英文

## 测试

- server：`node --test`（src/test/）
- web：vitest（`*.test.tsx` / `*.test.ts`）
- cli / integrations：`node --test`
- 新功能必须带测试；性能改动带 before/after 对比数据

## 提交

- 提交信息说明“做了什么 + 为什么”；含 UI 变更附截图路径
- 每批提交范围明确、可独立验证、可回滚

## 多会话/多代理协同（部署纪律）

多个开发会话（人类或 AI 代理）并行改同一仓库时：

- **代码与测试**：各自提交（共享文件按 hunk 拆分 stage，不裹挟他人在途改动）
- **构建与部署单点化**：验证用 `npm test` / `tsc --noEmit`，**不要在工作区跑 `npm run build`**——server 静态托管实时读 `web/dist`，工作区构建会把半成品产物直接发上线（实测踩坑：手机黑屏）
- 发布构建/重启由单一发布流程执行（构建前确认工作区干净）
