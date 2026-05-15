<script lang="ts">
  import { TASK_HISTORY, type HistoryItem } from '$lib/data/mock-nodes';

  interface Props {
    onOpen: (t: HistoryItem) => void;
  }
  let { onOpen }: Props = $props();
</script>

<div class="cap-section">
  <h2>history · all capabilities</h2>
  <div>
    <div class="history-row" style="border-bottom-style: solid; color: var(--fg-disabled); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase">
      <span>id</span><span>summary</span><span>when</span><span>nodes</span><span></span>
    </div>
    {#each TASK_HISTORY as t (t.id)}
      <div class="history-row" role="button" tabindex="0"
        onclick={() => onOpen(t)}
        onkeydown={(e) => { if (e.key === 'Enter') onOpen(t); }}>
        <span class="h-id">{t.id}</span>
        <span class="h-summary">
          <span class="pill">{t.cap.toUpperCase()}</span>
          {t.summary}
        </span>
        <span class="h-when">{t.when}</span>
        <span class="h-stat">
          <span class={t.ok === t.total ? 'ok' : 'bad'}>{t.ok}</span>
          <span style="color: var(--fg-disabled)"> / </span>
          <span>{t.total}</span>
          {#if t.status === 'running'}<span style="margin-left: 6px; color: var(--status-info)">● running</span>{/if}
          {#if t.status === 'partial'}<span style="margin-left: 6px; color: var(--status-warning)">partial</span>{/if}
        </span>
        <span class="h-act">open ›</span>
      </div>
    {/each}
  </div>
</div>
