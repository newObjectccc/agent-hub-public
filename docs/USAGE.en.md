# Usage and operations

[Back to README](../README.en.md) · [简体中文](USAGE.md)

This reference covers session behavior, deployment, and configuration. For first-time setup and phone access, see [Installation](INSTALL.md) (Chinese). Agent-specific details are in the [Claude](CLAUDE_DRIVER.md) and [Codex](CODEX_DRIVER.md) driver guides.

## Resuming old sessions and choosing a mode

Completed sessions can continue: sending from your phone starts a new turn from saved context even after the original computer terminal has closed. Opening a session does not resend old tasks, and a session title does not indicate its current run status. The computer's hub service and the relevant agent runtime must be available. Closing the PWA does not stop accepted work; restarting the hub does not automatically resume execution or takeover.

| Claude scenario | Sending behavior |
|---|---|
| Parallel, idle | The hub starts a CLI run; the original terminal can stay closed |
| Parallel, a hub-owned run is busy | Normal send returns busy; both steer and follow-up queue until that run ends |
| Parallel, an external terminal is busy (pi / Claude) | All three modes return busy (pi: `EXTERNAL_ACTIVE`, Claude: `SESSION_BUSY`) with an actionable reason; parallel mode cannot queue into that terminal |
| Takeover | The hub owns a new persistent CLI process; steer is handled between tools, follow-up after the turn; a normal send while busy fails through the command acknowledgment |

pi parallel continue resumes through an SDK instance inside the hub process: **tool calls (file reads/writes, shell commands) really execute on your computer with no human approval** — use it only in repos you trust. Claude parallel defaults to `--permission-mode bypassPermissions`: tools **run automatically on your computer with no human approval** (same risk class as pi — use only in repos you trust); set `claudeDriver.permissionMode` back to `manual` or another confirmation-gated tier in the hub config — confirmation-gated tiers surface an approval card on your phone on **both** the parallel and takeover paths (same HostRequestCard; allow/deny to continue). Model/network failures (including out-of-credits, connection errors and context overflow) do not throw in pi; they land on the message's stopReason, and the hub surfaces them as an inline error bar: context overflow offers a one-tap "compact context" self-help, manual abort uses a neutral tone. Error notices stay until dismissed. Messages blocked by the double-write gate, or not executed by the terminal, fall back to the offline queue and keep a failed bubble with a retry entry — the text is never lost.

Codex also defaults to full execution permissions on both paths: no operation approvals and full file/network access within the current OS account. Model questions still wait for your answer card. Existing explicit `inherit` or stricter choices remain in effect across upgrades.

Claude takeover does not control the original TUI window. Avoid simultaneous input there during takeover; tmux mirrors the hub process. External activity detection uses file timestamps, and its quiet window is not a process lock.

With the default `active-only` policy, pi defaults to takeover when its terminal extension is online. Claude attempts takeover when `status=running` **or** `lastDrivenBy=terminal`; otherwise it defaults to parallel. `always` attempts takeover on every open; `never` requires a manual choice. Manual choices take priority, while quiet-window checks, the enabled switch, and concurrency limits still apply.

One completed assistant message can be followed by more tools. The page confirms completion through turn-end events and server status; after five seconds of silence it checks status rather than marking the task complete.

Uploaded images appear as thumbnails. Claude's image dimensions/coordinate hints are internal metadata and are hidden from the conversation. Older `@.agent-hub-uploads/...` messages can regain previews when a matching successful image-read result is saved; a path alone does not guarantee a preview after refresh. See the [API contract](API_CONTRACT.md) and [Claude driver guide](CLAUDE_DRIVER.md) for details.

## Deployment

Always-on on your own machine (platform-native autostart recommended):

```bash
agent-hub setup --autostart   # global install; stop the foreground instance first, registration attempts startup
```

