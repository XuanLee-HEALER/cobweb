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
just dev          # full stack: dashboard (5173) + server (8088) in parallel
just check        # lint + typecheck (what pre-push runs) — JS only
just check-all    # check + cargo clippy + cargo test (slower)
just --list       # see all recipes
```

`just dev` runs both workspaces' `dev` scripts via
`bun run --filter '*' --parallel`, so dashboard vite and `bun --watch server`
share the same terminal with Foreman-style prefixed output (`@cobweb/server:dev`
and `@cobweb/dashboard:dev`). Ctrl+C kills both. If you want them apart, use
`just dev-front` and `just dev-back` in separate terminals.

`just serve` runs the backend non-watching (production-shaped invocation) —
use it after `just build` to test the built dist alongside the API.

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
