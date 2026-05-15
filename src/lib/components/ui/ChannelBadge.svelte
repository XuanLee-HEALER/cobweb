<script lang="ts">
  import type { Channel } from '$lib/data/mock-nodes';
  interface Props {
    channel: Channel | 'fallback' | 'via-ssh' | null | undefined;
    label?: string;
  }
  let { channel, label }: Props = $props();

  const cfg = $derived.by(() => {
    if (!channel) return null;
    if (channel === 'agent')        return { cls: 'via-agent', txt: 'via agent exec' };
    if (channel === 'ssh')          return { cls: 'via-ssh',   txt: 'via ssh' };
    if (channel === 'agent-or-ssh') return { cls: 'via-agent', txt: 'agent · ssh fallback' };
    if (channel === 'fallback')     return { cls: 'fallback',  txt: 'via ssh · agent offline' };
    if (channel === 'via-ssh')      return { cls: 'via-ssh',   txt: 'via ssh' };
    return null;
  });
</script>

{#if cfg}
  <span class="channel-badge {cfg.cls}">{label ?? cfg.txt}</span>
{/if}
