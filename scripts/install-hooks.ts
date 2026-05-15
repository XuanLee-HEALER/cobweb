// Install git hooks from scripts/hooks/ into .git/hooks/.
// Cross-platform (Windows / macOS / Linux). Invoked by `just hooks`.

import { chmodSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

if (!existsSync(".git")) {
  console.error("not a git repository — run `git init` first");
  process.exit(1);
}

const HOOKS_DIR = ".git/hooks";
const SRC_DIR = "scripts/hooks";

if (!existsSync(SRC_DIR)) {
  console.error(`missing ${SRC_DIR}`);
  process.exit(1);
}

let installed = 0;
for (const name of readdirSync(SRC_DIR)) {
  const src = join(SRC_DIR, name);
  if (!statSync(src).isFile()) continue;
  const dst = join(HOOKS_DIR, name);
  copyFileSync(src, dst);
  try {
    chmodSync(dst, 0o755);
  } catch {
    // chmod is a no-op on Windows; git for Windows still honors the script.
  }
  console.log(`installed ${name}`);
  installed++;
}

if (installed === 0) {
  console.warn("no hooks found in scripts/hooks/");
}
