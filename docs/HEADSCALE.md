# 自建 headscale 控制面（可选进阶）

> 默认推荐**官方 Tailscale 免费版**（个人 3 用户 / 100 设备，零运维，`agent-hub remote` 全自动）。
> 自建 headscale 适合：想完全自控数据面、官方控制面在你网络环境不可达、或需要给团队共享。
> 部署完成后，agent-hub 的 `--tailscale` 模式会**自动识别**自建控制面并切换到对应模式，无需额外配置。

## 两种模式的差异（先读这段）

| | 官方 Tailscale | 自建 headscale |
|---|---|---|
| 控制面 | Tailscale SaaS（免费额度够用） | 你的服务器（本文档） |
| `tailscale serve` HTTPS 自动证书 | ✅ 支持 | ❌ **不支持**（`tailscale cert` 依赖官方签发） |
| agent-hub 远程访问形态 | `https://<node>.<tailnet>` | `http://<node>.<tailnet>:8080`（tailnet 内） |
| 手机 PWA 安装质量 | 真 WebAPK（无地址栏） | 简化快捷方式（浏览器标签页） |
| 功能（chat / 派任务 / 旁观） | 完整 | 完整（HTTP 仅指浏览器视角，WireGuard 传输层仍加密） |

> 💡 如果你只是想要真 PWA + 远程操作 pi，官方免费版就够了；自建是进阶选项。

## 1. 服务器端部署（任意 VPS，以香港服务器为例）

准备：一台有公网 IP 的服务器 + 一个域名（如 `headscale.example.com`）+ DNS A 记录指向该 IP。

```bash
# 1) 拿到部署文件（本文档同目录 docs/headscale/）
scp -r docs/headscale/ user@your-vps:~/headscale/
ssh user@your-vps && cd ~/headscale

# 2) 生成配置（用官方工具生成，避免手写字段随版本漂移）
docker run --rm -v ./config.yaml:/etc/headscale/config.yaml \
  headscale/headscale:0.26 generate config > config.yaml

# 3) 修改 config.yaml 两处（其余默认即可）：
#    server_url: https://headscale.example.com   ← 换成你的域名
#    dns.base_domain: tail.example.com           ← 换成你喜欢的内部后缀

# 4) 修改 Caddyfile：headscale.example.com → 你的域名

# 5) 启动
docker compose up -d

# 6) 验证
curl https://headscale.example.com/health        # 应返回 {}
```

防火墙放行：**TCP 80 / 443**（控制面）。WireGuard 数据面是设备间直连（UDP 打洞），不通时走公共 DERP 中继，无需额外开端口。

## 2. 创建用户与登录密钥

```bash
docker exec headscale headscale users create peter
docker exec headscale headscale preauthkeys create --user 1 --expiration 24h --reusable
# 输出的 tskey-...-xxxxxxxx 即一次性登录密钥（也可网页/手机端交互登录）
```

## 3. 设备接入（电脑 + 手机同一用户下）

CLI（macOS / Linux / Windows）：

```bash
tailscale up --login-server=https://headscale.example.com --authkey=tskey-...
```

GUI / 手机 App：先**登出**当前账号，在设置里找「自定义控制服务器 / Custom coordination server / Alternate server URL」填 `https://headscale.example.com`，再登录（手机端可直接用 authkey 或走浏览器授权）。

> ⚠️ 版本兼容：headscale 只承诺支持最近约 10 个 Tailscale 客户端版本。客户端/服务端差距过大时会报
> `unsupported capability version`，升级其一即可。

## 4. 跑起 agent-hub 远程访问

```bash
node cli/start.js --tailscale    # 或 npm run remote
```

agent-hub 会自动识别自建控制面（读 `tailscale debug prefs` 的 ControlURL），切换到 **tailnet 内 HTTP 模式**并打印：

```
Tailscale Serve 已开启（tailnet 内 HTTP）：http://<node>.<tailnet>:8080
```

手机（连着同一 tailnet）浏览器打开该地址即可操作 pi。面板功能完整；PWA 因浏览器的非安全源限制只能装成简化快捷方式（有地址栏）。

## 5. 想要真 PWA（无地址栏）怎么办

三选一：

1. **换官方 Tailscale**（推荐）：免费额度内，把设备登到官方控制面，`--tailscale` 自动走 HTTPS + 自动证书，手机装真 WebAPK。
2. **公网域名直连**：用 Caddy / Nginx + Let's Encrypt 或 Cloudflare Tunnel 把面板暴露成 `https://hub.example.com`，
   **务必在反代层加鉴权**（basic auth / OAuth2 等）。注意：`auth.token` 只服务 API/CLI 调用方，
   与自带 PWA 面板不兼容（见 README 安全须知），不能单靠它保护公网部署。
3. **进阶**：Caddy DNS-01 挑战为 MagicDNS 名签证书 + hosts 指向 100.x 地址（复杂度高，收益有限，不展开）。

## 6. 运维备忘

- **备份**：`headscale-data` 卷（SQLite + noise 私钥）；丢了等于重建 tailnet。
- **升级**：改 `docker-compose.yml` 镜像 tag → `docker compose up -d`；先看 release note 的配置字段变更。
- **排障**：
  - `untrusted certificate`：客户端到控制面的 TLS 有问题（Caddy 证书没签下来 / 时间不同步）。
  - 端口冲突：80/443 被占（已有 nginx/caddy 的话，把 `Caddyfile` 内容并入你现有的反代，去掉 caddy 服务）。
  - 客户端连不上：`tailscale status` 看 BackendState；`docker logs headscale` 看注册/密钥错误。
