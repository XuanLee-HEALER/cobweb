<script lang="ts">
  import { NODES } from '$lib/data/mock-nodes';
  import { ui, openSSH, selectNode } from '$lib/state/ui.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  let q = $state('');
  let active = $state(0);
  let inputRef = $state<HTMLInputElement | null>(null);

  $effect(() => { inputRef?.focus(); });

  type Item = {
    cat: string;
    name: string;
    kind: string;
    sub?: string;
    keys?: string[];
  };

  const items = $derived.by<Item[]>(() => {
    const cmds: Item[] = [
      { cat: 'go', name: 'Go to Dashboard', kind: 'mod:dashboard',  keys: ['g', 'd'] },
      { cat: 'go', name: 'Go to 分发中心',  kind: 'mod:distribute', keys: ['g', 's'] },
    ];
    const nodeCmds: Item[] = NODES.map(n => ({
      cat: 'node', name: `Open node · ${n.host}`, kind: 'node:' + n.id, sub: `${n.ip} · ${n.os}`,
    }));
    const sshCmds: Item[] = NODES
      .filter(n => !n.notManaged && !(n.mesh === 'offline' && n.agent === 'offline'))
      .map(n => ({
        cat: 'ssh', name: `Open SSH · ${n.host}`, kind: 'ssh:' + n.id,
        sub: n.agent === 'online' ? 'via agent' : 'via ssh fallback',
      }));
    const actionCmds: Item[] = [
      { cat: 'task', name: 'New CA trust distribution', kind: 'cap:ca' },
      { cat: 'task', name: 'New DNS push',              kind: 'cap:dns' },
      { cat: 'task', name: 'New SSH key rotation',      kind: 'cap:ssh' },
      { cat: 'sys',  name: 'Restart SSE listener',      kind: 'sys:sse' },
    ];
    const all: Item[] = [...cmds, ...nodeCmds, ...sshCmds, ...actionCmds];
    const qq = q.trim().toLowerCase();
    if (!qq) return all;
    return all.filter(i => i.name.toLowerCase().includes(qq) || (i.sub ?? '').toLowerCase().includes(qq));
  });

  function exec(item: Item) {
    if (item.kind.startsWith('mod:')) {
      ui.module = item.kind.slice(4) as typeof ui.module;
      onClose();
    } else if (item.kind.startsWith('node:')) {
      ui.module = 'dashboard';
      selectNode(item.kind.slice(5));
      onClose();
    } else if (item.kind.startsWith('ssh:')) {
      openSSH(item.kind.slice(4));
      onClose();
    } else if (item.kind.startsWith('cap:')) {
      ui.module = 'distribute';
      ui.distCapId = item.kind.slice(4);
      ui.distView = 'compose';
      onClose();
    } else {
      onClose();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); e.preventDefault(); }
    if (e.key === 'ArrowUp')   { active = Math.max(active - 1, 0); e.preventDefault(); }
    if (e.key === 'Enter')     { if (items[active]) exec(items[active]); }
  }
</script>

<div class="cmdk-scrim"
  role="button"
  tabindex="-1"
  onclick={onClose}
  onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
  <div class="cmdk" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}>
    <input
      bind:this={inputRef}
      placeholder="cobweb › find node, capability, action…"
      value={q}
      oninput={(e) => { q = e.currentTarget.value; active = 0; }}
      onkeydown={onKeyDown}
    />
    <ul>
      {#if items.length === 0}
        <li style="color: var(--fg-disabled)">no match.</li>
      {/if}
      {#each items as item, i (i)}
        <li
          class:active={i === active}
          onmouseenter={() => active = i}
          onclick={() => exec(item)}
          role="option"
          aria-selected={i === active}>
          <span class="cmd-cat">{item.cat}</span>
          <span>
            {item.name}
            {#if item.sub}<span style="color: var(--fg-disabled); margin-left: 8px">{item.sub}</span>{/if}
          </span>
          {#if item.keys && item.keys.length > 0}
            <span class="cmd-keys">
              {#each item.keys as k (k)}<kbd>{k}</kbd>{/each}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>
