<script lang="ts">
  import type { Node } from './data';
  import { genSeries } from './data';
  import Sparkline from './Sparkline.svelte';

  interface Props { node: Node; }
  let { node }: Props = $props();

  const series = $derived.by(() => {
    if (node.agent !== 'online') return null;
    const seed = node.id;
    const rx  = genSeries(seed + ':rx',  60, 0.4, node.region === 'home-bj' ? 80 : 24,  0.18);
    const tx  = genSeries(seed + ':tx',  60, 0.4, node.region === 'home-bj' ? 60 : 18,  0.18);
    const cpu = genSeries(seed + ':cpu', 60, 1,   node.mesh === 'degraded' ? 78 : 38,    0.16);
    const mem = genSeries(seed + ':mem', 60, 40,  72,                                    0.04);
    return { rx, tx, cpu, mem };
  });

  function last(a: number[]) { return a[a.length - 1]; }
</script>

{#if !series}
  <div class="metrics-empty">no data — agent offline, metrics not available</div>
{:else}
  <div class="metrics-grid">
    <Sparkline data={series.rx}  color="var(--status-info)"    label="rx"  value={last(series.rx).toFixed(1) + ' mb/s'} />
    <Sparkline data={series.tx}  color="var(--status-success)" label="tx"  value={last(series.tx).toFixed(1) + ' mb/s'} />
    <Sparkline data={series.cpu} color="var(--accent)"         label="cpu" value={last(series.cpu).toFixed(0) + ' %'} max={100} />
    <Sparkline data={series.mem} color="var(--sakya-p-metok)"  label="mem" value={last(series.mem).toFixed(0) + ' %'} max={100} />
  </div>
{/if}

<style>
  .metrics-empty {
    padding: 14px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-disabled);
    background: var(--bg-deepest);
    border: 1px dashed var(--border-subtle);
    border-radius: 3px;
    text-align: center;
  }
</style>
