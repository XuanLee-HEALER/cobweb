<script lang="ts">
  interface Props {
    label: string;
    unit: string;
    data: number[];
    color: string;
    warnAt: number;
    errAt: number;
    decimals?: number;
  }
  let { label, unit, data, color, warnAt, errAt, decimals = 0 }: Props = $props();

  const w = 500, h = 110;

  const layout = $derived.by(() => {
    if (data.length === 0) return null;
    const lo = 0;
    const hi = Math.max(...data, errAt * 1.05);
    const range = (hi - lo) || 1;
    const stepX = (w - 8) / (data.length - 1);
    const pts = data.map((v, i) => {
      const x = 4 + i * stepX;
      const y = h - 4 - ((v - lo) / range) * (h - 8);
      return [x, y, v] as const;
    });
    const path = pts.map(([x, y], i) => i === 0 ? `M${x},${y}` : `L${x},${y}`).join(' ');
    const fillPath = `${path} L${pts[pts.length - 1][0]},${h - 4} L${pts[0][0]},${h - 4} Z`;
    const warnY = h - 4 - ((warnAt - lo) / range) * (h - 8);
    const errY  = h - 4 - ((errAt  - lo) / range) * (h - 8);
    const last = data[data.length - 1];
    const lastClass = last > errAt ? 'err' : last > warnAt ? 'warn' : 'ok';
    return { pts, path, fillPath, warnY, errY, last, lastClass };
  });
</script>

{#if layout}
  <div class="drill-chart">
    <div class="drill-chart-head">
      <span class="dch-label">{label}</span>
      <span class="spacer"></span>
      <span class="dch-value dch-{layout.lastClass}">
        {layout.last.toFixed(decimals)} <span style="color: var(--fg-tertiary)">{unit}</span>
      </span>
    </div>
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style="width: 100%">
      <line x1="0" x2={w} y1={layout.warnY} y2={layout.warnY} stroke="var(--status-warning)" stroke-width="1" stroke-dasharray="3 3" opacity="0.35" />
      <line x1="0" x2={w} y1={layout.errY}  y2={layout.errY}  stroke="var(--status-error)"   stroke-width="1" stroke-dasharray="3 3" opacity="0.35" />
      <path d={layout.fillPath} fill={color} opacity="0.12" />
      <path d={layout.path} fill="none" stroke={color} stroke-width="1.25" />
      <circle cx={layout.pts[layout.pts.length - 1][0]} cy={layout.pts[layout.pts.length - 1][1]} r="2.5" fill={color} />
    </svg>
    <div class="drill-x-axis mono">
      <span>5m ago</span>
      <span class="spacer"></span>
      <span>now</span>
    </div>
  </div>
{/if}
