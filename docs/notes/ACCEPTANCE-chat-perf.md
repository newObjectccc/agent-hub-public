# feat/e2-chat-perf 返工验证（行为回归修复）· 2026-09-30

> 本文件从 `evidence/chat-perf/rework-verify.md` 迁入（开源整备）：验收文字记录留档于 docs/，
> 文中引用的截图为过程产物，不入库（历史可从 git 记录恢复）。

对应返工 commit（本文件同批提交）。截图：`rework-load-older-800msgs.png`、`rework-same-frame-no-scroll.png`。

## 1. 回归测试红绿对比（vitest，临时回退 934fcda 实现后跑同一测试）

RED（`git checkout 934fcda -- ChatPage.tsx MessageBubble.tsx Markdown.tsx` 后）：

```
× stick-to-bottom 一帧竞态（AC5） > scroll 事件与流式提交同帧：上滚越过 160px 后不误滚底
  → expected true to be false          （误触发滚底/scrollTo）
× loadOlder 前插与窗口化锚点（AC7） > loadOlder 前插更早一页：同批窗口重置为全量
  → expected <div class="msg-window-pad" …> to be null   （slice(旧 windowStart) 错位帧仍在）
× 图片 load/error 状态标记 > MessageBubble 图片 error → img-error（撤掉占位，不永留 16:10）
  → expected false to be true          （onError 缺失，占位永留）
× 图片 load/error 状态标记 > Markdown 图片 error（捕获委托）→ img-error；后续 load → img-loaded
  → expected false to be true          （error 事件无处理）
Tests  4 failed | 8 passed (12)
```

GREEN（修复后）：

```
✓ src/pages/ChatPage.scroll.test.tsx (4 tests)
✓ src/components/MessageBubble.test.tsx (8 tests)
Tests  12 passed (12)
```

注：`pruneDetachedRowEls` 纯函数单测（messageWindow.test.ts）在两轮均绿（函数在红轮已存在，属顺手修 4 的函数级证据）。

## 2. 浏览器复核 ①：800 条会话拖到顶自动加载更早（AC7）

真实 Chrome（ego-browser）+ 本地 server（pi session fixture，800 条消息）+ vite dev，真实 ChatPage 路径。
16 轮"拖到顶 → 自动加载更早一页"，锚点指标：
- `anchorJumpPx` = 加载前后视口内同一条锚点行 `getBoundingClientRect().top` 差（跳动）
- `anchorDriftPx` = ΔscrollTop − ΔscrollHeight（锚点漂移，0 = 视口内容不动）

```
round 0:  rows 50->100   pad=false anchorJump +0.7px drift 0
round 1:  rows 100->105  pad=true  anchorJump -0.3px drift 0
round 2:  rows 105->155  pad=true  anchorJump -0.3px drift 0
round 3:  rows 155->250  pad=false anchorJump +0.7px drift 0
round 4:  rows 250->255  pad=true  anchorJump -0.3px drift 0
round 5:  rows 255->305  pad=true  anchorJump -0.3px drift 0
round 6:  rows 305->400  pad=false anchorJump -0.3px drift 0
round 7:  rows 400->405  pad=true  anchorJump +0.7px drift 0
round 8:  rows 405->455  pad=true  anchorJump -0.3px drift 0
round 9:  rows 455->550  pad=false anchorJump -0.3px drift 0
round 10: rows 550->555  pad=true  anchorJump +0.7px drift 0
round 11: rows 555->650  pad=false anchorJump -0.3px drift 0
round 12: rows 650->700  pad=false anchorJump -0.3px drift 0
round 13: rows 700->705  pad=true  anchorJump +0.7px drift 0
round 14: rows 705->800  pad=false anchorJump -0.3px drift 0
round 15: done（800/800 全量加载完，无跳动/无夹底）
```

结论：16 轮锚点漂移全部 0px，跳动 ≤ 0.7px（亚像素级测量噪声），窗口化（pad=true 轮次）与全量轮次表现一致。
截图：`rework-load-older-800msgs.png`。

## 3. 浏览器复核 ②：scroll 与消息提交同帧不误滚（AC5）

真实 Chrome，页面内注入（复核后失效，不影响产物）：
- `requestAnimationFrame` 吞掉 → 固化"rAF 回调未跑"的竞态窗口（旧 stickToBottomRef 镜像永不更新）
- `fetch` 拦截 `/prompt` → 发送零副作用（只走乐观占位 setMessages 提交路径）
- hook `scrollTop` setter / `scrollTo` → 记录组件的滚动写入

```
warmPhase（贴底提交）:            scrollToCalls=1  top 6281 -> 6354   （跟随滚底 ✔ 行为保持）
ac5_sameFrame_afterScrollUp:      top=1000（上滚越过阈值）+ scroll 事件派发 + 同帧提交
                                  codeWrites=0  scrollToCalls=0  top 1000 -> 1000  rows 51 -> 52
                                  ac5_expect_no_scroll: true        （不拉回底部 ✔）
controlStickToBottom（贴底提交）:  codeWrites=1  top -> 6500  rows 52 -> 53
                                  control_expect_scroll: true        （贴底仍跟随 ✔）
```

截图：`rework-same-frame-no-scroll.png`。

## 4. 全量验证

- `pnpm -r test`：server 335 pass / 0 fail；web 317 pass（310 + 7 新增）/ 0 fail
- `web npm run lint`（tsc -b）：通过
- `pnpm -r build`：通过（vite 产物正常）
