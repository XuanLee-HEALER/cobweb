<script lang="ts">
  interface Props {
    data: number[];
    color?: string;
    fill?: boolean;
    w?: number;
    h?: number;
    label?: string;
    value?: string;
    max?: number;
  }
  let { data, color = 'var(--accent)', fill = true, w = 130, h = 32, label, value, max }: Props = $props();

  const computed = $derived.by(() => {
    if (!data || data.length === 0) return null;
    const lo = Math.min(...data);
    const hi = max ?? Math.max(...data);
    const range = (hi - lo) || 1;
    const stepX = (w - 2) / (data.length - 1);
    const pts: [number, number][] = data.map((v, i) => {
      const x = 1 + i * stepX;
      const y = h - 1 - ((v - lo) / range) * (h - 2);
      return [x, y];
    });
    const path = pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
    const fillPath = `${path} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
    return { path, fillPath };
  });
</script>

{#if computed}
  <div class="sparkline">
    <div class="sl-head">
      <span class="sl-label">{label}</span>
      <span class="sl-value" style:color>{value}</span>
    </div>
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {#if fill}
        <path d={computed.fillPath} fill={color} opacity="0.16" />
      {/if}
      <path d={computed.path} fill="none" stroke={color} stroke-width="1" />
    </svg>
  </div>
{/if}
