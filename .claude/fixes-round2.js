export const meta = {
  name: 'completeness-fixes-round2',
  description: '修复对抗审查发现：static v10 契约 / WS Origin / abort 门禁 / host-request 409 / 文档与冒烟补强',
  phases: [
    { title: 'Fix', detail: '4 个 agent 并行：server 构建+WS 安全 / server 契约+配置 / web 自愈 / pack 冒烟' },
    { title: 'VerifyTests', detail: '全量 install/build/lint/test 实跑' },
    { title: 'Docs', detail: 'API_CONTRACT 修正 + CHANGELOG 数字校正' },
    { title: 'Review', detail: '复审新修复的绕过面与一致性' },
  ],
}

// 仓库路径参数化：默认取当前工作目录，或用 AGENT_HUB_REPO 显式指定（历史版本曾硬编码本机绝对路径）
const REPO = process.env.AGENT_HUB_REPO ?? process.cwd()

const COMMON = [
  '你在仓库 ' + REPO + ' 工作（工作区有一批未提交 WIP + 刚完成一轮修复——**勿回滚、勿 git commit、勿 git add**，在其基础上继续）。',
  '注释风格：中文叙述 +（D3）式标注 + 技术标识符英文。测试命名中文（现有风格）。**测试只增不减**。',
  '只改你负责的清单内文件。改完必须跑通你所涉包的测试（server: cd server && npm test；web: cd web && npm test；cli: cd cli && npm test）。',
  '最终文本是返回值（结构化）。',
].join('\n')

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'number' },
    testsTotal: { type: 'number', description: '该包 test 跑完后的总数；没跑填 0' },
    notes: { type: 'string' },
  },
  required: ['summary', 'filesChanged', 'testsAdded', 'testsTotal', 'notes'],
}

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    allGreen: { type: 'boolean' },
    counts: {
      type: 'object',
      properties: {
        server: { type: 'string' }, web: { type: 'string' }, cli: { type: 'string' },
        piCommand: { type: 'string' }, piLiveFeed: { type: 'string' }, total: { type: 'string' },
      },
      required: ['server', 'web', 'cli', 'piCommand', 'piLiveFeed', 'total'],
    },
    newTestCounts: {
      type: 'object',
      properties: {
        serverFunctional: { type: 'string', description: 'server 本批新增用例静态数（按测试文件 it() 计）' },
        webFunctional: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['serverFunctional', 'webFunctional', 'note'],
    },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['allGreen', 'counts', 'newTestCounts', 'failures'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'title', 'evidence'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['refuted', 'findings', 'verdict'],
}

const wsSecurityPrompt = COMMON + [
  '',
  '任务：server 构建恢复 + WS 安全两项（你独占 server/src/index.ts、server/src/ws.ts 及对应测试 server/src/test/ws.test.ts、ws-pending.test.ts、ws-auth-wiring.test.ts、live.test.ts、terminal-route.test.ts）。',
  '',
  '## 修复 1（blocker）：@fastify/static v8→v10 破坏 setHeaders 契约，server 编译全挂',
  'server/src/index.ts 约 275-280 行 fastifyStatic 注册的 setHeaders(res, filePath) 里用 res.setHeader("Cache-Control", ...)。v8 传原生 res，v10 改传 FastifyReply（node_modules/@fastify/static/index.js:498 调 setHeaders(reply, ...)；types/index.d.ts:96 声明 setHeaders?: (reply: FastifyReply, path, stat)），FastifyReply 无 setHeader → tsc TS2551，server build/lint/test 三重阻断。',
  '修法：参数改名 reply，改用 reply.header("Cache-Control", ...)（v10 在 reply.headers() 之后调 setHeaders，可覆盖插件自设头——保持现有「/assets/* 长缓存 immutable、其余协商缓存」语义不变）。改完 cd server && npm test 必须全绿。',
  '',
  '## 修复 2（blocker）：WS upgrade 无 Origin 校验，默认配置下任意网页可跨站劫持会话',
  'HTTP 侧 createApp 有 CORS 闸（index.ts:231-237，非法 Origin 403，注释明言「防恶意网页跨域读会话/发 prompt」），但 Fastify onRequest 不覆盖 raw upgrade；WS upgrade 只有 Host/DNS 白名单 + token 校验，而 auth.enabled 默认 false（config.ts:58）时 authorizeUpgrade 直接放行。攻击面（README 文档化的 tailscale serve HTTPS 部署尤其危险，*.ts.net 在 Host 白名单内）：恶意网页 new WebSocket("wss://<host>/ws/events") 无 token 即可实时读全部会话、经 /ws/sessions/:id 发 prompt。',
  '修法：在 ws.ts 的 upgrade 处理中增加 Origin 同口径校验（**只作用于 hub 的 WS 路径** /ws/events 与 /ws/sessions/*；/terminal/ws 等非 hub 路径保持现有 UPGRADE_HANDLED_MARK 逻辑不动，不要误杀 ttyd 反代通道）：',
  '- 有 Origin 头（浏览器必带）：必须通过与 HTTP 相同的判定——复用 server/src/config.ts 导出的 isSameOrigin / isAllowedCrossOrigin（对照 index.ts CORS 闸的调用方式，含 isAllowedHostHeader 派生 trustedHost 的逻辑；非可信 Host 时协议也要对上）。不通过 → 直接 403 断连（对齐现有 authorizeUpgrade 的 socket.write("HTTP/1.1 ...") + destroy 风格）。',
  '- 无 Origin 头（非浏览器客户端：node ws 库、curl、自动化）：维持现有 token 判定不变（不能破坏测试与自动化）。',
  '- 实现建议：WsHub.attach 的 opts 增加可选 origin 校验回调（如 isAllowedOrigin），由 index.ts 的 attachSessionWs 装配时用 config 派生闭包传入（与 HTTP 闸同源同逻辑，抽公共函数避免双份维护——index.ts 里 HTTP 的 crossOriginAllowed 逻辑抽成可复用导出函数）。鉴权与 Origin 校验是 AND 关系。',
  '- prompt 已过 promptGuard，origin 校验是从入口掐断跨站连接，双层防御。',
  '',
  '## 修复 3（major）：WS abort 绕过 promptGuard，锁屏/接管期可中止 turn',
  'ws.ts handleClientMessage 的 case "abort"（约 425-435 行）直接 hub.abort，不过 promptGuard；仅 case "prompt" 过。HTTP 侧 /api/sessions/:id/abort 被应用锁全局 hook 423 拦（routes.ts:1044-1053）。',
  '修法（注意语义差异，不要简单复用 promptGuard——它含 ATTACH_ACTIVE 拒绝，而 abort 在接管期是合法且必要的）：',
  '- 读 server/src/routes.ts 约 490-516 的 HTTP /abort handler 语义并镜像到 WS：先过应用锁门禁（与 promptGuard 的锁分支同判据）；锁屏时拒绝；通过后 dispatch 与 HTTP 一致——claude 驱动接管中（claudeDriver.isAttached）走 driver.abortTurn，否则 hub.abort。',
  '- 实现建议：attachSessionWs 装配处再提供一个 abortHandler 回调（或扩展 promptGuard 签名为带 kind 参数），WS abort 分支调用它；返回错误时向 WS 客户端回 error 帧（对齐 prompt 分支的错误回执形状）。',
  '- 测试：锁屏时 WS abort 被拒且 hub.abort 未被调用；接管期 WS abort 走 driver.abortTurn 分支（fake driver 断言）；Origin 校验用例（非法 Origin 的 upgrade 被拒、无 Origin 非浏览器放行、白名单 origin 放行）；/terminal/ws 不受 origin 校验误伤（已有 terminal-route 测试回归确保仍绿）。',
  '改完 cd server && npm test 全绿。',
].join('\n')

const contractPrompt = COMMON + [
  '',
  '任务：server 契约一致性 + 配置告警（你独占 server/src/routes.ts、server/src/adapters/claude-driver.ts、server/src/adapters/claude-host-protocol.ts、server/src/config.ts、server/src/types.ts、server/src/errors.ts 及测试 server/src/test/attach-claude-route.test.ts、claude-driver.test.ts、config.test.ts。**不要**动 index.ts / ws.ts——另一 agent 正在改）。',
  '',
  '## 修复 1（major）：host-requests「已决 → 409 HOST_REQUEST_RESOLVED」契约不可达',
  'docs/API_CONTRACT.md:836 承诺「未知 → 404 HOST_REQUEST_NOT_FOUND；已决 → 409 HOST_REQUEST_RESOLVED」。但 claude-driver.ts 的 finishHostRequest（约 608 行）把请求从 hostRequests 直接删除 → 已决 id 的 respondHostRequest 返回 false，routes.ts:764-771 再用 listHostRequests（仅未决）判 pending，三元 pending ? 409 : 404 的 409 分支近乎不可达（只有竞态窗口），双重应答/移动端幂等回放实际拿到 404「不存在」，与契约相反。',
  '修法选 (a) 修代码满足契约（文档保持不变）：',
  '- ClaudeDriverHub 在 finishHostRequest 时把已决 id 记入短期「已决记忆」（Map<id, 过期时间>，TTL 约 5 分钟，上限约 200 条防膨胀，过期/超限淘汰最旧）。',
  '- ClaudeDriverLinkLike 增加 isResolvedHostRequest(id): boolean（增量接口，记得更新 attach-claude-route.test.ts 里的 fake driver）。',
  '- routes.ts 的 respond 失败分支改为：isResolvedHostRequest → 409 HOST_REQUEST_RESOLVED；否则 404 HOST_REQUEST_NOT_FOUND。',
  '- 测试（只增不减）：应答成功后再次应答同一 id → 409 HOST_REQUEST_RESOLVED；未知 id 仍 404（现有用例保留）。',
  '',
  '## 修复 2（minor）：auth.enabled=true 且 token 空时静默 fail-open',
  'ws.ts authorizeUpgrade 与 routes.ts HTTP 钩子都是「enabled 且 token 非空才校验」——运维开了 enabled 忘填 token 即全面裸奔且无告警。修法（选告警路线，不改 fail-open 行为以免锁死默认零配置部署）：loadHubConfig（config.ts）在 auth.enabled===true 且 token 为空串/缺失时 push 一条明确 warning（如「auth.enabled=true 但 token 为空：鉴权不会生效，请填写 auth.token 或关闭 enabled」），config.test.ts 补该告警用例（enabled=true 空 token → warnings 非空；enabled=false → 无此告警）。token 非字符串被吞成空串的路径也走同一告警。',
  '',
  '## 修复 3（nit）：代码注释契约章节号错位',
  'server/src/types.ts:588 附近 UploadDto 注释与 server/src/errors.ts:34 附近上传错误码注释写的「契约 §11」应为「§15」（§11 实为终端驱动状态；docs 已是 §15）。server/src/routes.ts:955 注释若仍有「§11」残留一并核实改 §15。',
  '',
  '改完 cd server && npm test 全绿（若因另一 agent 并行改 index.ts/ws.ts 导致编译瞬时失败，稍等重试或只跑你相关测试文件确认无回归，并在 notes 注明）。',
].join('\n')

const webPrompt = COMMON + [
  '',
  '任务：web 自愈修复（你独占 web/src/ 目录）。',
  '',
  '## 修复（minor）：claudeDriver.enabled=false / 老 server 下残留 attach 模式卡死',
  '复现：claude 会话曾手动 pin 过 attach（localStorage saveAttachMode="attach"），server 随后 claudeDriver.enabled=false（terminal 不下发）或旧 server：',
  '1. web/src/pages/ChatPage.tsx loadSession 的 pinned 分支（约 382-388 行）直接 applyAttachMode(pinnedMode)，不查 attachAvailability、terminal 为空也不回落；',
  '2. web/src/api/attach.ts 的 isAttachSending（约 245-248 行）对 terminal=null 返回 true（条件 attached !== false 被 null 绕过）→ 发送走 attach 通道 → server 400「claude 会话接管未启用」，detach 也 400，用户卡死当场无法切换。',
  '修法（最小面）：',
  'a) isAttachSending：terminal 缺失（null/undefined）时返回 false（不可接管即不该走 attach 发送通道）；terminal 存在时行为不变（attached!==false 语义保留）。核对全部调用点语义无回归（pi/claude 双源）。',
  'b) ChatPage loadSession pinned 分支：pinnedMode==="attach" 且 attachAvailability(detail.session.terminal, detail.session.source).attachEnabled 为 false 时，本次打开 applyAttachMode("parallel")（**不改写 pin**——用户手动选择永久优先，只是本次不可用时优雅回落；attach 仍可手动再选）。attachAvailability 从 web/src/api/attach.ts 引入（若未引）。',
  'c) ChatPage.tsx 是 2000+ 行 WIP 大文件：改动限定在 loadSession 的 pinned 分支与必要的 import，别动其他区域。',
  'd) 顺带（上轮遗留备注）：ensureAttached 成功后 setTerminal 重建的 terminal 对象不含 defaultPolicy 字段——在该重建路径把 defaultPolicy 从旧 terminal 带上，防未来复用丢字段。',
  '',
  '## 测试（只增不减）',
  '1. isAttachSending：terminal=null → false（新用例）；terminal={attached:true} → true（回归）；terminal={attached:false} → false（回归）。',
  '2. ChatPage 侧（扩展 ChatPage.attachDefault.test.tsx 或新文件）：pin=attach 且 attachAvailability false（claude 无 terminal）→ 打开后实际发送走 parallel（或 attachMode state 为 parallel），且 localStorage pin 仍为 attach。',
  '跑 cd web && npm test 全绿（上轮 917 基础上只增不减）。',
].join('\n')

const smokePrompt = COMMON + [
  '',
  '任务：pack 冒烟断言面补强（你独占 scripts/pack-smoke.mjs 一个文件）。',
  '',
  '上一轮审查发现 scripts/pack-smoke.mjs 的 REQUIRED_FILES 仅 8 项、REQUIRED_DEPS 仅 @fastify/compress——files 白名单回归（config 模板 / kpi-sources / cli/lib）与其余运行时依赖漏检，CI 挡不住。',
  '修法：',
  '1. REQUIRED_FILES 追加运行时必需文件（对照引用核实后写入）：',
  '   - config/hub.config.example.json（cli/lib/paths.js defaultConfigTemplatePath + cli/lib/config.js ensureConfig 模板）',
  '   - config/kpi-sources.json（server/src/kpi.ts 引用）',
  '   - cli/lib/ 目录全部运行时 js（以实际目录为准全部列入：paths/config/process/color/args/entry/extensions/net 等）',
  '2. REQUIRED_DEPS 补全 server/dist 的运行时依赖：@earendil-works/pi-coding-agent、@fastify/compress、@fastify/cors、@fastify/static、fastify、ws（对照 server/src 非 node: 内置 import）。',
  '3. 保持现有失败输出风格（缺失清单 + exit 1）与成功输出（统计行）。',
  '4. 自检：node scripts/pack-smoke.mjs 当前应 exit 0（上一轮修复后 files/deps 已齐）；再人为验证一次失败路径（临时注释一项跑一次确认报缺后还原）。',
  '无测试挂载点（scripts/ 无测试框架），不新增测试文件；用 node --check 自检语法。',
].join('\n')

phase('Fix')
const results = await parallel([
  () => agent(wsSecurityPrompt, { label: 'fix:ws-security', phase: 'Fix', schema: FIX_SCHEMA, effort: 'xhigh' }),
  () => agent(contractPrompt, { label: 'fix:contract', phase: 'Fix', schema: FIX_SCHEMA, effort: 'high' }),
  () => agent(webPrompt, { label: 'fix:web-selfheal', phase: 'Fix', schema: FIX_SCHEMA, effort: 'high' }),
  () => agent(smokePrompt, { label: 'fix:pack-smoke', phase: 'Fix', schema: FIX_SCHEMA, effort: 'medium' }),
])
const fixes = results.filter(Boolean)
log('修复完成 ' + fixes.length + '/4')

phase('VerifyTests')
const testReport = await agent(COMMON + [
  '',
  '任务：全量验证（只跑命令与报告，**不修任何问题**）。依次执行：',
  '1. cd ' + REPO + ' && pnpm install',
  '2. pnpm -r build',
  '3. pnpm -r lint',
  '4. pnpm -r test',
  '5. node scripts/pack-smoke.mjs（应 exit 0）',
  '6. pnpm audit --prod（记录剩余告警；已知：包名 cli 的 GHSA-6cpc-mj5c-m9rq 疑似 workspace importer 撞名误报，如实记录即可）',
  '记录各包测试总数（server/web/cli/pi-command/pi-live-feed 的 passed 数）。',
  '**另做一件事**（供 CHANGELOG 数字校正）：静态统计本轮 WIP+修复的「新增测试」规模——对 git status 中新增（untracked）测试文件与 git diff 中新增的 it( 行计数：',
  '  server: server/src/test/ 下 untracked 测试文件（ws-auth-wiring/claude-driver/claude-host-protocol/claude-mirror/attach-claude-route 等）的 it() 静态总数，以及 tracked 测试文件里本批 diff 新增的 it() 数',
  '  web: web/src/api/attach.test.ts、ChatPage.attachDefault.test.tsx、HostRequestCard.test.tsx、ConversationNav.test.tsx、navTicks.test.ts 的 it() 数',
  '输出静态计数与口径说明。任何失败收集完整错误摘要，不修复。',
].join('\n'), { label: 'verify:full-suite', phase: 'VerifyTests', schema: TEST_SCHEMA, effort: 'high' })

log('测试：' + (testReport && testReport.allGreen ? '全绿' : '有失败') + '，总数 ' + (testReport ? testReport.counts.total : '?'))

phase('Docs')
const docsPrompt = COMMON + [
  '',
  '任务：文档收尾（只改 docs/API_CONTRACT.md 与 CHANGELOG.md 两个文件）。',
  '',
  '## 1. API_CONTRACT 三处修正（对照代码核实后改）',
  'a) uploads 空名回退失实（约 :1054）：写的「空名回退 misc」，实现 server/src/uploads.ts:126 sanitizeUploadName 空名返回 "upload.bin"（misc 是 sessionId 清洗兜底，无关）。改为「空名回退 upload.bin」。',
  'b) uploads 请求体/校验描述失实（约 :1031 与 :1059-1060）：写「无 sessionId 时 cwd 必填/否则 400」，实际 routes.ts:981-1002 与 uploads.ts:288-291 在 sessionId 与 cwd 双缺省时落临时目录 201 不报 400。改为条件式表述：「带 cwd 时必须是绝对路径且落在 workspaceRoot 或已知会话 cwd 内（否则 400 INVALID_CWD）；sessionId 与 cwd 均缺省则兜底临时目录 <tmpdir>/agent-hub-uploads/」。',
  'c) host-requests 409 条目（约 :836）：本轮已修代码满足契约（已决 id 短期记忆 → 409 HOST_REQUEST_RESOLVED，未知 → 404），核实代码后确认文档表述与实现一致即可，无需改；若实现细节（TTL 约 5 分钟/上限约 200）值得注明可补一句。',
  '',
  '## 2. CHANGELOG 数字校正（v0.3.0 节「测试」小节）',
  '实跑数字：' + (testReport ? JSON.stringify(testReport.counts) : '（缺失，用全绿表述）'),
  '静态新增计数：' + (testReport ? JSON.stringify(testReport.newTestCounts) : '（缺失）'),
  '审查发现上一稿失实：「服务端 +34/+10」装不下实际类别（host-protocol 14 + driver 20 + attach-claude 13~15 + mirror 4 + ws-auth-wiring 3 + adapter 3 + config 3 等），前端「+17」实计约 19。按实跑总数与静态计数重写该小节：各批新增数用静态 it() 口径（写明口径），总数用实跑 passed 数，server/web/cli/pi 扩展分列。若 server 本轮已全绿（看实跑 counts），把上一稿「server 被 tsc 阻断如实标注」的说法改掉。',
  '另外「修复批」小节补第二轮：@fastify/static v10 setHeaders 契约适配、WS upgrade Origin 校验（防跨站劫持）、WS abort 过应用锁门禁、host-request 已决 409 语义落地、auth 空 token 告警、web attach 残留自愈、pack 冒烟补强。',
  '写作风格对齐 CHANGELOG 现有条目式中文。',
].join('\n')
const docsResult = await agent(docsPrompt, { label: 'docs:finalize', phase: 'Docs', schema: FIX_SCHEMA, effort: 'high' })

phase('Review')
const reviewers = await parallel([
  () => agent(COMMON + [
    '',
    '你是对抗审查者（安全复审），攻击本轮新修复的 WS 安全面，读 server/src/ws.ts、server/src/index.ts（attachSessionWs 与 CORS 闸）、server/src/config.ts：',
    '1. 新增的 Origin 校验是否可绕过？（大小写/多 Origin/带端口的 Origin/Origin: null/空串/x-forwarded 场景；非浏览器「无 Origin」放行路径能否被浏览器伪造？浏览器是否可能不发 Origin？）',
    '2. abort 门禁补齐后：prompt/abort 之外的 WS 消息类型还有没有未过闸的指令面？（枚举 handleClientMessage 全部 case）',
    '3. Origin 校验是否误伤合法场景（PWA 从 ts.net 域名打开 → wss 同源？http→https 混合？本地 127.0.0.1 面板？）——对照 isSameOrigin/isAllowedCrossOrigin 实现判断。',
    '4. /terminal/ws 通道确认未被误杀。',
    '只报真实可利用/真实回归问题；没有就 refuted=false 空 findings。',
  ].join('\n'), { label: 're-review:security', phase: 'Review', schema: VERDICT, effort: 'xhigh' }),

  () => agent(COMMON + [
    '',
    '你是对抗审查者（一致性复审），核实本轮修复与文档的最终一致性：',
    '1. host-request 409：代码（claude-driver.ts 已决记忆 + routes.ts 分支）与 API_CONTRACT 表述逐条一致？TTL/上限行为在应答过期后是否回到 404（契约是否需要注明）？',
    '2. CHANGELOG 测试数字（对照 git 统计与 ' + (testReport ? JSON.stringify(testReport.counts) : '实跑数字') + '）是否还有失实？',
    '3. web 自愈改动：isAttachSending(null terminal)=false 是否破坏 pi 正常 attach 流（pi terminal 总是非 null？对照 agents.statusFor 与 stampTerminal）；pinned=attach 回落 parallel 是否真的不改写 pin。',
    '4. pack-smoke 断言清单与 files 白名单当前状态互相自洽（都过 = 无假绿）。',
    '发现失实给 文件:行号 + 修正建议；全部一致就 refuted=false 空 findings。',
  ].join('\n'), { label: 're-review:consistency', phase: 'Review', schema: VERDICT, effort: 'high' }),
])

const allFindings = reviewers.filter(Boolean).flatMap(r => r.findings)
log('复审：' + allFindings.length + ' 条发现')

return {
  fixes: fixes.map(f => ({ summary: f.summary, testsAdded: f.testsAdded, testsTotal: f.testsTotal, notes: f.notes })),
  testReport,
  docs: docsResult ? { summary: docsResult.summary, notes: docsResult.notes } : null,
  reviewFindings: allFindings,
}
