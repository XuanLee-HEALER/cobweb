<script lang="ts">
  import { NODES, CAPABILITIES } from "./lib/data";
  import { ui, closeContextMenu, closeDrill } from "./lib/ui-state.svelte";
  import TopBar from "./lib/TopBar.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import Dashboard from "./lib/Dashboard.svelte";
  import DistributionCenter from "./lib/DistributionCenter.svelte";
  import CommandPalette from "./lib/CommandPalette.svelte";
  import ContextMenuHost from "./lib/ContextMenuHost.svelte";
  import DrillDownPopover from "./lib/DrillDownPopover.svelte";
  import TerminalDrawer from "./lib/TerminalDrawer.svelte";

  // Locked defaults (per design chat: tweaks panel removed).
  const CELL_SIZE = 62;
  const VISIBLE_NODES = 12;
  const SIDE_PANEL_VISIBLE = true;

  const visibleNodes = $derived(NODES.slice(0, VISIBLE_NODES));

  // ── Hash routing ──────────────────────────────────────────────────
  $effect(() => {
    function parse() {
      const raw = (window.location.hash || "").replace(/^#/, "");
      if (!raw) return;
      const parts = raw.split("/").filter(Boolean);
      const head = parts[0];
      if (head === "d" || head === "dashboard") {
        ui.module = "dashboard";
        if (parts[1] && NODES.some(n => n.id === parts[1])) {
          ui.selectedNodeId = parts[1];
        }
      } else if (head === "x" || head === "distribute") {
        ui.module = "distribute";
        if (parts[1] && CAPABILITIES.some(c => c.id === parts[1])) {
          ui.distCapId = parts[1];
        }
        if (parts[2] && ["compose", "result", "history"].includes(parts[2])) {
          ui.distView = parts[2] as typeof ui.distView;
        }
      }
    }
    parse();
    window.addEventListener("hashchange", parse);
    return () => window.removeEventListener("hashchange", parse);
  });

  // Emit hash from state (replaceState so back doesn't accumulate).
  $effect(() => {
    let h;
    if (ui.module === "dashboard") {
      h = "#/d/" + (ui.selectedNodeId || "");
    } else {
      h = "#/x/" + ui.distCapId + (ui.distView !== "compose" ? "/" + ui.distView : "");
    }
    if (window.location.hash !== h) {
      window.history.replaceState(null, "", h);
    }
  });

  // ── Keyboard: g d / g s · cmd+k · ` · esc ─────────────────────────
  $effect(() => {
    let gTimer: number | null = null;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName || "";
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.cmdkOpen = true;
        return;
      }
      if (e.key === "Escape") {
        if (ui.ctxMenu) closeContextMenu();
        else if (ui.drill) closeDrill();
        else if (ui.cmdkOpen) ui.cmdkOpen = false;
        else if (ui.termOpen) ui.termOpen = false;
        ui.gPrefix = false;
        return;
      }
      if (inField) return;
      if (ui.gPrefix) {
        if (e.key === "d") { ui.module = "dashboard"; ui.gPrefix = false; }
        else if (e.key === "s") { ui.module = "distribute"; ui.gPrefix = false; }
        else { ui.gPrefix = false; }
        return;
      }
      if (e.key === "g") {
        ui.gPrefix = true;
        if (gTimer) window.clearTimeout(gTimer);
        gTimer = window.setTimeout(() => { ui.gPrefix = false; }, 1200);
      }
      if (e.key === "`") {
        ui.termOpen = !ui.termOpen;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimer) window.clearTimeout(gTimer);
    };
  });
</script>

<div class="app">
  <TopBar onOpenCmdk={() => ui.cmdkOpen = true} />

  {#if ui.module === "dashboard"}
    <Dashboard nodes={visibleNodes} cellSize={CELL_SIZE} sidePanel={SIDE_PANEL_VISIBLE} />
  {:else}
    <DistributionCenter />
  {/if}

  <StatusBar />

  {#if ui.cmdkOpen}
    <CommandPalette onClose={() => ui.cmdkOpen = false} />
  {/if}

  {#if ui.drill}
    <DrillDownPopover drill={ui.drill} onClose={closeDrill} />
  {/if}

  {#if ui.ctxMenu}
    <ContextMenuHost menu={ui.ctxMenu} onClose={closeContextMenu} />
  {/if}

  {#if ui.termOpen && ui.termSessions.length > 0}
    <TerminalDrawer />
  {/if}
</div>
