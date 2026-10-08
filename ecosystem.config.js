// pm2 部署配置 / pm2 deployment config
// 用法 / Usage:
//   pnpm build && pm2 start ecosystem.config.js
//   pm2 save && pm2 startup        # 开机自启 / resurrect on boot
// 本机常驻推荐 setup --autostart（launchd / systemd / 任务计划），服务器用 pm2。
module.exports = {
  apps: [
    {
      name: 'agent-hub',
      script: 'server/dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
