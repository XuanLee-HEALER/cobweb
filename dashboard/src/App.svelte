<script lang="ts">
  import { CAPABILITIES } from "$lib/data/mock-nodes";
  import { ui, closeContextMenu, closeDrill } from "$lib/state/ui.svelte";
  import { initMesh, mesh } from "$lib/state/mesh.svelte";
  import { loadTaskHistory } from "$lib/state/tasks.svelte";
  import TopBar from "$lib/components/shell/TopBar.svelte";
  import StatusBar from "$lib/components/shell/StatusBar.svelte";
  import Dashboard from "$lib/components/dashboard/Dashboard.svelte";
  import DistributionCenter from "$lib/components/distribute/DistributionCenter.svelte";
  import CommandPalette from "$lib/components/overlays/CommandPalette.svelte";
  import ContextMenuHost from "$lib/components/overlays/ContextMenuHost.svelte";
  import DrillDownPopover from "$lib/components/overlays/DrillDownPopover.svelte";
  import TerminalDrawer from "$lib/components/terminal/TerminalDrawer.svelte";

  // Locked defaults (per design chat: tweaks panel removed).
  const CELL_SIZE = 62;
  const VISIBLE_NODES = 12;
  const SIDE_PANEL_VISIBLE = true;

  const visibleNodes = $derived(mesh.nodes.slice(0, VISIBLE_NODES));

  // Boot data fetch on mount: peer-center + agents + recent tasks.
  $effect(() => {
    initMesh();
    loadTaskHistory();
  });

  // When mesh loads, auto-select the local node if the current selection
  // doesn't match any real node (default was a static mock id).
  $effect(() => {
    if (!mesh.loaded) return;
    const stillValid = mesh.nodes.some((n) => n.id === ui.selectedNodeId);
    if (!stillValid) {
      ui.selectedNodeId = mesh.selfId || mesh.nodes[0]?.id || "";
    }
  });

  // ── Hash routing ──────────────────────────────────────────────────
  $effect(() => {
    function parse() {
      const raw = (window.location.hash || "").replace(/^#/, "");
      if (!raw) return;
      const parts = raw.split("/").filter(Boolean);
      const head = parts[0];
      if (head === "d" || head === "dashboard") {
        ui.module = "dashboard";
        if (parts[1] && mesh.nodes.some((n) => n.id === parts[1])) {
          ui.selectedNodeId = parts[1];
        } else if (parts[1]) {
          // mesh may not have loaded yet — remember the requested id and
          // the auto-select effect above will keep it if it shows up.
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
