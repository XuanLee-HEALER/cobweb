# cobweb

EasyTier private mesh management dashboard. Dense, single-user, three packages
in one repo:

- **`dashboard/`** — Svelte 5 + Vite frontend
- **`server/`**    — Bun + Hono backend with typed RPC + SSE
- **`agent/`**     — Rust daemon (scaffold; protocol in [`docs/agent-design.md`](docs/agent-design.md))

Workspace orchestration via Bun workspaces for the JS packages; Cargo handles
the agent. Top-level `justfile` dispatches everything.

## Quick start

```sh
just install      # bun install + cargo fetch
just hooks        # one-time: install pre-push git hook
just dev          # dashboard vite dev (http://localhost:5173)
just serve        # backend (port 8088; needs easytier-cli + optional nodes.json)
just check        # lint + typecheck (what pre-push runs) — JS only
just check-all    # check + cargo clippy + cargo test (slower)
just --list       # see all recipes
```

For a real local stack: run `just serve` in one terminal and `just dev` in
another. The dev server proxies `/api/*` and `/api/stream` to the backend.

## Layout

```
cobweb/
├── package.json              workspaces declaration
├── tsconfig.base.json        shared TS compiler options
├── biome.json                lint + format (JS/TS/JSON, repo-wide)
├── justfile                  top-level task runner
├── docs/                     architecture + design briefs
├── scripts/                  git hooks installer
├── dashboard/                @cobweb/dashboard (svelte 5 + vite)
├── server/                   @cobweb/server (bun + hono)
└── agent/                    cobweb-agent (rust, edition 2024)
```

## Documents

- [`docs/tech-stack.md`](docs/tech-stack.md) — Hono RPC + Svelte SPA + SSE
- [`docs/design-brief.md`](docs/design-brief.md) — UI design prompt
- [`docs/easytier-research.md`](docs/easytier-research.md) — EasyTier CLI capability survey
- [`docs/agent-design.md`](docs/agent-design.md) — Rust agent protocol + capabilities

## License

Private. Not for redistribution.
