<script lang="ts">
  import type { MeshState, AgentState } from '$lib/data/mock-nodes';
  interface Props {
    mesh: MeshState;
    agent: AgentState;
    size?: 'sm' | 'md' | 'lg';
    title?: string;
  }
  let { mesh, agent, size = 'md', title }: Props = $props();
  let tt = $derived(title ?? `mesh ${mesh} · agent ${agent}`);
</script>

<span class="dual-stat {size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : ''}" title={tt} aria-label={tt}>
  <span class="d-pip mesh-{mesh}"></span>
  <span class="d-pip agent-{agent}"></span>
</span>
