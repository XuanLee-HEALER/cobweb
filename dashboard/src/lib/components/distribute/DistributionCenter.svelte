<script lang="ts">
  import { CAPABILITIES } from '$lib/data/mock-nodes';
  import { mesh } from '$lib/state/mesh.svelte';
  import { tasks, runApply } from '$lib/state/tasks.svelte';
  import { ui, type Preset } from '$lib/state/ui.svelte';
  import CapabilityList from '$lib/components/distribute/CapabilityList.svelte';
  import ComposeView from '$lib/components/distribute/ComposeView.svelte';
  import ResultView from '$lib/components/distribute/ResultView.svelte';
  import HistoryView from '$lib/components/distribute/HistoryView.svelte';
  import ChannelBadge from '$lib/components/ui/ChannelBadge.svelte';

  let selectedNodes = $state<Set<string>>(new Set());
  let dryRun = $state(false);
  let presetDraft = $state<{ name: string } | null>(null);

  // First time mesh.nodes loads, default-select all managed nodes. After that
  // the user controls the selection (firstFillDone is a plain non-reactive
  // closure flag so empty-on-purpose stays empty).
  let firstFillDone = false;
  $effect(() => {
    if (firstFillDone) return;
    if (mesh.nodes.length === 0) return;
    selectedNodes = new Set(mesh.nodes.filter((n) => !n.notManaged).map((n) => n.id));
    firstFillDone = true;
  });

  const cap = $derived(CAPABILITIES.find((c) => c.id === ui.distCapId) ?? CAPABILITIES[0]);

  const lastResultId = $derived(tasks.byCapId[ui.distCapId]?.id ?? '—');
  const historyCountForCap = $derived(
    tasks.history.filter((t) => taskBelongsToCap(t.name, ui.distCapId)).length,
  );

  function taskBelongsToCap(taskName: string, capId: string): boolean {
    if (capId === 'ca' && taskName.startsWith('CA ')) return true;
    if (capId === 'dns' && taskName.startsWith('DNS ')) return true;
    if (capId === 'ssh' && taskName.startsWith('SSH key')) return true;
    if (capId === 'agent' && taskName.startsWith('cobweb-agent')) return true;
    return false;
  }

  function toggle(id: string) {
    const next = new Set(selectedNodes);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedNodes = next;
  }
  function selectAll() {
    selectedNodes = new Set(mesh.nodes.filter((n) => !n.notManaged).map((n) => n.id));
  }
  function selectNone() {
    selectedNodes = new Set();
  }
  function invert() {
    const next = new Set<string>();
    for (const n of mesh.nodes) {
      if (!n.notManaged && !selectedNodes.has(n.id)) next.add(n.id);
    }
    selectedNodes = next;
  }

  function onApplyPreset(p: Preset) {
    if (p.steps[0]) {
      ui.distCapId = p.steps[0];
      ui.distView = 'compose';
    }
  }

  function onSavePreset(name: string) {
    ui.presets = [
      ...ui.presets,
      {
        id: 'preset-' + Date.now().toString(36),
        name,
        steps: [cap.id],
        created: new Date().toISOString().slice(0, 10),
      },
    ];
    presetDraft = null;
  }

  async function onSubmit() {
    // Switch view first so the user sees the "running" state immediately.
    ui.distView = 'result';
    if (dryRun) return; // dry-run currently no-op; future: POST with dryRun flag
    const id = cap.id;
    if (id === 'ca' || id === 'dns' || id === 'ssh' || id === 'agent') {
      await runApply(id);
    }
    // Future caps don't have apply endpoints yet — the result view will show
    // "no recent task" until they're implemented.
  }
</script>

<div class="dist" data-screen-label="02 Distribution Center">
  <CapabilityList
    active={ui.distCapId}
    onPick={(id) => {
      ui.distCapId = id;
      ui.distView = 'compose';
    }}
    presets={ui.presets}
    {onApplyPreset} />

  <div class="cap-pane">
    <div class="cap-header">
      <div class="breadcrumbs">分发中心 · {cap.name}</div>
      <div class="row gap-3" style="align-items: baseline">
        <h1>{cap.name}</h1>
        <span style="font-family: var(--font-mono); font-size: 11px; color: var(--fg-disabled)">{cap.tag.toUpperCase()}</span>
        <ChannelBadge channel={cap.channel} />
        {#if tasks.running[ui.distCapId]}
          <span style="font-family: var(--font-mono); font-size: 11px; color: var(--status-info)">● running</span>
        {/if}
      </div>
      <div class="desc">{cap.desc}</div>

      <div class="row gap-2" style="margin-top: 14px; align-items: center">
        <button class="view-tab" class:active={ui.distView === 'compose'} onclick={() => (ui.distView = 'compose')}>Compose</button>
        <button class="view-tab" class:active={ui.distView === 'result'} onclick={() => (ui.distView = 'result')}>
          Last result <span class="dim-id">{lastResultId}</span>
        </button>
        <button class="view-tab" class:active={ui.distView === 'history'} onclick={() => (ui.distView = 'history')}>
          History <span class="dim-id">{historyCountForCap}</span>
        </button>
      </div>
    </div>

    {#if ui.distView === 'compose'}
      <ComposeView
        {cap}
        {selectedNodes}
        {toggle}
        {selectAll}
        {selectNone}
        {invert}
        {dryRun}
        setDryRun={(v) => (dryRun = v)}
        {onSubmit}
        {presetDraft}
        setPresetDraft={(v) => (presetDraft = v)}
        {onSavePreset} />
    {:else if ui.distView === 'result'}
      <ResultView capId={ui.distCapId} />
    {:else}
      <HistoryView onOpen={() => (ui.distView = 'result')} />
    {/if}
  </div>
</div>

<style>
  .view-tab {
    background: transparent;
    border: 1px solid var(--border-default);
    color: var(--fg-secondary);
    font-family: var(--font-sans);
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 3px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .view-tab.active {
    background: var(--bg-base);
    border-color: var(--accent);
    color: var(--accent);
  }
  .dim-id {
    margin-left: 6px;
    color: var(--fg-disabled);
    font-family: var(--font-mono);
    font-size: 10px;
  }
</style>
