<script lang="ts">
  import type { Node } from '$lib/data/mock-nodes';
  import { linkLatency } from '$lib/data/mock-nodes';
  import { ui } from '$lib/state/ui.svelte';
  import Matrix from '$lib/components/dashboard/Matrix.svelte';
  import NodeDetailSide from '$lib/components/dashboard/NodeDetailSide.svelte';
  import CollapsedPanel from '$lib/components/dashboard/CollapsedPanel.svelte';
  import Legend from '$lib/components/ui/Legend.svelte';

  interface Props {
    nodes: Node[];
    cellSize: number;
    sidePanel: boolean;
  }
  let { nodes, cellSize, sidePanel }: Props = $props();

  // Pulse token: changes when metric or direction changes; Matrix uses it
  // as a data-pulse attribute so the CSS keyframe re-fires.
  //
  // Derived (not an effect that increments a $state) so we don't read+write
  // the same state inside an effect — that triggers
  // svelte/e/effect_update_depth_exceeded and freezes the whole render.
  const pulseToken = $derived(`${ui.metric}-${ui.direction}`);

  const colH = $derived(Math.max(110, cellSize + 40));
  const selectedNode = $derived(nodes.find(n => n.id === ui.selectedNodeId) ?? null);

  const stats = $derived.by(() => {
    const total = nodes.length;
    const meshOnline = nodes.filter(n => n.mesh === 'online').length;
    const degraded   = nodes.filter(n => n.mesh === 'degraded').length;
    const meshOff    = nodes.filter(n => n.mesh === 'offline').length;
    const agentOnline = nodes.filter(n => n.agent === 'online').length;
    let badLinks = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const ms = linkLatency(nodes[i], nodes[j]);
        if (ms != null && (ms < 0 || ms > 200)) badLinks++;
      }
    }
    return { total, meshOnline, degraded, meshOff, agentOnline, badLinks };
  });

  const lastUpdated = '3s ago';
  const bodyClass = $derived(
    sidePanel && selectedNode
      ? (ui.panelCollapsed ? 'side-collapsed' : '')
      : 'no-side'
  );
</script>

<div class="dash" data-screen-label="01 Dashboard">
  <div class="dash-toolbar">
    <div class="stats mono">
      <span><span class="muted">nodes</span> <span class="num">{stats.total}</span></span>
      <span>
        <span class="muted">mesh</span>
        <span class="num ok">{stats.meshOnline}</span><span class="muted"> · </span>
        <span class="num warn">{stats.degraded}</span><span class="muted"> · </span>
        <span class="num bad">{stats.meshOff}</span>
      </span>
      <span>
        <span class="muted">agent</span>
        <span class="num {stats.agentOnline < stats.total ? 'warn' : 'ok'}">{stats.agentOnline}/{stats.total}</span>
      </span>
      <span><span class="muted">bad links</span> <span class="num bad">{stats.badLinks}</span></span>
    </div>

    <span class="toolbar-sep"></span>

    <div class="metric-switch" role="tablist" aria-label="matrix metric">
      {#each [['latency', '延迟'], ['loss', '丢包'], ['tx', '流量']] as const as [k, label] (k)}
        <button
          class:active={ui.metric === k}
          onclick={() => ui.metric = k}
          role="tab"
          aria-selected={ui.metric === k}>{label.toUpperCase()}</button>
      {/each}
    </div>

    <div
      class="metric-switch"
      role="tablist"
      aria-label="link direction"
      title={ui.metric === 'latency'
        ? 'direction · A→B shows asymmetric latency, A↔B averages'
        : 'direction · only affects latency in this mock'}
      style="opacity: {ui.metric === 'latency' ? 1 : 0.45}">
      {#each [['sym', 'A↔B'], ['ab', 'A→B']] as const as [k, label] (k)}
        <button
          class:active={ui.direction === k}
          onclick={() => ui.direction = k}
          role="tab"
          aria-selected={ui.direction === k}
          disabled={ui.metric !== 'latency'}>{label}</button>
      {/each}
    </div>

    <span class="spacer"></span>

    <button class="icon-btn">
      <span style="opacity: 0.7">↻</span> {lastUpdated}
    </button>
  </div>

  <div class="dash-body {bodyClass}">
    <div class="matrix-region">
      <Matrix
        {nodes}
        metric={ui.metric}
        direction={ui.direction}
        {pulseToken}
        {cellSize}
        {colH}
        selectedId={ui.selectedNodeId} />
      <!-- block wrapper forces the inline-flex legend onto its own line,
           so it sits beneath the matrix even when the matrix is narrow. -->
      <div class="legend-wrap">
        <Legend metric={ui.metric} />
      </div>
    </div>
    {#if sidePanel && selectedNode}
      {#if ui.panelCollapsed}
        <CollapsedPanel node={selectedNode} onExpand={() => ui.panelCollapsed = false} />
      {:else}
        <NodeDetailSide node={selectedNode} onCollapse={() => ui.panelCollapsed = true} />
      {/if}
    {/if}
  </div>
</div>
