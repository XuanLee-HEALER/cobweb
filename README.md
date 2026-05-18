# cobweb

> **Personal-use EasyTier management tool.** Designed and maintained for one
> operator's mesh. The code is open so anyone with the same itch can read it
> and learn from it, but it bakes in assumptions about my own topology
> (mesh hub on aliyun ECS, `etmesh-ca` from a k8s `ClusterIssuer`, mesh hostnames
> like `cobweb.lan`, etc.). **If you want to actually run cobweb against your
> own mesh, fork and maintain it as a separate project** — substituting hub
> address, CA chain, DNS zone, and host fingerprints to match your setup.

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

## Deployment topology

cobweb is **not a generic web service** — it has a hard placement requirement.

### Where the server runs

The cobweb server **must run on the EasyTier hub node** (the node that hosts
the mesh's authoritative ipv4, typically `10.177.0.1`). Two processes share
the responsibility:

- **nginx** binds `10.177.0.1:8088 ssl http2` on the mesh tun0 IP — public
  eth0 sees nothing on 8088. It terminates TLS and reverse-proxies to bun
  (WebSocket upgrade + SSE both pass through; see
  `/etc/nginx/sites-available/cobweb.lan` on the hub).
- **cobweb-server** (Bun, this repo's `server/` package) binds
  `127.0.0.1:8089` plaintext loopback under systemd. It serves the
  agent registry, `/api/agents` REST surface, `/agent/ws`, `/api/stream`
  SSE, and the SPA static fallback.

- Mesh-internal DNS (CoreDNS) maps `cobweb.lan → 10.177.0.1`. The leaf
  cert has a **DNS-only SAN** (`DNS:cobweb.lan`, no IP SAN) — clients
  must use the hostname; `https://10.177.0.1:8088` will fail cert
  validation by design.
- Dashboard users and the agent both access via
  `https://cobweb.lan:8088` / `wss://cobweb.lan:8088/agent/ws` from any
  mesh-joined machine (browser / agent must trust `etmesh-root-ca`).

Running on a non-hub node would defeat both the mesh-internal-only listener
binding and the cert SAN — don't.

### TLS at the edge

nginx terminates TLS using a 7-day leaf cert from the mesh's private
step-ca (separate infra, not in this repo). cert + key live at:

```sh
/etc/cobweb/tls/server.crt    # owner cobweb-deploy:cobweb-deploy, mode 0640
/etc/cobweb/tls/server.key    # nginx's www-data is added to cobweb-deploy group
```

Two pieces keep them current:

- **cert-manager** (in archmbp's k8s, separate from this repo) signs new
  certs into a Secret as the old one approaches expiry — fully automatic,
  no human action.
- **`cobweb-tls-sync.timer`** on the hub (a systemd timer + shell script)
  pulls that Secret via `ssh archmbp + kubectl get` every 5 min, atomically
  replaces the two files when the sha256 changes, then runs
  `systemctl reload nginx`. nginx's graceful reload swaps the in-memory
  SSL_CTX without dropping established WebSocket / SSE connections —
  cobweb-server itself never restarts.

cobweb-server runs **plaintext** behind nginx; its systemd unit sets:

```
HOST=127.0.0.1
PORT=8089
COBWEB_ALLOW_PLAINTEXT=1
```

`COBWEB_ALLOW_PLAINTEXT=1` is also the local-dev escape hatch via
`just dev` — the same flag covers both "behind a TLS-terminating proxy"
and "developer laptop, no cert at all".

## CA trust on the agent side

The agent's rustls TLS layer **only trusts the embedded public roots by
default** — it does *not* read `/etc/ssl/certs` or any system trust store.
A private CA like `etmesh-ca` therefore has to be handed to the agent
explicitly:

```sh
# Recommended: env on the agent process
COBWEB_AGENT_TRUST_CA=/etc/cobweb-agent/etmesh-ca.crt cobweb-agent
# Or as a CLI flag
cobweb-agent --trust-ca /etc/cobweb-agent/etmesh-ca.crt
# Or via config.toml
trust_ca_path = "/etc/cobweb-agent/etmesh-ca.crt"
```

The agent install flow (`POST /api/mesh/agent/install`, or the dashboard's
"Agent 安装/升级" button) handles this end-to-end:

1. sftp **`etmesh-ca.crt`** to the node alongside the agent binary
2. install both into platform-specific paths
   (`/etc/cobweb-agent/` on POSIX, `%ProgramData%\cobweb-agent\` on Windows)
3. register the service with `COBWEB_AGENT_TRUST_CA=<that path>` baked
   into the systemd unit / launchd plist / Windows service env
4. start the service — first WSS handshake passes because the chain
   `cobweb.lan` ← `etmesh-root-ca` now resolves against a known root

Cert pinning (`--cert-fingerprint`) is an independent second layer on top
of the CA chain; even if the CA private key leaked, an attacker still
needs to match the pinned leaf-cert SHA-256 to MITM.

## Running the agent

Production: the systemd unit (or launchd plist / Windows service) starts
the agent as root / SYSTEM. See [`agent/service-installers/`](agent/service-installers/)
for templates and `README.md` in that folder. When deployed via the
dashboard "Agent 安装/升级" capability, `COBWEB_AGENT_TRUST_CA` is set
automatically; templates for manual installs also pre-fill it.

For ad-hoc / dev runs:

```sh
COBWEB_AGENT_SERVER_URL=wss://cobweb.lan:8088/agent/ws \
COBWEB_AGENT_TRUST_CA=/path/to/etmesh-ca.crt \
COBWEB_AGENT_LOG_DIR=./logs \
COBWEB_AGENT_LOG_LEVEL=debug \
./agent/target/debug/cobweb-agent --log-also-stderr
```

Config knobs (CLI flag, env var, or `config.toml` key — all three are layered, CLI wins):

| Flag                | Env                                   | Default                                                         |
|---------------------|---------------------------------------|-----------------------------------------------------------------|
| `--server-url`      | `COBWEB_AGENT_SERVER_URL`             | `wss://cobweb.lan:8088/agent/ws`                                |
| `--log-level`       | `COBWEB_AGENT_LOG_LEVEL`              | `info`                                                          |
| `--cert-fingerprint`| `COBWEB_AGENT_CERT_FINGERPRINT`       | (empty — disables pin; production should pin)                   |
| `--trust-ca`        | `COBWEB_AGENT_TRUST_CA`               | (empty — webpki-roots only; private CA needs explicit path)     |
| `--log-dir`         | `COBWEB_AGENT_LOG_DIR`                | `/var/log/cobweb-agent` or `%ProgramData%\cobweb-agent\logs`    |
| `--log-also-stderr` | `COBWEB_AGENT_LOG_ALSO_STDERR`        | `false`                                                         |
| `--config`          | `COBWEB_AGENT_CONFIG`                 | `/etc/cobweb-agent/config.toml`                                 |

Logs roll daily into `<log_dir>/cobweb-agent.YYYY-MM-DD`; files older than `log_max_age_days` (default 7) are deleted on start and every 6 h thereafter — no archive directory.

## Documents

- [`docs/tech-stack.md`](docs/tech-stack.md) — Hono RPC + Svelte SPA + SSE rationale
- [`docs/design-brief.md`](docs/design-brief.md) — UI design prompt
- [`docs/easytier-research.md`](docs/easytier-research.md) — EasyTier CLI capability survey
- [`docs/agent-design.md`](docs/agent-design.md) — Agent protocol + capabilities (architecture / why)
- [`docs/agent-impl-plan.md`](docs/agent-impl-plan.md) — Implementation rollout, TLS / replay / file-resume specs

## Contributing

The repo is public because reading other people's mesh tooling is useful,
not because it's a product. With that framing:

- **Bug reports / fixes welcome** — anything that breaks under normal use
  on the documented topology. Open an issue with reproduction steps or a
  PR with the smallest change that closes the gap.
- **Foundational hygiene welcome** — clearer error messages, dependency
  bumps, doc fixes, cross-OS portability tweaks, security hardening of
  what's already there.
- **Feature expansion: please don't.** I keep cobweb deliberately small
  so my own mesh stays observable in one head. PRs that add new
  capabilities (extra dashboards, more orchestration verbs, new agent
  features, integrations with third-party services) will most likely be
  declined. Fork it and grow it in your own copy — that's why MIT.

If you're unsure which bucket your idea falls into, file an issue first
and ask. Saves a round trip.

## License

[MIT](LICENSE). Use it, fork it, ship it — keep the copyright notice.
