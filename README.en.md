# Agent Hub

English | [简体中文](README.md)

![CI](https://github.com/newObjectccc/agent-hub/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/license-MIT-blue) ![Node.js ≥ 22.19](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![PWA](https://img.shields.io/badge/PWA-ready-orange)

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
- **📱 Dual-mode session drive**: 🖥 Takeover (pi: inject messages into the existing terminal process; Claude: the hub starts a persistent CLI process resuming the same session, with tmux mirroring and phone-side permission approval) / 📱 Parallel continue (resume context through the server; pi tool calls really execute on your computer with no human approval, stated up front on first entry). Both modes support all three sources. Codex takeover is manual by default, with native steer/interrupt, phone approval cards (real command, file-change, and permissions flows still require end-to-end validation) and images; it does not control the original desktop window. See [Codex driver](docs/CODEX_DRIVER.md). Defaults are configurable, and your manual choice takes priority. Parallel sends are blocked with an actionable reason while a computer terminal is writing the same session (anti double-write fork); model/network failures surface inline in the bubble with the original text and a self-help action. See the mode guide below.
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
| Parallel, an external terminal is busy (pi / Claude) | All three modes return busy (pi: `EXTERNAL_ACTIVE`, Claude: `SESSION_BUSY`) with an actionable reason; parallel mode cannot queue into that terminal |
| Takeover | The hub owns a new persistent CLI process; steer is handled between tools, follow-up after the turn; a normal send while busy fails through the command acknowledgment |

pi parallel continue resumes through an SDK instance inside the hub process: **tool calls (file reads/writes, shell commands) really execute on your computer with no human approval** — use it only in repos you trust. Claude parallel is pinned to `--permission-mode manual`, so tools that need confirmation are refused. Model/network failures (including out-of-credits, connection errors and context overflow) do not throw in pi; they land on the message's stopReason, and the hub surfaces them as an inline error bar: context overflow offers a one-tap "compact context" self-help, manual abort uses a neutral tone. Error notices stay until dismissed. Messages blocked by the double-write gate, or not executed by the terminal, fall back to the offline queue and keep a failed bubble with a retry entry — the text is never lost.

Claude takeover does not control the original TUI window. Avoid simultaneous input there during takeover; tmux mirrors the hub process. External activity detection uses file timestamps, and its quiet window is not a process lock.

With the default `active-only` policy, pi defaults to takeover when its terminal extension is online. Claude attempts takeover when `status=running` **or** `lastDrivenBy=terminal`; otherwise it defaults to parallel. `always` attempts takeover on every open; `never` requires a manual choice. Manual choices take priority, while quiet-window checks, the enabled switch, and concurrency limits still apply.

One completed assistant message can be followed by more tools. The page confirms completion through turn-end events and server status; after five seconds of silence it checks status rather than marking the task complete.

Uploaded images appear as thumbnails. Claude's image dimensions/coordinate hints are internal metadata and are hidden from the conversation. Older `@.agent-hub-uploads/...` messages can regain previews when a matching successful image-read result is saved; a path alone does not guarantee a preview after refresh. See the [API contract](docs/API_CONTRACT.md) and [Claude driver guide](docs/CLAUDE_DRIVER.md) for details.

## Quick Start (npm Beta)

Prepare **Node.js ≥22.19 (includes npm)** and install/sign in to **at least one of pi, Claude Code, or Codex** on the computer. The hub reuses that agent's local authentication and model configuration; you do not need all three CLIs. Keep the computer awake, online, and the hub running.

A global install is recommended for regular use and autostart. The npm package includes the frontend and backend builds: **no Git, pnpm, or on-device build is required**.

```bash
npm install -g @newobjectcccddd/agent-hub@beta --registry=https://registry.npmjs.org/
agent-hub remote
```

For a temporary trial, use `npx --registry=https://registry.npmjs.org/ @newobjectcccddd/agent-hub@beta remote`. These commands select the official npm registry for this invocation and preserve existing company registry settings. The unscoped `agent-hub` is an unrelated package; use the full scoped name. Global installs and npx share `~/.agent-hub/config/hub.config.json` and `~/.agent-hub/data/`, so changing versions or clearing the npx cache does not erase configuration, the app lock, or runtime state.

The first `remote` generates configuration, installs pi terminal extensions when applicable, and attempts to configure Tailscale Serve. It is safe to repeat. For computer-only use, run `agent-hub start` and open `http://127.0.0.1:7700`.

### Connect the computer and phone with Tailscale

1. Install [Tailscale](https://tailscale.com/download) on both devices, sign in with the same account, and connect to the same tailnet. Ensure `tailscale` is available on the computer's PATH. Custom ACLs must allow the phone to access the computer.
2. First-time Serve setup requires MagicDNS and HTTPS certificates. Follow the authorization URL printed by the CLI, or enable them on the admin console's DNS page. See the [official Serve guide](https://tailscale.com/docs/features/tailscale-serve).
3. Run `agent-hub remote` on the computer. The remote entry is ready when it reports **Tailscale Serve enabled (HTTPS)** and prints `https://<node>.<tailnet>.ts.net`.
4. Open that HTTPS URL on the phone. Use Chrome's install entry on Android, or Safari's Share → Add to Home Screen on iPhone. Set an app lock if desired, then choose a session in the workbench.
5. Send a small task and confirm a real agent reply. If there is no history yet, create a session in the computer's agent CLI and refresh the workbench.

The user completes account sign-in, HTTPS consent, and phone system prompts. Their own agent can handle installation, configuration, and startup. Signing both devices into Tailscale alone does not start the hub or its HTTPS endpoint.

For autostart, stop the foreground process with Ctrl+C, then run `agent-hub setup --autostart`. Avoid two simultaneous instances. Register autostart from a global install, not a temporary npx cache. Use `agent-hub check` for diagnostics. See the [new-computer installation guide](docs/INSTALL.md) for checks and troubleshooting.

### Run from source

Source development requires Git and pnpm 10. Choose one startup mode:

```bash
git clone https://github.com/newObjectccc/agent-hub.git
cd agent-hub
npm install -g pnpm@10
pnpm install --frozen-lockfile
node cli/setup.js
npm run start
```

For phone access, replace the last line with `npm run remote`; for live development, use `npm run dev` (frontend `http://localhost:5173`). Do not run all modes simultaneously. `pnpm setup` is pnpm's own command; use `node cli/setup.js` for this project's setup.

See the [installation guide](docs/INSTALL.md) for Beta validation scope. Codex approval cards are wired, but real command, file, and permissions approval flows still require separate end-to-end validation. See the [Codex driver guide](docs/CODEX_DRIVER.md).

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
| [docs/CODEX_DRIVER.md](docs/CODEX_DRIVER.md) | Codex takeover, permission model, protocol contract, and limitations |
| [SECURITY.md](SECURITY.md) | Security policy: reporting channels and threat model |
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
pnpm build && pnpm lint && pnpm test   # full verification (2000+ tests, GitHub Actions CI-guarded)
```

Note: the dev entry is Vite (default `http://localhost:5173`) with `/api` and `/ws` proxied to the server (default 7700) — not 7700 directly.

If this checkout serves your phone, run build verification in a separate worktree so it cannot rewrite the live `web/dist`. Use one coordinated process for production builds and restarts; see the contribution guide.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [CHANGELOG.md](CHANGELOG.md) for release history.

## Deployment

Always-on on your own machine (platform-native autostart recommended):

```bash
agent-hub setup --autostart   # global install; stop the foreground instance first, registration attempts startup
```

Once registered it starts with the user session; see the platform guide for details. When tailscale is detected the autostart command automatically carries `--tailscale` (Tailscale Serve is re-provisioned idempotently on every boot, so the phone remote channel is always ready; override with `agent-hub setup --autostart --lan` for LAN-only). Day-to-day operations:

| Task | macOS (launchd) | Linux (systemd --user) |
|---|---|---|
| Stop | `launchctl unload ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user stop agent-hub` |
| Start | `launchctl load ~/Library/LaunchAgents/com.agent-hub.plist` | `systemctl --user start agent-hub` |
| Logs | `~/Library/Logs/agent-hub.log` | `journalctl --user -u agent-hub` |

> 💡 Crash recovery: newly generated launchd configurations default to `KeepAlive=true` and restart the process after it exits. To update an older configuration, unload it as above, then re-run `agent-hub setup --autostart` (source checkout: `node cli/setup.js --autostart`) so launchd reads the new settings. Use unload for an intentional stop too. Restarting preserves history but does not automatically resume tasks.

From source on a server (install pm2 first; self-healing + start on boot):

```bash
pnpm build
pm2 start ecosystem.config.js
pm2 save && pm2 startup        # start on boot
```

## Configuration

- npm installs use `~/.agent-hub/config/hub.config.json`; source checkouts use `config/hub.config.json`: ports / directories / auth (generated by setup). Fields and defaults:

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
| `codexBin` | `"codex"` | Command or binary path shared by parallel/takeover; doctor resolves its version; takeover requires 0.162+ including that alpha series |
| `codexDriver.enabled` / `defaultPolicy` | `true` / `"never"` | Manual Codex takeover; approval/sandbox inherit Codex settings. See [driver guide](docs/CODEX_DRIVER.md) |
| `codexDriver.approvalPolicy` / `sandbox` | `"inherit"` / `"inherit"` | Policy sent to app-server on takeover; `inherit` = do not override, keep `~/.codex/config.toml`. ⚠️ With `approval_policy="never"` + `sandbox_mode="danger-full-access"` in the user config, takeover produces **no approval requests at all** (commands just run); request `"untrusted"` to allow approval prompts, subject to policy validation (real approval flows still require validation). Explicit overrides compare the RPC baseline and final echo and accept only confirmed tightening: `approvalPolicy ∈ inherit\|untrusted\|on-request`, `sandbox ∈ inherit\|read-only\|workspace-write`; `never` / `danger-full-access` were removed — configuring them logs a warning and falls back to `inherit`, so the hub never puts Codex at looser permissions than your own config |
| `claudeDriver.enabled` | `true` | Master switch for claude takeover (hub-driven): when off no driver is constructed, takeover routes return 400, the UI falls back to parallel |
| `claudeDriver.defaultPolicy` | `"active-only"` | Claude attempts takeover when running or last driven by the terminal; `always`=attempt on open / `never`=manual only. Pi also requires its extension online; manual choices take priority |
| `claudeDriver.idleDetachMs` | `1800000` | Auto-detach after idle (ms, 30 min; `0`=never, never detaches mid-turn) |
| `claudeDriver.maxConcurrent` | `3` | Max concurrent hub drivers, including pending startups (excess → 409 DRIVER_LIMIT) |
| `claudeDriver.mirror` | `"tmux"` | Terminal mirroring (named tmux session, watch via `tmux attach`; auto-degrades to `off` without tmux) |
| `claudeDriver.externalQuietMs` | `3000` | File quiet window checked before preparation and immediately before process startup; recent external writes return 409. This does not provide a process lock |

- npm users may create `~/.agent-hub/config/kpi-sources.json`; source checkouts use `config/kpi-sources.json`: optional metric-card data sources (`${ENV_VAR}` for secrets)

## Security Notes (read before deploying)

This project ships with **zero authentication by default** — the trust boundary is your private network:

| Deployment | Safe | What to do |
|---|---|---|
| Local `127.0.0.1` (default) | ✅ | nothing |
| Tailscale / headscale / private LAN | ✅ | nothing (recommended) |
| Public VPS / exposed public IP | ❌ | **Do not expose directly.** For internet access use Tailscale/headscale, or put an authenticating reverse proxy (Caddy/Nginx basic auth, OAuth2, …) in front of the panel |

- **Honest note on `auth.token` (API auth)**: with `"auth": { "enabled": true, "token": "<long random string>" }` (effective only when enabled is `true` **and** the token is non-empty), every API and WS call requires `Authorization: Bearer <token>` — **including the bundled PWA's static assets**, while the web UI currently has no way to enter a Bearer token. Enabling it makes the built-in panel unusable; it only serves API/CLI callers (e.g. behind a reverse proxy that injects the header). Until web-side token support lands, use Tailscale/headscale or a fronting authenticating proxy for internet exposure — do **not** rely on `auth.token` alone to protect a public deployment
- `auth.enabled` defaults to `false` on purpose (frictionless tailnet experience)
- **The app lock (PIN / WebAuthn)** protects the UI and validates unlock tokens for business HTTP requests and WS send/abort operations. It does not replace the API token; both layers can be enabled together
- `host` defaults to `127.0.0.1` and wildcard binding is rejected; LAN exposure requires explicit `"allowLan": true` (or `agent-hub start --lan` / `npm run start -- --lan`, which writes `allowLan` automatically)
- Found a security issue? **Do not open a public issue** — report it privately per [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) © 2026 newObjectccc
