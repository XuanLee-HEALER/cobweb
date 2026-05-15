# cobweb

EasyTier private mesh management dashboard. Bun + Hono + Svelte 5 + a Rust agent
(planned), surfaced as a single dense dashboard for monitoring, distribution of
config / files / commands across the mesh.

## Status

UI prototype + design system imported; backend is the original `Bun.serve` from
the previous iteration awaiting the Hono RPC rewrite. See [`docs/`](docs/).

## Quick start

```sh
just install      # bun install
just dev          # vite dev (localhost:5173)
just serve        # run the backend (needs easytier-cli + nodes.json)
just check        # lint + svelte-check (what pre-push runs)
just --list       # see all recipes
```

After cloning, install the git hook once:

```sh
just hooks        # copies scripts/hooks/pre-push into .git/hooks/
```

## Documents

- [`docs/tech-stack.md`](docs/tech-stack.md) — Hono + Hono RPC + Svelte SPA + SSE
- [`docs/design-brief.md`](docs/design-brief.md) — UI design prompt for Claude Design
- [`docs/easytier-research.md`](docs/easytier-research.md) — EasyTier CLI capability survey
- [`docs/agent-design.md`](docs/agent-design.md) — Rust agent (capabilities, protocol, bootstrap)

## License

Private. Not for redistribution.
