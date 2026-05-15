<script lang="ts">
  import type { Metric } from '$lib/state/ui.svelte';
  interface Props { metric: Metric; }
  let { metric }: Props = $props();

  const LABELS: Record<Metric, string[]> = {
    latency: ['<10', '<30', '<80', '<160', '<240', '≥240', 'down'],
    loss:    ['0',   '<.5', '<1.5','<3',  '<6',   '≥6',   'down'],
    tx:      ['>800','>500','>200','>100','>40',  '≤40',  'down'],
  };
  const u = $derived(metric === 'latency' ? 'ms' : metric === 'loss' ? '%' : 'mb/s');
  const labels = $derived(LABELS[metric]);
</script>

<div class="legend">
  <span style="margin-right: 8px">{u}</span>
  <span class="swatches">
    <span class="sw" style="background: var(--link-q0)" title={labels[0]}></span>
    <span class="sw" style="background: var(--link-q1)" title={labels[1]}></span>
    <span class="sw" style="background: var(--link-q2)" title={labels[2]}></span>
    <span class="sw" style="background: var(--link-q3)" title={labels[3]}></span>
    <span class="sw" style="background: var(--link-q4)" title={labels[4]}></span>
    <span class="sw" style="background: var(--link-q5)" title={labels[5]}></span>
  </span>
  <span style="margin-left: 4px">{labels[0]}</span>
  <span style="flex: 1"></span>
  <span style="margin: 0 6px">{labels[5]}</span>
  <span style="margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--border-subtle)">
    <span class="sw" style="background: var(--link-unreach); vertical-align: middle; display: inline-block; margin-right: 4px"></span>
    {labels[6]}
  </span>
</div>
