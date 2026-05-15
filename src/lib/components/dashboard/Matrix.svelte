<script lang="ts">
  import type { Node } from '$lib/data/mock-nodes';
  import {
    linkLatency, linkLatencyDir, linkLoss, linkTx,
    latencyQ, lossQ, txQ, fmtLatency, fmtLoss, fmtTx, hashPair,
  } from '$lib/data/mock-nodes';
  import type { Metric, Direction } from '$lib/state/ui.svelte';
  import { ui, selectNode, openContextMenu, openDrill } from '$lib/state/ui.svelte';
  import { cellMenuItems, nodeMenuItems } from '$lib/menu-builders';
  import DualStat from '$lib/components/ui/DualStat.svelte';
  import CellTooltip from '$lib/components/ui/CellTooltip.svelte';

  interface Props {
    nodes: Node[];
    metric: Metric;
    direction: Direction;
    pulseToken: number;
    cellSize: number;
    colH: number;
    selectedId: string | null;
  }
  let { nodes, metric, direction, pulseToken, cellSize, colH, selectedId }: Props = $props();

  type Tip = { x: number; y: number; a: Node; b: Node; ms: number; loss: number; tx: number };
  let tip = $state<Tip | null>(null);

  function metricFn(a: Node, b: Node): number | null {
    if (metric === 'latency') {
      return direction === 'ab' ? linkLatencyDir(a, b, 'ab') : linkLatency(a, b);
    }
    if (metric === 'loss') return linkLoss(a, b);
    return linkTx(a, b);
  }
  function metricQ(v: number | null) {
    if (metric === 'latency') return latencyQ(v);
    if (metric === 'loss')    return lossQ(v);
    return txQ(v);
  }
  function metricFmt(v: number | null): string {
    if (metric === 'latency') return fmtLatency(v);
    if (metric === 'loss')    return fmtLoss(v);
    return fmtTx(v);
  }
  function unit(): string {
    if (metric === 'latency') return 'ms';
    if (metric === 'loss')    return '%';
    return 'mb';
  }
  function cornerLabel(): string {
    if (metric === 'latency') return 'rtt · ms';
    if (metric === 'loss')    return 'loss · %';
    return 'tx · mb/s';
  }

  const style = $derived(
    `grid-template-columns: 140px repeat(${nodes.length}, ${cellSize}px);` +
    `grid-template-rows: ${colH}px repeat(${nodes.length}, ${cellSize}px);` +
    `--cell-size: ${cellSize}px; --col-h: ${colH}px;`
  );

  function trendFor(rowNode: Node, colNode: Node): 'up' | 'down' | null {
    const h = hashPair(rowNode.id, colNode.id);
    if (h % 13 === 0) return 'up';
    if (h % 17 === 0) return 'down';
    return null;
  }

  function openCellMenu(e: MouseEvent, rowNode: Node, colNode: Node) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY, items: cellMenuItems(rowNode, colNode) });
  }
  function openNodeMenu(e: MouseEvent, node: Node) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY, items: nodeMenuItems(node) });
  }

  function onCellEnter(e: MouseEvent, a: Node, b: Node, isDiag: boolean) {
    if (isDiag) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    tip = {
      x: rect.left + rect.width / 2,
      y: rect.top,
      a, b,
      ms: linkLatency(a, b) ?? 0,
      loss: linkLoss(a, b) ?? 0,
      tx: linkTx(a, b) ?? 0,
    };
  }
  function onCellLeave() { tip = null; }

  function onCellClick(e: MouseEvent, rowNode: Node, colNode: Node, isDiag: boolean) {
    if (isDiag) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    tip = null;
    openDrill({
      aId: rowNode.id, bId: colNode.id,
      x: rect.right + 12, y: rect.top - 40,
    });
  }
</script>

<div class="matrix" data-pulse={pulseToken} style={style}>
  <div class="mx-corner">
    <span class="mx-corner-tag">{cornerLabel()}</span>
  </div>
  {#each nodes as n, j (n.id)}
    <div
      class="mx-col-head"
      class:selected={selectedId === n.id}
      style="grid-column: {j + 2}; grid-row: 1"
      role="button"
      tabindex="0"
      onclick={() => selectNode(n.id)}
      oncontextmenu={(e) => openNodeMenu(e, n)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectNode(n.id); }}
    >
      <DualStat mesh={n.mesh} agent={n.agent} size="sm" />
      <span class="label">{n.host}</span>
    </div>
  {/each}
  {#each nodes as rowNode, i (rowNode.id)}
    <div
      class="mx-row-head"
      class:selected={selectedId === rowNode.id}
      style="grid-column: 1; grid-row: {i + 2}"
      role="button"
      tabindex="0"
      onclick={() => selectNode(rowNode.id)}
      oncontextmenu={(e) => openNodeMenu(e, rowNode)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectNode(rowNode.id); }}
    >
      <DualStat mesh={rowNode.mesh} agent={rowNode.agent} size="sm" />
      <span class="host">{rowNode.host}</span>
      <span class="spacer"></span>
      <span class="meta">{rowNode.cost}</span>
    </div>
    {#each nodes as colNode, j (colNode.id)}
      {@const isDiag = i === j}
      {@const v = isDiag ? null : metricFn(rowNode, colNode)}
      {@const q = isDiag ? null : metricQ(v)}
      {@const unreach = q === 'unreach'}
      {@const rowHl = selectedId === rowNode.id}
      {@const colHl = selectedId === colNode.id}
      {@const crossHl = rowHl && colHl}
      {@const valText = isDiag ? '' : (unreach ? '×' : metricFmt(v))}
      {@const trend = isDiag || unreach ? null : trendFor(rowNode, colNode)}
      <div
        class="mx-cell"
        class:diag={isDiag}
        class:unreach
        class:q0={q === 'q0'}
        class:q1={q === 'q1'}
        class:q2={q === 'q2'}
        class:q3={q === 'q3'}
        class:q4={q === 'q4'}
        class:q5={q === 'q5'}
        class:row-hl={rowHl && !crossHl}
        class:col-hl={colHl && !crossHl}
        class:cross-hl={crossHl}
        style="grid-column: {j + 2}; grid-row: {i + 2}"
        role={isDiag ? undefined : 'button'}
        tabindex={isDiag ? undefined : 0}
        onmouseenter={(e) => onCellEnter(e, rowNode, colNode, isDiag)}
        onmouseleave={onCellLeave}
        onclick={(e) => onCellClick(e, rowNode, colNode, isDiag)}
        oncontextmenu={(e) => openCellMenu(e, rowNode, colNode)}
      >
        {#if !isDiag}
          <span class="v">{valText}</span>
          {#if !unreach}<span class="u">{unit()}</span>{/if}
          {#if trend}<span class="trend {trend}">{trend === 'up' ? '↑' : '↓'}</span>{/if}
        {/if}
      </div>
    {/each}
  {/each}
</div>

{#if tip}
  <CellTooltip {...tip} />
{/if}
