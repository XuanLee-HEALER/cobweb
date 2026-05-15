<script lang="ts">
  import type { CtxMenuState } from './ui-state.svelte';

  interface Props {
    menu: CtxMenuState;
    onClose: () => void;
  }
  let { menu, onClose }: Props = $props();
  let ref = $state<HTMLDivElement | null>(null);

  $effect(() => {
    function off(e: MouseEvent) {
      if (ref && !ref.contains(e.target as Node)) onClose();
    }
    window.addEventListener('mousedown', off);
    window.addEventListener('contextmenu', off);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('contextmenu', off);
    };
  });

  const pos = $derived.by(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const px = Math.min(menu.x, vw - 260);
    const py = Math.min(menu.y, vh - (menu.items.length * 28 + 8));
    return { px, py };
  });
</script>

<div
  bind:this={ref}
  class="ctx-menu"
  style="left: {pos.px}px; top: {pos.py}px"
  onclick={(e) => e.stopPropagation()}
  role="menu"
  tabindex="-1">
  {#each menu.items as it, i (i)}
    {#if it.divider}
      <div class="ctx-divider"></div>
    {:else}
      <button
        class="ctx-item"
        class:danger={it.danger}
        disabled={it.disabled}
        onclick={() => { if (!it.disabled && it.onClick) { it.onClick(); onClose(); } }}>
        <span class="ctx-label">{it.label}</span>
        {#if it.sub}<span class="ctx-sub">{it.sub}</span>{/if}
        {#if it.hint}<span class="ctx-hint">{it.hint}</span>{/if}
      </button>
    {/if}
  {/each}
</div>
