<script lang="ts">
  import { CAPABILITIES } from './data';
  import type { Preset } from './ui-state.svelte';
  import ChannelBadge from './ChannelBadge.svelte';

  interface Props {
    active: string;
    onPick: (id: string) => void;
    presets: Preset[];
    onApplyPreset: (p: Preset) => void;
  }
  let { active, onPick, presets, onApplyPreset }: Props = $props();

  const activeCaps = $derived(CAPABILITIES.filter(c => c.group === 'active'));
  const futureCaps = $derived(CAPABILITIES.filter(c => c.group === 'future'));
</script>

<nav class="cap-list">
  {#if presets.length > 0}
    <div class="group-label">Presets</div>
    {#each presets as p (p.id)}
      <button class="cap-item preset" onclick={() => onApplyPreset(p)}>
        <div class="ci-row1">
          <span class="ci-name">{p.name}</span>
          <span class="ci-tag">{p.steps.length}×</span>
        </div>
        <div class="ci-desc">
          {p.steps.map(s => CAPABILITIES.find(x => x.id === s)?.name ?? s).join(' → ')}
        </div>
      </button>
    {/each}
  {/if}
  <div class="group-label">Active</div>
  {#each activeCaps as c (c.id)}
    <button class="cap-item" class:active={active === c.id} onclick={() => onPick(c.id)}>
      <div class="ci-row1">
        <span class="ci-name">{c.name}</span>
        <span class="ci-tag">{c.tag}</span>
      </div>
      <div class="ci-desc">{c.desc}</div>
      {#if c.channel}
        <div style="margin-top: 5px">
          <ChannelBadge channel={c.channel} />
        </div>
      {/if}
    </button>
  {/each}
  <div class="group-label">Future</div>
  {#each futureCaps as c (c.id)}
    <button class="cap-item future" class:active={active === c.id} onclick={() => onPick(c.id)}>
      <div class="ci-row1">
        <span class="ci-name">{c.name}</span>
        <span class="ci-tag">{c.tag}</span>
      </div>
      <div class="ci-desc">{c.desc}</div>
      {#if c.channel}
        <div style="margin-top: 5px">
          <ChannelBadge channel={c.channel} />
        </div>
      {/if}
    </button>
  {/each}
  <div style="padding: 14px; border-top: 1px solid var(--border-subtle); margin-top: 8px">
    <button class="icon-btn" style="width: 100%; justify-content: center; padding: 6px 8px">+ 添加分发能力</button>
  </div>
</nav>
