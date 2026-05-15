<script lang="ts">
  import { NODES } from '$lib/data/mock-nodes';
  import { ui } from '$lib/state/ui.svelte';

  interface Props {
    onOpenCmdk: () => void;
  }
  let { onOpenCmdk }: Props = $props();

  const agentHealth = $derived.by(() => {
    const managed = NODES.filter(n => !n.notManaged);
    const online = managed.filter(n => n.agent === 'online').length;
    const total = managed.length;
    return { online, total, healthy: online === total };
  });
</script>

<header class="topbar">
  <div class="brand">
    <div class="brand-mark"></div>
    <div>
      <div class="brand-name">cobweb<span class="dot">·</span><span style="color: var(--fg-tertiary)">private mesh</span></div>
      <div class="brand-sub">easytier · ethub · v0.2.3</div>
    </div>
  </div>

  <div class="tabs">
    <button class="tab" class:active={ui.module === 'dashboard'} onclick={() => ui.module = 'dashboard'}>
      Dashboard <kbd>g d</kbd>
    </button>
    <button class="tab" class:active={ui.module === 'distribute'} onclick={() => ui.module = 'distribute'}>
      分发中心 <kbd>g s</kbd>
    </button>
  </div>

  <div class="topbar-right">
    <span class="live-indicator">
      <span class="pulse-dot"></span>
      <span>sse · ok</span>
    </span>
    <span class="agent-pill"
      class:healthy={agentHealth.healthy}
      title={`${agentHealth.online} of ${agentHealth.total} managed nodes have a live agent heartbeat`}>
      <span class="agent-dot" class:warn={!agentHealth.healthy}></span>
      agents <span style="font-variant-numeric: tabular-nums">{agentHealth.online}/{agentHealth.total}</span>
    </span>
    <span>updated 3s ago</span>
    {#if ui.termSessions.length > 0}
      <button
        class="icon-btn"
        class:primary={ui.termOpen}
        onclick={() => ui.termOpen = !ui.termOpen}
        title="Toggle terminal drawer (`)">
        <span style="font-family: var(--font-mono)">›_</span>
        <span style="margin-left: 4px">{ui.termSessions.length}</span>
      </button>
    {/if}
    <button class="icon-btn" onclick={onOpenCmdk}>
      ⌘ K <span style="color: var(--fg-disabled); margin-left: 6px">command</span>
    </button>
  </div>

  {#if ui.gPrefix}
    <div class="g-hint">
      <span style="color: var(--accent)">g</span> _ &nbsp;
      <span style="color: var(--fg-disabled)">then d (Dashboard) · s (分发)</span>
    </div>
  {/if}
</header>

<style>
  .agent-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    height: 22px;
    border: 1px solid rgba(159, 112, 69, 0.45);
    border-radius: 3px;
    background: rgba(159, 112, 69, 0.10);
    color: var(--status-warning);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .agent-pill.healthy {
    border-color: var(--border-default);
    background: transparent;
    color: var(--fg-secondary);
  }
  .agent-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--status-info);
  }
  .agent-dot.warn { opacity: 0.55; }
  .g-hint {
    position: absolute;
    top: 44px;
    left: calc(50% - 60px);
    background: var(--bg-deepest);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 6px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-secondary);
    z-index: 80;
  }
</style>
