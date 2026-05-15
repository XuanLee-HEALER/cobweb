# cobweb · task runner
# `just <recipe>` ; `just --list` to discover

set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# install deps
install:
    bun install

# dev server (vite, http://localhost:5173)
dev:
    bun run dev

# production build
build:
    bun run build

# run the backend (requires easytier-cli + nodes.json)
serve:
    bun server.ts

# preview the production build
preview:
    bun run preview

# biome lint (read-only)
lint:
    bunx biome check .

# biome lint + auto-fix
lint-fix:
    bunx biome check --write .

# biome format only (write)
fmt:
    bunx biome format --write .

# svelte type check
typecheck:
    bunx svelte-check --tsconfig ./tsconfig.json

# everything that pre-push runs
check: lint typecheck

# install git hooks (run after clone)
hooks:
    @echo "installing pre-push hook"
    @bun scripts/install-hooks.ts

# clean build output and lockfiles
clean:
    bun run -- rm -rf dist .vite
