<script lang="ts">
  import { tasks, type TaskResult } from '$lib/state/tasks.svelte';

  interface Props {
    onOpen: (t: TaskResult) => void;
  }
  let { onOpen }: Props = $props();

  function capTag(name: string): string {
    if (name.startsWith('CA ')) return 'CA';
    if (name.startsWith('DNS ')) return 'DNS';
    if (name.startsWith('SSH key')) return 'SSH';
    return 'TASK';
  }
  function okCount(t: TaskResult): number {
    return t.rows.reduce(
      (acc, r) => acc + r.cells.filter((c) => c === 'ok').length,
      0,
    );
  }
  function totalCells(t: TaskResult): number {
    return t.rows.reduce((acc, r) => acc + r.cells.length, 0);
  }
  function hasFail(t: TaskResult): boolean {
    return t.rows.some((r) => r.cells.includes('fail'));
  }
</script>

<div class="cap-section">
  <h2>history · all capabilities</h2>
  {#if tasks.history.length === 0}
    <div style="font-family: var(--font-mono); font-size: 12px; color: var(--fg-disabled); padding: 12px 0">
      no tasks yet. results show up here after you submit from Compose.
    </div>
  {:else}
    <div class="history-row" style="border-bottom-style: solid; color: var(--fg-disabled); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase">
      <span>id</span><span>summary</span><span>when</span><span>nodes</span><span></span>
    </div>
    {#each tasks.history as t (t.id)}
      {@const ok = okCount(t)}
      {@const total = totalCells(t)}
      {@const failed = hasFail(t)}
      <div class="history-row" role="button" tabindex="0"
        onclick={() => onOpen(t)}
        onkeydown={(e) => { if (e.key === 'Enter') onOpen(t); }}>
        <span class="h-id">{t.id}</span>
        <span class="h-summary">
          <span class="pill">{capTag(t.name)}</span>
          {t.name}
        </span>
        <span class="h-when">{t.finishedAt}</span>
        <span class="h-stat">
          <span class={failed ? 'bad' : 'ok'}>{ok}</span>
          <span style="color: var(--fg-disabled)"> / </span>
          <span>{total}</span>
          {#if failed}<span style="margin-left: 6px; color: var(--status-warning)">partial</span>{/if}
        </span>
        <span class="h-act">open ›</span>
      </div>
    {/each}
  {/if}
</div>
