# npm Beta 发布前验收（2026-10-22）

版本：0.3.0-beta.1；包名最终以发布账号实际拥有的全小写 scope 为准。当前记录不表示 registry 已发布成功，发布状态须另行检查 npm 元数据。

## 已验证

- Node 22.20 本机安装、编译、类型检查与单元/组件/实验台测试；完整测试与新增 CLI 回归（以 CI 结果为准）；CLI 新增缺少全局 pi、运行目录独立于包目录、旧 Node 拦截和首次 HTTPS 授权提示回归。
- 真实 tarball 在两个隔离 npm prefix 安装，不继承个人配置或凭据；不依赖 Git/pnpm/全局 pi，不在包目录再次安装或构建。
- 用户目录配置、静态入口、PWA manifest、HTTP、WS 与应用锁；换全新安装目录后原配置和应用锁仍在。
- 首次 Serve 授权链接只出现在 stdout 或等待超时时能给出本人操作引导；dry-run 不配置真实 Serve。
- 真实浏览器打开 npm 安装的产物：应用锁可解锁；刷新保留解锁；service worker active；320/360/390/430/768/1024 六档无横向溢出，另验深色与减少动效。
- 打包清单采用正向白名单并检查入口的相对 import 闭包；排除测试、sourcemap、用户配置、data、旧取证与原图备份。文本历史的模式扫描不能代替所有截图的人工审查。

截图：[320](installed-320.png) · [360](installed-360.png) · [390](installed-390.png) · [430](installed-430.png) · [768](installed-768.png) · [1024](installed-1024.png) · [深色/减少动效](installed-dark-reduced-390.png)。均来自无私人会话的测试 HOME。

## 复测

先构建，再运行 `node scripts/pack-smoke.mjs`、`node scripts/install-smoke.mjs --output /path/to/report.json`。后者真实安装 npm tarball、启动自有端口并验证，再回收进程与临时目录。使用 `--tarball` 可指定已准备发布的完全相同文件；`--keep` 仅供进一步浏览器验收保留自有环境。

## 范围限制

Tailscale 使用受控 CLI 验证参数与首次授权处理，不修改维护者真实 Serve，不能视作手机/另一台电脑已验收；未调用模型。Windows 原生、跨设备访问和真实模型任务仍需使用者试用。Codex 真实审批闭环仍待分别验证。

用户下一步见 [新电脑安装指南](../../INSTALL.md)。先完成 npm 试用发布和跨设备验收；Git 仓库仍保持 private，旧历史与截图的公开范围应单独确认。
