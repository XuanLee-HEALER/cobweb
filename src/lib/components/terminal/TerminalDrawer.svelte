<script lang="ts">
  import { mesh } from "$lib/state/mesh.svelte";
  import { ui, closeTermTab, openSSH } from '$lib/state/ui.svelte';
  import TerminalSession from '$lib/components/terminal/TerminalSession.svelte';
  import TerminalNodePicker from '$lib/components/terminal/TerminalNodePicker.svelte';

  let pickerOpen = $state(false);

  const active = $derived(ui.termSessions.find(s => s.id === ui.termActive) ?? ui.termSessions[0]);
</script>

<div class="term-drawer">
  <div class="term-tabs">
    {#each ui.termSessions as s (s.id)}
      {@const n = mesh.nodes.find(nn => nn.id === s.nodeId)}
      {#if n}
        <div
          class="term-tab"
          class:active={s.id === active?.id}
          role="button"
          tabindex="0"
          onclick={() => ui.termActive = s.id}
          onkeydown={(e) => { if (e.key === 'Enter') ui.termActive = s.id; }}>
          <span class="term-tab-pip term-tab-{s.channel}"></span>
          <span class="term-tab-host">root@{n.host}</span>
          {#if s.disconnected}<span class="term-tab-disc">disconnected</span>{/if}
          <button
            class="term-tab-close"
            onclick={(e) => { e.stopPropagation(); closeTermTab(s.id); }}
            aria-label="Close tab">×</button>
        </div>
      {/if}
    {/each}
    <button
      class="term-tab-add"
      onclick={() => pickerOpen = !pickerOpen}
      disabled={ui.termSessions.length >= 4}
      title={ui.termSessions.length >= 4 ? 'max 4 sessions' : 'Open another SSH session'}>
      +
    </button>
    {#if pickerOpen}
      <TerminalNodePicker
        existing={ui.termSessions.map(s => s.nodeId)}
        onPick={(id) => { pickerOpen = false; openSSH(id); }}
        onClose={() => pickerOpen = false}
      />
    {/if}
    <span class="spacer"></span>
    <span style="display: inline-flex; align-items: center; gap: 8px; padding: 0 10px; color: var(--fg-disabled); font-family: var(--font-mono); font-size: 11px">
      {ui.termSessions.length}/4 sessions
    </span>
    <button class="term-chrome-btn" onclick={() => ui.termOpen = false} title="Hide drawer (esc / `)">▾</button>
  </div>
  {#if active}
    {#key active.id}
      <TerminalSession session={active} />
    {/key}
  {/if}
</div>
