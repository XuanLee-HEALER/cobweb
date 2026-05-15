<script lang="ts">
  import { NODES } from '$lib/data/mock-nodes';
  import DualStat from '$lib/components/ui/DualStat.svelte';

  interface Props {
    existing: string[];
    onPick: (id: string) => void;
    onClose: () => void;
  }
  let { existing, onPick, onClose }: Props = $props();

  let ref = $state<HTMLDivElement | null>(null);

  $effect(() => {
    function off(e: MouseEvent) {
      if (ref && !ref.contains(e.target as Node)) onClose();
    }
    setTimeout(() => window.addEventListener('mousedown', off), 0);
    return () => window.removeEventListener('mousedown', off);
  });

  const nodes = $derived(NODES.filter(n => !n.notManaged));
</script>

<div bind:this={ref} class="term-picker">
  <div class="term-picker-head">open session on…</div>
  {#each nodes as n (n.id)}
    {@const channel = n.agent === 'online' ? 'agent' : (n.mesh !== 'offline' ? 'ssh' : null)}
    {@const open = existing.includes(n.id)}
    <button class="term-picker-item" disabled={!channel} onclick={() => onPick(n.id)}>
      <DualStat mesh={n.mesh} agent={n.agent} size="sm" />
      <span class="tp-host">{n.host}</span>
      {#if open}<span class="tp-open">open</span>{/if}
      <span class="spacer"></span>
      {#if channel === 'agent'}<span class="channel-badge via-agent">via agent</span>{/if}
      {#if channel === 'ssh'}<span class="channel-badge fallback">via ssh</span>{/if}
      {#if !channel}<span class="channel-badge" style="color: var(--fg-disabled)">unreachable</span>{/if}
    </button>
  {/each}
</div>
