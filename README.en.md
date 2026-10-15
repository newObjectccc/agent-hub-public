# Agent Hub

English | [简体中文](README.md)

![CI](https://github.com/newObjectccc/agent-hub/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/license-MIT-blue) ![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![PWA](https://img.shields.io/badge/PWA-ready-orange)

> Your phone is a remote control **and** a standalone workstation for your computer — a **self-hosted**, cross-platform (macOS / Linux / Windows) **session hub for pi / Claude Code / Codex**. Your data never leaves your machine.

Open the PWA panel in any device's browser → see every agent session and its working status at a glance → tap into the chat view to continue conversations, dispatch tasks, and spectate live. Sessions are fully interoperable with the terminal CLI — session files are the single source of truth (pi `~/.pi/agent/sessions/`, Claude Code `~/.claude/projects/`, Codex `~/.codex/sessions/`).

## Screenshots

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="Agent Hub demo: workbench → dual-mode drive → chat → multi-subagent panel" width="330">
</p>

| 🗂 Workbench | 💬 Chat workspace |
|---|---|
| ![Workbench: today's overview and active sessions](docs/screenshots/workbench.png) | ![Chat workspace: thinking process and tool calls](docs/screenshots/chat.png) |
| **🤖 Multi-subagent panel** | **📱 Dual-mode drive / 🔐 App lock** |
| ![Multi-subagent panel: live tools and runtimes](docs/screenshots/subagent-panel.png) | <img src="docs/screenshots/feature-dual-mode.png" alt="Dual-mode session drive picker" width="160"> <img src="docs/screenshots/feature-lock.png" alt="App lock: PIN / WebAuthn unlock" width="160"> |

## Features

- **🧩 Three session sources**: pi / Claude Code / Codex in one list, detail view, and drive channel (Codex includes desktop-app sessions: tool cards / usage accounting / archived sessions 📦)
- **📱 Dual-mode session drive**: 🖥 Takeover (pi: inject messages into the existing terminal process; Claude: the hub starts a persistent CLI process resuming the same session, with tmux mirroring and phone-side permission approval) / 📱 Parallel continue (resume context through the server). Both modes support pi and Claude; Codex currently supports parallel only. Defaults are configurable, and your manual choice takes priority. See the mode guide below.
- **🤖 Sub-agent activity panel**: sub-agents from pi **and claude** shown live (current tool / output summary / runtime), like a terminal multi-agent panel
- 🔴 **Live spectating**: watch the thinking chain, streaming replies, and tool calls of terminal pi sessions from your phone (token-level)
- 🗂 **Workbench home**: organized by attention (🔥 working / ⚠️ needs you / today's overview), real data only; today's overview broken down by source (pi/claude/codex), with per-source filter chips
- 📈 **Token usage**: today / 7-day / all-time token & cost rollups, per-session usage badges
- 💬 **Chat workspace**: staged waiting feedback, slash commands, quick-prompt templates, @ file references, image uploads, quoted replies, code highlighting & copy, GFM tables, voice input, draft auto-restore
- 📊 **Session management**: priority ordering, sub-agent parent–child tree, global search, branch tree, session forking, session renaming, source filtering (pi/claude/codex)
- 🌿 **Git integration**: repo status, diff viewer, tool-call ↔ file linking (read-only, safe)
- ⚡ **Performance**: WS batching, message memoization, windowed long sessions (12–15× streaming render, 21× DOM slim-down); server-side brotli compression + long-lived cache for hashed assets (weak-network / remote friendly)
- 🔔 **Notification center**: session-completion banners / vibration / sound, unread aggregation, tap-to-read
- 🔐 **App lock + offline queue**: PIN / WebAuthn passkey unlock, queued messages auto-resend when back online
- 🖥 **Web terminal** (ttyd optional): a real terminal right inside the panel
- 🌐 **Bilingual UI (i18n)**: switch the interface language between follow-system / 中文 / English in one tap, persisted

## Resuming old sessions and choosing a mode

Completed sessions can continue: sending from your phone starts a new turn from saved context even after the original computer terminal has closed. Opening a session does not resend old tasks, and a session title does not indicate its current run status. The computer's hub service and the relevant agent runtime must be available. Closing the PWA does not stop accepted work; restarting the hub does not automatically resume execution or takeover.

| Claude scenario | Sending behavior |
|---|---|
| Parallel, idle | The hub starts a CLI run; the original terminal can stay closed |
| Parallel, a hub-owned run is busy | Normal send returns busy; both steer and follow-up queue until that run ends |
| Parallel, an external terminal is busy | All three modes return busy; parallel mode cannot queue into that terminal |
| Takeover | The hub owns a new persistent CLI process; steer is handled between tools, follow-up after the turn; a normal send while busy fails through the command acknowledgment |

Claude takeover does not control the original TUI window. Avoid simultaneous input there during takeover; tmux mirrors the hub process. External activity detection uses file timestamps, and its quiet window is not a process lock.

With the default `active-only` policy, pi defaults to takeover when its terminal extension is online. Claude attempts takeover when `status=running` **or** `lastDrivenBy=terminal`; otherwise it defaults to parallel. `always` attempts takeover on every open; `never` requires a manual choice. Manual choices take priority, while quiet-window checks, the enabled switch, and concurrency limits still apply.

One completed assistant message can be followed by more tools. The page confirms completion through turn-end events and server status; after five seconds of silence it checks status rather than marking the task complete.

Uploaded images appear as thumbnails. Claude's image dimensions/coordinate hints are internal metadata and are hidden from the conversation. Older `@.agent-hub-uploads/...` messages can regain previews when a matching successful image-read result is saved; a path alone does not guarantee a preview after refresh. See the [API contract](docs/API_CONTRACT.md) and [Claude driver guide](docs/CLAUDE_DRIVER.md) for details.

## Quick Start

Option 1: npm package (npx / global install) — or just git clone (see Option 2):

```bash
npx agent-hub remote        # one-command remote: setup → start bundled build + Tailscale
# or install for the full subcommands (dev / setup / start / remote / check / open; doctor is an alias of check)
npm install -g agent-hub
agent-hub setup             # detect environment, generate config
agent-hub remote            # = setup when needed + start --tailscale; safe to repeat
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
                     terminal layer          session files (single source of truth)
                  (tmux/ttyd/Tailscale)      (pi ~/.pi/agent/sessions,
                                             claude ~/.claude/projects,
                                             codex ~/.codex/sessions)
```

| Directory | Description |
|---|---|
| `server/` | REST + WS, pi/claude/codex adapters, KPI / notifications / git / terminal integration |
| `web/` | PWA (React + Vite + Tailwind v4, brutalist compact UI) |
| `cli/` | Cross-platform dev/setup/start/remote/check/open (pure Node, zero bash dependency) |
| `integrations/` | pi extensions (live-feed streaming / pi-command reverse control), Claude permission MCP bridge |
| `docs/` | API contract, architecture, platform details, headscale guide (HEADSCALE.md), roadmap |
| `docs/headscale/` | Self-hosted headscale control-plane deployment files (docker compose + Caddy auto-HTTPS) |

## Documentation Map

| Document | Contents |
|---|---|
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | REST / WS API contract (for integrations) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture & data flow (session files as the single source of truth) |
| [docs/CLAUDE_DRIVER.md](docs/CLAUDE_DRIVER.md) | Claude takeover, permissions, sending modes, and limitations |
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
pnpm build && pnpm lint && pnpm test   # full verification (1500+ tests, GitHub Actions CI-guarded)
```

Note: the dev entry is Vite (default `http://localhost:5173`) with `/api` and `/ws` proxied to the server (default 7700) — not 7700 directly.

If this checkout serves your phone, run build verification in a separate worktree so it cannot rewrite the live `web/dist`. Use one coordinated process for production builds and restarts; see the contribution guide.

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

> 💡 Crash recovery: newly generated launchd configurations default to `KeepAlive=true` and restart the process after it exits. To update an older configuration, unload it as above, then re-run `npm run setup -- --autostart` so launchd reads the new settings. Use unload for an intentional stop too. Restarting preserves history but does not automatically resume tasks.

On a server (pm2, self-healing + start on boot):

```bash
pnpm build
pm2 start ecosystem.config.js
pm2 save && pm2 startup        # start on boot
```

## Configuration

- `config/hub.config.json`: ports / directories / auth (generated by setup). Fields and defaults:

| Field | Default | Description |
|---|---|---|
| `port` | `7700` | Panel port |
| `host` | `127.0.0.1` | Bind address (wildcard binding is rejected; see Security Notes) |
| `sessionDir` | `~/.pi/agent/sessions` | pi session directory (`~` supported, same below) |
| `workspaceRoot` | `~/Workspace` | Workspace root (git stats on the overview / constraint root for uploads and new-session cwd) |
| `kpiRefreshMinutes` | `5` | Metric-card background refresh interval (minutes) |
| `auth` | `{"enabled": false, "token": ""}` | API / WS auth (see Security Notes) |
| `allowOrigins` | `[]` | CORS allowlist (exact origins, e.g. `https://app.example.com`; empty array = deny all cross-origin) |
| `allowLan` | `false` | Explicit LAN exposure opt-in (allows wildcard `host`; `start --lan` writes it automatically) |
| `claudeDriver.enabled` | `true` | Master switch for claude takeover (hub-driven): when off no driver is constructed, takeover routes return 400, the UI falls back to parallel |
| `claudeDriver.defaultPolicy` | `"active-only"` | Claude attempts takeover when running or last driven by the terminal; `always`=attempt on open / `never`=manual only. Pi also requires its extension online; manual choices take priority |
| `claudeDriver.idleDetachMs` | `1800000` | Auto-detach after idle (ms, 30 min; `0`=never, never detaches mid-turn) |
| `claudeDriver.maxConcurrent` | `3` | Max concurrent hub drivers, including pending startups (excess → 409 DRIVER_LIMIT) |
| `claudeDriver.mirror` | `"tmux"` | Terminal mirroring (named tmux session, watch via `tmux attach`; auto-degrades to `off` without tmux) |
| `claudeDriver.externalQuietMs` | `3000` | File quiet window checked before preparation and immediately before process startup; recent external writes return 409. This does not provide a process lock |

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
- **The app lock (PIN / WebAuthn)** protects the UI and validates unlock tokens for business HTTP requests and WS send/abort operations. It does not replace the API token; both layers can be enabled together
- `host` defaults to `127.0.0.1` and wildcard binding is rejected; LAN exposure requires explicit `"allowLan": true` (or `agent-hub start --lan` / `npm run start -- --lan`, which writes `allowLan` automatically)
- Found a security issue? **Do not open a public issue** — contact the maintainer privately via the repo's About page

## License

[MIT](LICENSE) © 2026 newObjectccc
