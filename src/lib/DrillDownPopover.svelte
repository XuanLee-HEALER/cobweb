<script lang="ts">
  import type { DrillState } from './ui-state.svelte';
  import { NODES, linkLatency, linkLoss, genSeries } from './data';
  import DualStat from './DualStat.svelte';
  import DrillChart from './DrillChart.svelte';

  interface Props {
    drill: DrillState;
    onClose: () => void;
  }
  let { drill, onClose }: Props = $props();

  let ref = $state<HTMLDivElement | null>(null);

  $effect(() => {
    function off(e: MouseEvent) {
      if (ref && !ref.contains(e.target as Node)) onClose();
    }
    setTimeout(() => window.addEventListener('mousedown', off), 0);
    return () => window.removeEventListener('mousedown', off);
  });

  const a = $derived(NODES.find(n => n.id === drill.aId));
  const b = $derived(NODES.find(n => n.id === drill.bId));
  const baseRtt  = $derived(a && b ? linkLatency(a, b) ?? 0 : 0);
  const baseLoss = $derived(a && b ? linkLoss(a, b) ?? 0 : 0);
  const unreach  = $derived(baseRtt < 0);

  const rtt  = $derived(unreach || !a || !b ? [] : genSeries(`${a.id}-${b.id}-rtt`,  60, Math.max(1, baseRtt * 0.6), baseRtt * 1.6, 0.12));
  const loss = $derived(unreach || !a || !b ? [] : genSeries(`${a.id}-${b.id}-loss`, 60, 0, Math.max(0.3, baseLoss * 2.0 + 0.4), 0.30));

  const W = 540, H = 360;
  const pos = $derived.by(() => {
    const sideEl = document.querySelector('.side, .side-collapsed-strip');
    const sideW = sideEl ? sideEl.getBoundingClientRect().width : 0;
    const vw = window.innerWidth - sideW;
    const vh = window.innerHeight;
    const px = Math.min(Math.max(8, drill.x), vw - W - 8);
    const py = Math.min(Math.max(60, drill.y), vh - H - 40);
    return { px, py };
  });
</script>

{#if a && b}
  <div bind:this={ref} class="drill-pop" style="left: {pos.px}px; top: {pos.py}px; width: {W}px">
    <div class="drill-head">
      <div>
        <div class="drill-eyebrow">link timeline · last 5min</div>
        <div class="drill-title mono">
          <DualStat mesh={a.mesh} agent={a.agent} size="sm" />
          <span style="margin-left: 6px">{a.host}</span>
          <span class="muted" style="margin: 0 8px">→</span>
          <DualStat mesh={b.mesh} agent={b.agent} size="sm" />
          <span style="margin-left: 6px">{b.host}</span>
        </div>
      </div>
      <button class="icon-btn" onclick={onClose}>×</button>
    </div>

    {#if unreach}
      <div class="drill-empty">
        <span style="color: var(--status-error)">unreachable</span>
        <span style="color: var(--fg-tertiary); margin-left: 8px">
          no data — one or both endpoints have mesh offline
        </span>
      </div>
    {:else}
      <div class="drill-grid">
        <DrillChart label="rtt" unit="ms" data={rtt} color="var(--status-info)" warnAt={120} errAt={200} />
        <DrillChart label="loss" unit="%" data={loss} color="var(--status-warning)" warnAt={1.5} errAt={5} decimals={2} />
      </div>
      <div class="drill-foot mono">
        <span>now <span style="color: var(--fg-primary)">{baseRtt}ms / {baseLoss.toFixed(1)}%</span></span>
        <span class="spacer"></span>
        <span style="color: var(--fg-disabled)">tunnel {a.proto}/{b.proto} · cost {a.cost}+{b.cost}</span>
        <span class="spacer"></span>
        <button class="icon-btn">↻ Re-probe</button>
        <button class="icon-btn">Open both →</button>
      </div>
    {/if}
  </div>
{/if}
