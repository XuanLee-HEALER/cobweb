# cobweb

EasyTier private mesh management dashboard. Dense, single-user, three packages
in one repo:

- **`dashboard/`** — Svelte 5 + Vite frontend
- **`server/`**    — Bun + Hono backend with typed RPC + SSE + `/agent/ws` WebSocket
- **`agent/`**     — Rust daemon that runs on every managed node and reverse-connects to the server (protocol in [`docs/agent-design.md`](docs/agent-design.md), rollout in [`docs/agent-impl-plan.md`](docs/agent-impl-plan.md))

Workspace orchestration via Bun workspaces for the JS packages; Cargo handles
the agent. Top-level `justfile` dispatches everything.

## Quick start

```sh
just install      # bun install + cargo fetch
just hooks        # one-time: install pre-commit + pre-push git hooks
just dev          # full stack: dashboard (5173) + server (8088) in parallel
just check        # lint + typecheck (what pre-push runs) — JS only
just check-all    # check + cargo clippy + cargo test (slower, full repo)
just --list       # see all recipes
```

`just dev` runs both workspaces' `dev` scripts via
`bun run --filter '*' --parallel`, so dashboard vite and `bun --watch server`
share the same terminal with Foreman-style prefixed output (`@cobweb/server:dev`
and `@cobweb/dashboard:dev`). Ctrl+C kills both. If you want them apart, use
`just dev-front` and `just dev-back` in separate terminals.

`just serve` runs the backend non-watching (production-shaped invocation) —
use it after `just build` to test the built dist alongside the API.

For the Rust agent specifically:

```sh
just agent-build      # debug build (target/debug/cobweb-agent[.exe])
just agent-release    # release build
just agent-check      # cargo clippy --all-targets -D warnings + cargo test
just agent-fmt        # rustfmt
```

## Layout

```
cobweb/
├── package.json              workspaces declaration
├── tsconfig.base.json        shared TS compiler options
├── biome.json                lint + format (JS/TS/JSON, repo-wide)
├── justfile                  top-level task runner
├── docs/                     architecture + design briefs
├── scripts/
│   ├── install-hooks.ts      cross-platform `just hooks`
│   └── hooks/
│       ├── pre-commit        biome check (lint + format) over the whole tree
│       └── pre-push          `just check` (lint + typecheck)
├── dashboard/                @cobweb/dashboard (svelte 5 + vite)
├── server/                   @cobweb/server (bun + hono)
└── agent/                    cobweb-agent (rust, edition 2024)
    ├── src/
    │   ├── main.rs           entrypoint (CLI + signal handling)
    │   ├── lib.rs            module root
    │   ├── config.rs         layered config (CLI > env > toml > defaults)
    │   ├── logging.rs        daily-rotated file logs + 7-day retention
    │   ├── protocol.rs       wire message enums (serde tagged unions)
    │   ├── transport.rs      tokio-tungstenite + rustls + SHA-256 cert pin
    │   ├── connection.rs     state machine + reconnect backoff + heartbeats
    │   ├── buffer.rs         per-event-type replay ring + priority eviction
    │   ├── dispatcher.rs     inbound message → capability routing
    │   ├── capabilities/     cli / exec / file handlers
    │   └── collectors/       heartbeat (10 s) + peer_view (5 s)
    ├── tests/                end-to-end integration tests
    └── service-installers/   systemd unit / launchd plist / Windows install.ps1
```

## Architecture

```
┌──── managed node ─────────┐
│  easytier-core RPC :15888 │
│       ▲                   │
│  cobweb-agent ────WSS reverse-connect────┐
└──────────────────────────────────────────│──┐
                                           │  │ over EasyTier mesh
                                           ▼  │
                                  ┌── cobweb host ──┐
                                  │  bun + hono     │
                                  │  /agent/ws      │  (mesh IP, port 8088)
                                  │  dashboard SPA  │
                                  │  REST + SSE     │
                                  └─────────────────┘
```

Three trust boundaries (impl-plan §3):
1. The agent dials WSS over the EasyTier mesh — the listener is mesh-bound, not internet-bound.
2. TLS chain is verified against an embedded CA.
3. The server's leaf cert SHA-256 is pinned in the agent config — a CA compromise alone is not enough to MITM.

## Running the agent

Production: the systemd unit (or launchd plist / Windows service) starts the agent as root / SYSTEM. See [`agent/service-installers/`](agent/service-installers/) for templates and `README.md` in that folder.

For ad-hoc / dev runs:

```sh
COBWEB_AGENT_SERVER_URL=ws://127.0.0.1:8088/agent/ws \
COBWEB_AGENT_LOG_DIR=./logs \
COBWEB_AGENT_LOG_LEVEL=debug \
./agent/target/debug/cobweb-agent --log-also-stderr
```

Config knobs (CLI flag, env var, or `config.toml` key — all three are layered, CLI wins):

| Flag                | Env                                   | Default                                                         |
|---------------------|---------------------------------------|-----------------------------------------------------------------|
| `--server-url`      | `COBWEB_AGENT_SERVER_URL`             | `wss://10.177.0.1:8088/agent/ws`                                |
| `--log-level`       | `COBWEB_AGENT_LOG_LEVEL`              | `info`                                                          |
| `--cert-fingerprint`| `COBWEB_AGENT_CERT_FINGERPRINT`       | (empty — disables pin; production should pin)                   |
| `--log-dir`         | `COBWEB_AGENT_LOG_DIR`                | `/var/log/cobweb-agent` or `%ProgramData%\cobweb-agent\logs`    |
| `--log-also-stderr` | `COBWEB_AGENT_LOG_ALSO_STDERR`        | `false`                                                         |
| `--config`          | `COBWEB_AGENT_CONFIG`                 | `/etc/cobweb-agent/config.toml`                                 |

Logs roll daily into `<log_dir>/cobweb-agent.YYYY-MM-DD`; files older than `log_max_age_days` (default 7) are deleted on start and every 6 h thereafter — no archive directory.

## Running the server with TLS

Production mode (matches impl-plan §3.4):

```sh
SERVER_CERT_PATH=/etc/cobweb/server.crt \
SERVER_KEY_PATH=/etc/cobweb/server.key \
HOST=10.177.0.1 PORT=8088 \
bun server/src/index.ts
```

If either path is missing the server falls back to plaintext (HTTP + WS), useful for local development. The `/agent/ws` upgrade lives on the same port as the dashboard HTTPS — one Bun.serve, one TLS material.

## Documents

- [`docs/tech-stack.md`](docs/tech-stack.md) — Hono RPC + Svelte SPA + SSE rationale
- [`docs/design-brief.md`](docs/design-brief.md) — UI design prompt
- [`docs/easytier-research.md`](docs/easytier-research.md) — EasyTier CLI capability survey
- [`docs/agent-design.md`](docs/agent-design.md) — Agent protocol + capabilities (architecture / why)
- [`docs/agent-impl-plan.md`](docs/agent-impl-plan.md) — Implementation rollout, TLS / replay / file-resume specs

## License

Private. Not for redistribution.
