// One-shot import rewriter after src/lib reorganization.
// Rewrites:
//   "./data"             → "$lib/data/mock-nodes"
//   "./ui-state.svelte"  → "$lib/state/ui.svelte"
//   "./terminal-mock"    → "$lib/data/terminal-mock"
//   "./menu-builders"    → "$lib/menu-builders"
//   "./<Component>.svelte" → "$lib/components/<category>/<Component>.svelte"
// Also handles "./lib/..." form (from src/App.svelte).
//
// Idempotent: re-running on already-rewritten files is a no-op.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CATEGORY: Record<string, string> = {
  DualStat: "ui",
  ChannelBadge: "ui",
  Sparkline: "ui",
  CellTooltip: "ui",
  Legend: "ui",
  TopBar: "shell",
  StatusBar: "shell",
  Dashboard: "dashboard",
  Matrix: "dashboard",
  NodeDetailSide: "dashboard",
  NodeMetrics: "dashboard",
  CollapsedPanel: "dashboard",
  DistributionCenter: "distribute",
  CapabilityList: "distribute",
  ComposeView: "distribute",
  ResultView: "distribute",
  HistoryView: "distribute",
  TerminalDrawer: "terminal",
  TerminalSession: "terminal",
  TerminalNodePicker: "terminal",
  CommandPalette: "overlays",
  ContextMenuHost: "overlays",
  DrillDownPopover: "overlays",
  DrillChart: "overlays",
};

const MODULE: Record<string, string> = {
  data: "$lib/data/mock-nodes",
  "ui-state.svelte": "$lib/state/ui.svelte",
  "terminal-mock": "$lib/data/terminal-mock",
  "menu-builders": "$lib/menu-builders",
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(svelte|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

function rewrite(src: string): string {
  // strip optional "./lib/" prefix so the same regex handles both src/App.svelte
  // and intra-src/lib imports.
  const re = /from\s+(["'])(?:\.\/)?(?:lib\/)?([^"']+?)\1/g;
  return src.replace(re, (whole, q, spec) => {
    if (MODULE[spec]) return `from ${q}${MODULE[spec]}${q}`;
    const m = spec.match(/^([A-Z][A-Za-z0-9]+)\.svelte$/);
    if (m && CATEGORY[m[1]]) {
      return `from ${q}$lib/components/${CATEGORY[m[1]]}/${m[1]}.svelte${q}`;
    }
    return whole;
  });
}

const files = walk("src");
let touched = 0;
for (const f of files) {
  const before = readFileSync(f, "utf8");
  const after = rewrite(before);
  if (after !== before) {
    writeFileSync(f, after);
    touched++;
    console.log(`  rewrote ${f}`);
  }
}
console.log(`done. ${touched}/${files.length} files updated.`);
