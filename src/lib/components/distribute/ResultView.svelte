<script lang="ts">
  import { TASK_RESULT, FAIL_DETAIL, NODES } from '$lib/data/mock-nodes';
  import DualStat from '$lib/components/ui/DualStat.svelte';

  interface Props {
    capId: string;
  }
  let { capId }: Props = $props();

  let expandedFail = $state<string | null>(null);

  const task = $derived(TASK_RESULT[capId]);

  const tallies = $derived.by(() => {
    if (!task) return { fail: 0, ok: 0, total: 0, running: false };
    let fail = 0, ok = 0, total = 0;
    let running = false;
    for (const r of task.rows) {
      for (const c of r.cells) {
        total++;
        if (c === 'fail') fail++;
        else if (c === 'ok') ok++;
        if (c === 'run') running = true;
      }
    }
    return { fail, ok, total, running };
  });

  const failedRows = $derived.by(() => {
    if (!task) return [];
    return task.rows
      .map(r => ({ row: r, idx: r.cells.findIndex(c => c === 'fail') }))
      .filter(({ idx }) => idx >= 0);
  });

  const glyphFor: Record<string, string> = {
    ok: '✓', fail: '✗', warn: '!', skip: '–', run: '◐', queue: '·',
  };

  function failDetail(nodeId: string, capId: string, stepName: string) {
    const key = `${nodeId}:${capId}:${stepName.split(' ')[0]}`;
    return FAIL_DETAIL[key] ?? FAIL_DETAIL[`${nodeId}:${capId}:probe`];
  }
</script>

{#if !task}
  <div class="cap-section">no recent task.</div>
{:else}
  <div class="cap-section">
    <div class="row gap-4" style="align-items: baseline">
      <div style="font-family: var(--font-mono); font-size: 13px; color: var(--fg-primary)">{task.name}</div>
      <span style="font-family: var(--font-mono); font-size: 11px; color: var(--fg-tertiary)">
        {task.id} · started {task.startedAt} · {task.elapsed}
      </span>
      <span class="spacer"></span>
      {#if tallies.running}<span style="font-family: var(--font-mono); font-size: 11px; color: var(--status-info)">● running</span>{/if}
      {#if tallies.fail > 0}<button class="icon-btn danger">↻ Retry {tallies.fail} failed</button>{/if}
      <button class="icon-btn">Cancel</button>
      <button class="icon-btn">Export log</button>
    </div>
    <div style="margin-top: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--fg-tertiary)">
      {tallies.ok} ok · <span style="color: var(--status-error)">{tallies.fail} fail</span> · {tallies.total - tallies.ok - tallies.fail} other · total {tallies.total}
    </div>
  </div>

  <div class="cap-section" style="padding-top: 4px">
    {#if tallies.fail > 0}
      <div class="failed-summary">
        <div class="fs-head">
          <span class="fs-icon">●</span>
          <span class="fs-count">{failedRows.length} failed</span>
          <span class="fs-divider">·</span>
          <span class="fs-hint">click a node to open its stderr</span>
          <span class="spacer"></span>
          <button class="icon-btn danger">↻ Retry all failed</button>
        </div>
        <div class="fs-chips">
          {#each failedRows as { row, idx } (row.node)}
            {@const node = NODES.find(n => n.id === row.node)}
            {@const stepName = task.steps[idx]}
            {@const key = `${row.node}:${capId}:${idx}`}
            {@const active = expandedFail === key}
            <button class="fs-chip" class:active onclick={() => expandedFail = active ? null : key}>
              <span class="fs-chip-host">{node?.host ?? row.node}</span>
              <span class="fs-chip-step">{stepName}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
    <div class="trm-wrap">
      <div class="trm">
        <table>
          <thead>
            <tr>
              <th style="text-align: left; padding-left: 10px">node</th>
              {#each task.steps as s (s)}
                <th>{s}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each task.rows as row (row.node)}
              {@const n = NODES.find(nn => nn.id === row.node)}
              {@const hasFail = row.cells.includes('fail')}
              <tr class:failed-row={hasFail}>
                <td class="node">
                  <DualStat mesh={row.mesh} agent={row.agent} size="sm" />
                  <span style="margin-left: 6px">{n?.host ?? row.node}</span>
                </td>
                {#each row.cells as c, i (i)}
                  {@const key = `${row.node}:${capId}:${i}`}
                  {@const isExpanded = expandedFail === key}
                  <td
                    class="cell {c}"
                    class:expanded={isExpanded}
                    onclick={() => {
                      if (c === 'fail') expandedFail = isExpanded ? null : key;
                    }}>
                    <span class="glyph">{glyphFor[c] ?? ''}</span>
                  </td>
                {/each}
              </tr>
              {#if row.failStep != null && expandedFail === `${row.node}:${capId}:${row.failStep}`}
                {@const detail = failDetail(row.node, capId, task.steps[row.failStep])}
                {#if detail}
                  <tr>
                    <td colspan={task.steps.length + 1} style="padding: 4px 10px 10px; background: var(--bg-base)">
                      <div class="fail-detail">
                        <div class="fd-head">
                          <span>{n?.host ?? row.node} · step "{task.steps[row.failStep]}" failed · exit {detail.exit} · {detail.duration}</span>
                          <span>
                            <button class="icon-btn" style="margin-right: 6px">Copy cmd</button>
                            <button class="icon-btn primary">↻ Retry this step</button>
                          </span>
                        </div>
                        <pre>{#each detail.stderr.split('\n') as l, li (li)}<div><span class={l.startsWith('+') ? 'cmd-prefix' : (l.includes('Permission denied') || l.includes('ERROR') || l.startsWith('exit code')) ? 'err-line' : ''}>{l || ' '}</span></div>{/each}</pre>
                      </div>
                    </td>
                  </tr>
                {/if}
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div style="margin-top: 10px; font-family: var(--font-mono); font-size: 11px; color: var(--fg-disabled)">
      click <span style="color: var(--status-error)">✗</span> for the failing command and full stderr · click <span style="color: var(--status-info)">↻</span> to retry only that node-step
    </div>
  </div>
{/if}
