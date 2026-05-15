<script lang="ts">
  import { CAPABILITIES, NODES, TASK_RESULT, TASK_HISTORY } from './data';
  import { ui, type Preset } from './ui-state.svelte';
  import CapabilityList from './CapabilityList.svelte';
  import ComposeView from './ComposeView.svelte';
  import ResultView from './ResultView.svelte';
  import HistoryView from './HistoryView.svelte';
  import ChannelBadge from './ChannelBadge.svelte';

  let selectedNodes = $state<Set<string>>(new Set(NODES.filter(n => !n.notManaged).map(n => n.id)));
  let dryRun = $state(false);
  let presetDraft = $state<{ name: string } | null>(null);

  const cap = $derived(CAPABILITIES.find(c => c.id === ui.distCapId) ?? CAPABILITIES[0]);

  function toggle(id: string) {
    const next = new Set(selectedNodes);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedNodes = next;
  }
  function selectAll() { selectedNodes = new Set(NODES.filter(n => !n.notManaged).map(n => n.id)); }
  function selectNone() { selectedNodes = new Set(); }
  function invert() {
    const next = new Set<string>();
    NODES.filter(n => !n.notManaged).forEach(n => {
      if (!selectedNodes.has(n.id)) next.add(n.id);
    });
    selectedNodes = next;
  }

  function onApplyPreset(p: Preset) {
    if (p.steps[0]) { ui.distCapId = p.steps[0]; ui.distView = 'compose'; }
  }

  function onSavePreset(name: string) {
    ui.presets = [...ui.presets, {
      id: 'preset-' + Date.now().toString(36),
      name,
      steps: [cap.id],
      created: new Date().toISOString().slice(0, 10),
    }];
    presetDraft = null;
  }
</script>

<div class="dist" data-screen-label="02 Distribution Center">
  <CapabilityList
    active={ui.distCapId}
    onPick={(id) => { ui.distCapId = id; ui.distView = 'compose'; }}
    presets={ui.presets}
    {onApplyPreset} />

  <div class="cap-pane">
    <div class="cap-header">
      <div class="breadcrumbs">分发中心 · {cap.name}</div>
      <div class="row gap-3" style="align-items: baseline">
        <h1>{cap.name}</h1>
        <span style="font-family: var(--font-mono); font-size: 11px; color: var(--fg-disabled)">{cap.tag.toUpperCase()}</span>
        <ChannelBadge channel={cap.channel} />
      </div>
      <div class="desc">{cap.desc}</div>

      <div class="row gap-2" style="margin-top: 14px; align-items: center">
        <button class="view-tab" class:active={ui.distView === 'compose'} onclick={() => ui.distView = 'compose'}>Compose</button>
        <button class="view-tab" class:active={ui.distView === 'result'} onclick={() => ui.distView = 'result'}>
          Last result <span class="dim-id">{TASK_RESULT[ui.distCapId]?.id ?? '—'}</span>
        </button>
        <button class="view-tab" class:active={ui.distView === 'history'} onclick={() => ui.distView = 'history'}>
          History <span class="dim-id">{TASK_HISTORY.filter(t => t.cap === ui.distCapId).length}</span>
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
        setDryRun={(v) => dryRun = v}
        onSubmit={() => ui.distView = 'result'}
        {presetDraft}
        setPresetDraft={(v) => presetDraft = v}
        {onSavePreset}
      />
    {:else if ui.distView === 'result'}
      <ResultView capId={ui.distCapId} />
    {:else}
      <HistoryView onOpen={() => ui.distView = 'result'} />
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
