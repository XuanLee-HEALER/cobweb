<script lang="ts">
  import { NODES } from '$lib/data/mock-nodes';
  import { ui, type TermSession, type TermLine } from '$lib/state/ui.svelte';
  import { runMockCommand, makeInitTerminalLines } from '$lib/data/terminal-mock';

  interface Props { session: TermSession; }
  let { session }: Props = $props();

  let input = $state('');
  let histIdx = $state(-1);
  let scrollRef = $state<HTMLDivElement | null>(null);
  let inputRef = $state<HTMLInputElement | null>(null);

  const node = $derived(NODES.find(n => n.id === session.nodeId));

  $effect(() => {
    // re-run on lines change → scroll to bottom
    session.lines;
    if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
  });

  $effect(() => {
    // autofocus when session changes
    session.id;
    inputRef?.focus();
  });

  function updateSession(fn: (s: TermSession) => TermSession) {
    const idx = ui.termSessions.findIndex(s => s.id === session.id);
    if (idx < 0) return;
    ui.termSessions = [...ui.termSessions.slice(0, idx), fn(ui.termSessions[idx]), ...ui.termSessions.slice(idx + 1)];
  }

  function commitCommand() {
    if (!node) return;
    const cmd = input;
    input = '';
    histIdx = -1;
    updateSession(s => {
      const echo: TermLine = { kind: 'prompt', text: `root@${node.host}:${s.cwd || '~'}$ `, cmd };
      const result = runMockCommand(cmd, node, s.cwd || '~');
      const nextHistory = cmd.trim() && cmd !== s.history[s.history.length - 1] ? [...s.history, cmd] : s.history;
      const baseLines = result.clear ? [] : s.lines;
      const nextLines: TermLine[] = [...baseLines, echo, ...result.out];
      return {
        ...s,
        lines: nextLines,
        history: nextHistory,
        cwd: result.cwd ?? s.cwd,
        disconnected: result.disconnect ? true : s.disconnected,
      };
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (session.disconnected) return;
    if (e.key === 'Enter') { e.preventDefault(); commitCommand(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const h = session.history;
      if (h.length === 0) return;
      const next = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1);
      histIdx = next;
      input = h[next];
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const h = session.history;
      if (histIdx < 0) return;
      const next = histIdx + 1;
      if (next >= h.length) { histIdx = -1; input = ''; }
      else { histIdx = next; input = h[next]; }
      return;
    }
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      updateSession(s => ({ ...s, lines: [] }));
      return;
    }
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (!node) return;
      const echo: TermLine = {
        kind: 'prompt',
        text: `root@${node.host}:${session.cwd || '~'}$ `,
        cmd: input + '^C',
      };
      updateSession(s => ({ ...s, lines: [...s.lines, echo] }));
      input = '';
      return;
    }
    if (e.key === 'd' && e.ctrlKey && input === '') {
      e.preventDefault();
      if (!node) return;
      updateSession(s => ({
        ...s,
        lines: [
          ...s.lines,
          { kind: 'sys-dim', text: 'logout' },
          { kind: 'sys-dim', text: `Connection to ${node.host} closed.` },
        ],
        disconnected: true,
      }));
    }
  }

  function reconnect() {
    if (!node) return;
    updateSession(s => ({ ...s, disconnected: false, lines: makeInitTerminalLines(node, s.channel) }));
  }
</script>

{#if node}
  <div class="term-body" bind:this={scrollRef}>
    {#each session.lines as line, i (i)}
      {#if line.kind === 'prompt'}
        <div class="term-line term-prompt-line">
          <span class="term-prompt-echo">{line.text}</span>
          <span class="term-cmd-echo">{line.cmd}</span>
        </div>
      {:else}
        <div class="term-line term-{line.kind}">{line.text || ' '}</div>
      {/if}
    {/each}

    {#if session.disconnected}
      <div class="term-disconnected">
        <span style="color: var(--status-error)">disconnected</span>
        <span style="margin-left: 12px; color: var(--fg-tertiary)">session closed · press ↻ to reconnect</span>
        <button class="icon-btn primary" style="margin-left: 12px" onclick={reconnect}>↻ Reconnect</button>
      </div>
    {:else}
      <div class="term-input-line">
        <span class="term-prompt">
          <span class="term-user">root</span><span class="term-at">@</span><span class="term-host">{node.host}</span><span class="term-colon">:</span><span class="term-cwd">{session.cwd || '~'}</span><span class="term-dollar">$ </span>
        </span>
        <input
          bind:this={inputRef}
          class="term-input"
          value={input}
          oninput={(e) => input = e.currentTarget.value}
          onkeydown={onKeyDown}
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
        />
        <span class="term-cursor" aria-hidden="true"></span>
      </div>
    {/if}

    <div class="term-foot mono">
      <span class="channel-badge {session.channel === 'agent' ? 'via-agent' : 'fallback'}">
        {session.channel === 'agent' ? 'via agent exec' : 'via ssh fallback'}
      </span>
      <span style="margin-left: 10px">{node.ip}</span>
      <span class="spacer"></span>
      <span style="color: var(--fg-disabled)">↑↓ history · ⌃C interrupt · ⌃L clear · ⌃D logout</span>
    </div>
  </div>
{/if}
