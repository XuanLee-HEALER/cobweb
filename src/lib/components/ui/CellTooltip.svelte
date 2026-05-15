<script lang="ts">
  import type { Node } from '$lib/data/mock-nodes';

  interface Props {
    x: number;
    y: number;
    a: Node;
    b: Node;
    ms: number;
    loss: number;
    tx: number;
  }
  let { x, y, a, b, ms, loss, tx }: Props = $props();

  const colorOf = (s: 'ok' | 'warn' | 'bad' | 'muted') => ({
    ok: 'var(--status-success)',
    warn: 'var(--status-warning)',
    bad: 'var(--status-error)',
    muted: 'var(--fg-secondary)',
  })[s];

  const isUnreach = $derived(ms < 0);
  const rttStatus = $derived<'ok' | 'warn' | 'bad'>(ms > 200 ? 'bad' : ms > 80 ? 'warn' : 'ok');
  const lossStatus = $derived<'ok' | 'warn' | 'bad'>(loss > 3 ? 'bad' : loss > 1 ? 'warn' : 'ok');
</script>

<div class="cell-tooltip" style="left: {x}px; top: {y - 6}px">
  <div class="cell-tooltip-head">
    <span>{a.host}</span><span>→</span><span>{b.host}</span>
  </div>
  {#if isUnreach}
    <div style="color: var(--status-error)">unreachable · last seen 4h12m ago</div>
  {:else}
    <div class="row"><span class="k">rtt</span><span class="v" style:color={colorOf(rttStatus)}>{ms} ms</span></div>
    <div class="row"><span class="k">loss</span><span class="v" style:color={colorOf(lossStatus)}>{loss.toFixed(1)} %</span></div>
    <div class="row"><span class="k">tx</span><span class="v" style:color={colorOf('muted')}>{tx} mb/s</span></div>
    <div class="row"><span class="k">proto</span><span class="v" style:color={colorOf('muted')}>{a.proto}/{b.proto}</span></div>
  {/if}
</div>

<style>
  .cell-tooltip {
    position: fixed;
    transform: translate(-50%, -100%);
    background: var(--bg-deepest);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-primary);
    pointer-events: none;
    z-index: 50;
    min-width: 200px;
    box-shadow: var(--shadow-2);
  }
  .cell-tooltip-head {
    display: flex;
    gap: 6px;
    color: var(--fg-tertiary);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 1px 0;
  }
  .row .k { color: var(--fg-tertiary); }
  .row .v { font-variant-numeric: tabular-nums; }
</style>