Once registered it starts with the user session; see the platform guide for details. When tailscale is detected the autostart command automatically carries `--tailscale` to attempt Serve setup at startup; use `agent-hub setup --autostart --lan` for LAN-only access. Complete Tailscale installation, sign-in, and first-time HTTPS consent beforehand. Day-to-day operations:

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
| `codexDriver.enabled` / `defaultPolicy` | `true` / `"never"` | Parallel continuation is the default; Codex takeover is manual. This setting does not control tool permissions. See [driver guide](CODEX_DRIVER.md) |
| `codexDriver.approvalPolicy` / `sandbox` | `"never"` / `"danger-full-access"` | Both parallel and takeover default to no operation approvals and full file/network access, bounded by the OS account and managed policy. Approval: `inherit\|never\|untrusted\|on-request`; sandbox: `inherit\|danger-full-access\|read-only\|workspace-write`. Only `inherit` follows local settings. Takeover verifies the actual policy echo; invalid policy fields stop startup. Use `on-request` for model-requested phone approvals; legacy `untrusted` requires CLI support. Real approval flows still require validation |
| `claudeDriver.enabled` | `true` | Master switch for claude takeover (hub-driven): when off no driver is constructed, takeover routes return 400, the UI falls back to parallel |
| `claudeDriver.defaultPolicy` | `"active-only"` | Claude attempts takeover when running or last driven by the terminal; `always`=attempt on open / `never`=manual only. Pi also requires its extension online; manual choices take priority |
| `claudeDriver.idleDetachMs` | `1800000` | Auto-detach after idle (ms, 30 min; `0`=never, never detaches mid-turn) |
| `claudeDriver.maxConcurrent` | `3` | Max concurrent hub drivers, including pending startups (excess → 409 DRIVER_LIMIT) |
| `claudeDriver.mirror` | `"tmux"` | Terminal mirroring (named tmux session, watch via `tmux attach`; auto-degrades to `off` without tmux) |
| `claudeDriver.externalQuietMs` | `3000` | File quiet window checked before preparation and immediately before process startup; recent external writes return 409. This does not provide a process lock |
| `claudeDriver.permissionMode` | `"bypassPermissions"` | Permission tier controlling `--permission-mode` for both parallel and takeover paths: default `bypassPermissions` (highest — tools run automatically on both paths with no human approval); `manual`/`default`/`acceptEdits`/`plan` are confirmation-gated tiers — both the parallel and takeover paths route them to the same phone approval card; `inherit` follows your `~/.claude/settings.json`. Invalid permission values, unknown keys, and misplaced fields stop startup instead of falling back to the highest permission tier |

- npm users may create `~/.agent-hub/config/kpi-sources.json`; source checkouts use `config/kpi-sources.json`: optional metric-card data sources (`${ENV_VAR}` for secrets)

## Security Notes (read before deploying)

This project ships with **zero authentication by default** — the trust boundary is your private network:

| Deployment | Safe | What to do |
|---|---|---|
| Local `127.0.0.1` (default) | ✅ | nothing |
| Tailscale / headscale / private LAN | ✅ | nothing (recommended) |
| Public VPS / exposed public IP | ❌ | **Do not expose directly.** For internet access use Tailscale/headscale, or put an authenticating reverse proxy (Caddy/Nginx basic auth, OAuth2, …) in front of the panel |

- **Honest note on `auth.token` (API auth)**: with `"auth": { "enabled": true, "token": "<long random string>" }` (startup rejects an empty token, invalid types, or misspelled auth fields), every API and WS call requires `Authorization: Bearer <token>` — **including the bundled PWA's static assets**, while the web UI currently has no way to enter a Bearer token. Enabling it makes the built-in panel unusable; it only serves API/CLI callers (e.g. behind a reverse proxy that injects the header). Until web-side token support lands, use Tailscale/headscale or a fronting authenticating proxy for internet exposure — do **not** rely on `auth.token` alone to protect a public deployment
- `auth.enabled` defaults to `false` on purpose (frictionless tailnet experience)
- **The app lock (PIN / WebAuthn)** protects the UI and validates unlock tokens for business HTTP requests and WS send/abort operations. It does not replace the API token; both layers can be enabled together
- `host` defaults to `127.0.0.1` and wildcard binding is rejected; LAN exposure requires explicit `"allowLan": true` (or `agent-hub start --lan` / `npm run start -- --lan`, which writes `allowLan` automatically)
- Found a security issue? **Do not open a public issue** — report it privately per [SECURITY.md](../SECURITY.md)
