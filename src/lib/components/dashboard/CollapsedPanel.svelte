<script lang="ts">
  import type { Node } from '$lib/data/mock-nodes';
  import DualStat from '$lib/components/ui/DualStat.svelte';

  interface Props {
    node: Node;
    onExpand: () => void;
  }
  let { node, onExpand }: Props = $props();
</script>

<aside
  class="side-collapsed-strip"
  role="button"
  tabindex="0"
  onclick={onExpand}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onExpand(); }}
  title="Expand node detail"
  aria-label={`expand panel for ${node.host}`}>
  <span class="scs-chev">‹</span>
  <DualStat mesh={node.mesh} agent={node.agent} size="sm" />
  <span class="scs-host">{node.host}</span>
  <span class="scs-meta">node detail</span>
</aside>
