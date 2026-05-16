# cobweb · workspace task runner
# `just <recipe>` ; `just --list` to discover

set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# install all workspace js deps + rust agent crates
install:
    bun install
    cargo fetch --manifest-path agent/Cargo.toml

# ── dashboard ───────────────────────────────────────────────

# dashboard vite dev server (http://localhost:5173)
dev:
    bun run --cwd dashboard dev

# build dashboard (output: dashboard/dist/)
build:
    bun run --cwd dashboard build

# vite preview of the built dashboard
preview:
    bun run --cwd dashboard preview

# ── server ──────────────────────────────────────────────────

# run the backend (requires easytier-cli + optional nodes.json)
serve:
    bun run --cwd server start

# server with --watch reload (re-runs on file change)
serve-watch:
    bun run --cwd server dev

# ── agent (rust) ────────────────────────────────────────────

agent-build:
    cargo build --manifest-path agent/Cargo.toml

agent-release:
    cargo build --release --manifest-path agent/Cargo.toml

# clippy + tests; matches what agent-check would in CI
agent-check:
    cargo clippy --manifest-path agent/Cargo.toml --all-targets -- -D warnings
    cargo test --manifest-path agent/Cargo.toml

agent-fmt:
    cargo fmt --manifest-path agent/Cargo.toml

# ── lint + typecheck (whole repo) ───────────────────────────

lint:
    bunx biome check .

lint-fix:
    bunx biome check --write .

fmt:
    bunx biome format --write .

typecheck-dashboard:
    bun run --cwd dashboard check

typecheck-server:
    bun run --cwd server check

typecheck: typecheck-dashboard typecheck-server

# what pre-push runs
check: lint typecheck

# install git hooks (run after clone)
hooks:
    @echo "installing pre-push hook"
    @bun scripts/install-hooks.ts

# clean build outputs
clean:
    bun run -- rm -rf dashboard/dist .vite agent/target
