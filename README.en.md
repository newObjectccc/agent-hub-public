# Agent Hub

English | [简体中文](README.md)

![CI](https://github.com/newObjectccc/agent-hub/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/license-MIT-blue) ![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![PWA](https://img.shields.io/badge/PWA-ready-orange)

> Your phone is a remote control **and** a standalone workstation for your computer. A cross-platform (macOS / Linux / Windows) **session hub for pi / Claude Code / Codex**.

Open the PWA panel in any device's browser → see every agent session and its working status at a glance → tap into the chat view to continue conversations, dispatch tasks, and spectate live. Sessions are fully interoperable with the terminal CLI (the same `~/.pi/agent/sessions/`).

## Screenshots

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="Agent Hub demo: workbench → dual-mode drive → chat → multi-subagent panel" width="330">
</p>

| 🗂 Workbench | 💬 Chat workspace |
|---|---|
| ![Workbench: today's overview and active sessions](docs/screenshots/workbench.png) | ![Chat workspace: thinking process and tool calls](docs/screenshots/chat.png) |
| **🤖 Multi-subagent panel** | **📱 Dual-mode drive / 🔐 App lock** |
| ![Multi-subagent panel: live tools and runtimes](docs/screenshots/subagent-panel.png) | ![Dual-mode session drive picker](docs/screenshots/feature-dual-mode.png) |

## Features

- **📱 Dual-mode session drive**: 🖥 Take over the terminal (messages are injected into the terminal pi process, shown live on screen) / 📱 Parallel continue (a separate worker line sharing the same context) — your call
- **🤖 Sub-agent activity panel**: sub-agents from pi **and claude** shown live (current tool / output summary / runtime), like a terminal multi-agent panel
- 🔴 **Live spectating**: watch the thinking chain, streaming replies, and tool calls of terminal pi sessions from your phone (token-level)
- 🗂 **Workbench home**: organized by attention (🔥 working / ⚠️ needs you / today's overview), real data only
- 📈 **Token usage**: today / 7-day / all-time token & cost rollups, per-session usage badges
- 💬 **Chat workspace**: staged waiting feedback, slash commands, quick-prompt templates, @ file references, image uploads, quoted replies, code highlighting & copy
- 📊 **Session management**: priority ordering, sub-agent parent–child tree, global search, branch tree, session forking
- 🌿 **Git integration**: repo status, diff viewer, tool-call ↔ file linking (read-only, safe)
- ⚡ **Performance**: WS batching, message memoization, windowed long sessions (12–15× streaming render, 21× DOM slim-down); server-side brotli compression + long-lived cache for hashed assets (weak-network / remote friendly)
- 🔔 **Notification center**: session-completion banners / vibration / sound, unread aggregation, tap-to-read
- 🔐 **App lock + offline queue**: PIN / WebAuthn passkey unlock, queued messages auto-resend when back online
- 🖥 **Web terminal** (ttyd optional): a real terminal right inside the panel

## Quick Start

Option 1: npm package (npx / global install) — or just git clone (see Option 2):

```bash
npx agent-hub remote        # one-command remote: auto setup → build → start + Tailscale
# or install for the full subcommands (dev / setup / start / remote / check / open)
npm install -g agent-hub
agent-hub setup             # detect environment, generate config
agent-hub remote            # = start --tailscale, idempotent
```

Option 2: git clone (repo development / self-hosted from source):

```bash
git clone https://github.com/newObjectccc/agent-hub.git
cd agent-hub
npm run dev          # one-command dev: server hot reload + web Vite HMR (frontend at http://localhost:5173)
npm run start        # production start: install deps → build → serve, defaults to http://127.0.0.1:7700
npm run remote       # one-command remote: auto setup + build + start --tailscale (idempotent)
```

> ⚠️ With pnpm, **do not run `pnpm setup`** — that is pnpm's built-in command (for configuring the pnpm shell env) and will NOT run this project's setup. Use `npm run setup` or `node cli/setup.js` instead. Also, `dev` / `start` auto-generate a default config when missing; setup is only for environment checks, pi extension install, and autostart registration.

See [docs/PLATFORM.md](docs/PLATFORM.md) for per-platform installation details.

## Standard Integration Path: remote-control pi from your phone (battle-tested)

> This is the recommended default integration, verified end-to-end on real devices (macOS + Android): **install Tailscale → one command → install the real PWA (no address bar) → dispatch tasks to the pi on your computer from anywhere**.

### Steps (~10 minutes)

1. **Install [Tailscale](https://tailscale.com/download) on both computer and phone, log in with the same account**
   The free Personal plan (3 users / 100 devices) is enough. Find Tailscale in your phone's app store, log in, and turn the connection on.
2. **Enable HTTPS certificates**: [Tailscale Admin Console](https://login.tailscale.com/admin) → HTTPS Certificates → Enable (one-time; used to issue the panel's domain certificate).
3. **One command on the computer**:

```bash
npm run remote        # = setup + build + start --tailscale, idempotent
# equivalent: node cli/start.js --tailscale; use --lan for LAN-only
```

   Successful output looks like:

```
Tailscale Serve enabled (HTTPS): https://<node>.<tailnet>.ts.net
Open it on your phone's browser → menu → "Install app" = a real PWA without an address bar (WebAPK).
```

4. **Install the PWA on your phone**: open the printed `https://…` URL in Chrome → menu → **"Install app"** (NOT "Add to Home screen") → verify: no address bar, standalone window, its own task entry
5. From then on, when your computer isn't around: open the PWA on your phone → workbench → dispatch tasks / spectate live / continue chats

### ⚠️ Latency warning: verify P2P direct connection first (must-read for latency-sensitive users)

The phone-remote experience **depends entirely on whether traffic goes P2P direct or through a DERP relay**:

| Path | Latency | Experience |
|---|---|---|
| ✅ P2P direct (IPv6 / successful UDP hole punching) | < 50ms | instant, smooth streaming |
| ❌ DERP relay (fallback when hole punching fails) | 300ms+ | noticeably sluggish — dozens of API/WS round-trips on first paint, latency compounds |

Run this one command right after deployment (see the "Remote latency" section of the output):

```bash
agent-hub check              # equivalent: tailscale netcheck
```

Three key metrics and expected values:

| Metric | Healthy | If unhealthy |
|---|---|---|
| `IPv6` | `yes` | `no` → enable IPv6 on your router + allow inbound UDP 41641 (**best option: no NAT with v6, direct without hole punching**) |
| `MappingVariesByDestIP` | `false` | `true` = symmetric NAT, hard to punch → enable UPnP; common on cellular, switch to Wi-Fi or use the carrier's IPv6 |
| `PortMapping` | `UPnP` / `NAT-PMP` | empty → enable UPnP on the router, or manually port-forward UDP 41641 to the computer |

Also check `Nearest DERP`: healthy is Hong Kong/Tokyo (30-50ms); an overseas node at 200ms+ (international routing detour) means it will be very slow whenever hole punching fails — get the direct-connection conditions above right; as a last resort self-host a DERP in your country/region.

Verify the direct connection (run on the computer while the phone is connected):

```bash
tailscale ping <phone's Tailscale IP>    # seeing direct (UDPv6) = P2P is up
```

> 💡 On the same Wi-Fi you don't need Tailscale at all: `npm run start -- --lan` connects directly over the LAN — always fastest.

### Known issues (from real-world testing)

| Symptom | Fix |
|---|---|
| macOS `serve` fails with `GUI failed to start` / `CLIError error 3` | The GUI bridge is broken; root talks to the daemon directly: `sudo tailscale serve --bg --https=443 http://127.0.0.1:7700` (verified working; the CLI also suggests this command when diagnosis fails) |
| The installed PWA shows an address bar / is just a shortcut | You installed from an HTTP origin (e.g. self-hosted headscale); Chrome only creates a home-screen shortcut there. Reinstall from an HTTPS origin |
| `serve` reports a certificate error | HTTPS Certificates is not enabled in the Admin Console (see step 2) |
| The phone times out opening the URL | Phone's Tailscale is disconnected, or the two devices are logged into different accounts |
| The phone opens it but it's very slow | Traffic is probably going through a DERP relay (hole punching failed): run `agent-hub check` and follow the "⚠️ Latency warning" above |

> 💡 PWA fact: only an **HTTPS origin** can be installed as a real WebAPK (standalone window without an address bar) — this is unrelated to manifest configuration. Tailscale serve's automatic certificates exist precisely for this.

**Alternatives**: self-hosted headscale control plane in [docs/HEADSCALE.md](docs/HEADSCALE.md) (tailnet-internal HTTP, degraded PWA); LAN-only via `--lan`. See [docs/PLATFORM.md](docs/PLATFORM.md) for platform details.

## Architecture

```
Mobile PWA ──HTTP/WS──▶ server (Fastify) ──▶ pi SDK / claude CLI / codex CLI
                          │                    │
                     terminal layer         ~/.pi/agent/sessions
                  (tmux/ttyd/Tailscale)    (single source of truth)
```

| Directory | Description |
|---|---|
| `server/` | REST + WS, pi/claude/codex adapters, KPI / notifications / git / terminal integration |
| `web/` | PWA (React + Vite + Tailwind v4, brutalist compact UI) |
| `cli/` | Cross-platform dev/setup/start/check/open (pure Node, zero bash dependency) |
| `integrations/` | pi extensions (live-feed streaming / pi-command reverse control) |
| `docs/` | API contract, architecture, platform details, headscale guide (HEADSCALE.md), roadmap |
| `docs/headscale/` | Self-hosted headscale control-plane deployment files (docker compose + Caddy auto-HTTPS) |

## Documentation Map

| Document | Contents |
|---|---|
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | REST / WS API contract (for integrations) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture & data flow (session files as the single source of truth) |
| [docs/PLATFORM.md](docs/PLATFORM.md) | Platform-specific setup (macOS / Linux / Windows) |
| [docs/HEADSCALE.md](docs/HEADSCALE.md) | Self-hosted headscale control plane (no official Tailscale required) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Roadmap |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution workflow & conventions |

## Development

```bash
pnpm install
pnpm dev                           # one-command dev (recommended)
#   server:tsc  tsc --watch incremental build
#   server      node --watch hot restart (backend edits apply automatically)
#   web         Vite HMR (frontend edits apply instantly)
pnpm build && pnpm lint && pnpm test   # full verification (1200+ tests, GitHub Actions CI-guarded)
```

Note: the dev entry is Vite (default `http://localhost:5173`) with `/api` and `/ws` proxied to the server (default 7700) — not 7700 directly.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [CHANGELOG.md](CHANGELOG.md) for release history.

## Deployment

Always-on on your own machine (platform-native autostart recommended):

```bash
npm run setup -- --autostart   # macOS launchd / Linux systemd / Windows Task Scheduler
npm run start                  # foreground production start (build + serve; config auto-generated if missing)
```

Once registered it starts on boot with no manual steps. When tailscale is detected the autostart command automatically carries `--tailscale` (Tailscale Serve is re-provisioned idempotently on every boot, so the phone remote channel is always ready; override with `setup -- --autostart --lan` for LAN-only). Day-to-day operations:

| Task | macOS (launchd) | Linux (systemd --user) |
|---|---|---|
| Stop | `launchctl unload ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user stop agent-hub` |
| Start | `launchctl load ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user start agent-hub` |
| Logs | `~/Library/Logs/agent-hub.log` | `journalctl --user -u agent-hub` |

> 💡 Crash recovery: launchd defaults to `KeepAlive=false` (restarts on next boot only); set `KeepAlive` to `true` in the plist for automatic restart after a crash. On servers just use pm2 below (self-healing built in).

On a server (pm2, self-healing + start on boot):

```bash
pnpm build
pm2 start ecosystem.config.js
pm2 save && pm2 startup        # start on boot
```

## Configuration

- `config/hub.config.json`: ports / directories (generated by setup)
- `config/kpi-sources.json`: optional metric-card data sources (`${ENV_VAR}` for secrets)

## Security Notes (read before deploying)

This project ships with **zero authentication by default** — the trust boundary is your private network:

| Deployment | Safe | What to do |
|---|---|---|
| Local `127.0.0.1` (default) | ✅ | nothing |
| Tailscale / headscale / private LAN | ✅ | nothing (recommended) |
| Public VPS / exposed public IP | ❌ | **must** enable `auth.token` (below), otherwise anyone who reaches the port can drive the pi/Claude agents on your machine |

- **Enable API auth**: set `"auth": { "enabled": true, "token": "<long random string>" }` in `config/hub.config.json` — all APIs and WS then require `Authorization: Bearer <token>`
- `auth.enabled` defaults to `false` on purpose (frictionless tailnet experience); turn it on before exposing to the internet
- **The app lock (PIN / WebAuthn) is a UI lock** against physical access to your phone/computer — it is not network auth; the two layers are independent
- `host` defaults to `127.0.0.1` and wildcard binding is rejected; LAN exposure requires explicit `"allowLan": true` (or `start -- --lan`)
- Found a security issue? **Do not open a public issue** — contact the maintainer privately via the repo's About page

## License

[MIT](LICENSE) © 2026 newObjectccc
