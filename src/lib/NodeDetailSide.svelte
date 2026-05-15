<script lang="ts">
  import type { Node } from './data';
  import { peerSummary, logFor, portsFor } from './data';
  import { openSSH } from './ui-state.svelte';
  import DualStat from './DualStat.svelte';
  import NodeMetrics from './NodeMetrics.svelte';

  interface Props {
    node: Node;
    onCollapse: () => void;
  }
  let { node, onCollapse }: Props = $props();

  const peers = $derived(peerSummary(node));
  const log   = $derived(logFor(node.id));
  const ports = $derived(portsFor(node.id));

  const channel = $derived<'agent' | 'ssh-fallback' | 'unreachable'>(
    node.agent === 'online'    ? 'agent' :
    node.mesh  !== 'offline'   ? 'ssh-fallback' :
                                 'unreachable'
  );

  const meshColor = $derived(
    node.mesh === 'online' ? 'var(--status-success)' :
    node.mesh === 'degraded' ? 'var(--status-warning)' :
                               'var(--status-error)'
  );

  function lossClass(loss: number): string {
    if (loss < 0) return 'bad';
    if (loss > 3) return 'bad';
    if (loss > 1) return 'warn';
    return 'ok';
  }
</script>

<aside class="side">
  <div class="side-head">
    <div class="side-host">
      <DualStat mesh={node.mesh} agent={node.agent} size="lg" />
      {node.host}
      <span style="flex: 1"></span>
      <button class="icon-btn" onclick={onCollapse} aria-label="Collapse panel"
        title="Collapse panel (re-open from the strip)"
        style="font-size: 12px">›</button>
    </div>
    <div class="side-ip">{node.ip} · {node.os} · easytier {node.version}</div>
    <div class="side-actions">
      <button
        class="icon-btn primary"
        disabled={channel === 'unreachable'}
        style="opacity: {channel === 'unreachable' ? 0.4 : 1}"
        onclick={() => channel !== 'unreachable' && openSSH(node.id)}>
        Open SSH
      </button>
      <span class="channel-badge {channel === 'agent' ? 'via-agent' : channel === 'ssh-fallback' ? 'fallback' : 'via-ssh'}">
        {#if channel === 'agent'}via agent exec{/if}
        {#if channel === 'ssh-fallback'}via ssh · agent offline{/if}
        {#if channel === 'unreachable'}no channel{/if}
      </span>
      <span class="spacer"></span>
      <button class="icon-btn">Restart svc</button>
    </div>
  </div>

  <div class="side-section">
    <div class="eyebrow">basic</div>
    <div class="kv">
      <span class="k">hostname</span><span class="v">{node.host}</span>
      <span class="k">ipv4</span><span class="v">{node.ip}</span>
      <span class="k">os</span><span class="v">{node.os}</span>
      <span class="k">easytier</span><span class="v">{node.version}</span>
      <span class="k">cost</span><span class="v">{node.cost}</span>
      <span class="k">tunnel</span><span class="v">{node.proto}</span>
      <span class="k">region</span><span class="v">{node.region}</span>
      <span class="k">mesh</span>
      <span class="v" style:color={meshColor}>{node.mesh}</span>
    </div>
  </div>

  <div class="side-section">
    <div class="eyebrow">
      agent
      <span style="display: inline-flex; align-items: center; gap: 6px; letter-spacing: 0; text-transform: none">
        <span style="
          width: 6px; height: 6px; border-radius: 50%;
          background: {node.agent === 'online' ? 'var(--status-info)' : 'transparent'};
          box-shadow: {node.agent === 'online' ? 'none' : 'inset 0 0 0 1px var(--fg-disabled)'};
          display: inline-block;
        "></span>
        <span style="color: {node.agent === 'online' ? 'var(--status-info)' : 'var(--status-warning)'}; font-family: var(--font-mono)">
          {node.agent}
        </span>
      </span>
    </div>
    <div class="kv">
      <span class="k">version</span><span class="v">{node.agentVersion}</span>
      <span class="k">connected</span><span class="v">{node.agentSince}</span>
      <span class="k">last heartbeat</span>
      <span class="v" style:color={node.agent === 'online' ? 'var(--fg-primary)' : 'var(--status-warning)'}>
        {node.heartbeat}
      </span>
    </div>
    <div style="margin-top: 8px; display: flex; gap: 6px">
      {#if node.agent === 'online'}
        <button class="icon-btn">Force reconnect</button>
        <button class="icon-btn">View agent log</button>
      {:else}
        <button class="icon-btn primary">↻ Reconnect</button>
        <button class="icon-btn">Install / upgrade</button>
        <span class="channel-badge fallback" style="margin-left: auto">tasks fall back to ssh</span>
      {/if}
    </div>
  </div>

  <div class="side-section">
    <div class="eyebrow">
      metrics <span style="color: var(--fg-disabled); letter-spacing: 0; text-transform: none">last 5 min · 5s sample</span>
    </div>
    <NodeMetrics {node} />
  </div>

  <div class="side-section">
    <div class="eyebrow">
      peers <span style="color: var(--fg-secondary); letter-spacing: 0; text-transform: none">{peers.length}</span>
      <span style="color: var(--fg-disabled); letter-spacing: 0; text-transform: none">sorted by rtt</span>
    </div>
    <div>
      {#each peers as p (p.id)}
        <div class="peer-row">
          <span class="pname">
            <DualStat mesh={p.mesh} agent={p.agent} size="sm" />
            {p.host}
          </span>
          <span class="pms">{p.ms < 0 ? '—' : `${p.ms}ms`}</span>
          <span class="ploss {lossClass(p.loss)}">{p.loss < 0 ? '×' : `${p.loss.toFixed(1)}%`}</span>
        </div>
      {/each}
    </div>
  </div>

  <div class="side-section">
    <div class="eyebrow">
      service log <span style="color: var(--fg-disabled); letter-spacing: 0; text-transform: none">tail · live</span>
    </div>
    <div class="log">
      {#each log as line, i (i)}
        <div>
          <span class="ts">{line.t}</span>
          <span class="lvl-{line.l}">[{line.l}]</span>
          <span>{line.m}</span>
        </div>
      {/each}
    </div>
  </div>

  <div class="side-section">
    <div class="eyebrow">
      listening ports <span style="color: var(--fg-disabled); letter-spacing: 0; text-transform: none">ss -tlnp</span>
    </div>
    <table class="port-table">
      <thead>
        <tr><th>proto</th><th>addr:port</th><th>owner (pid)</th><th></th></tr>
      </thead>
      <tbody>
        {#each ports as p, i (i)}
          <tr>
            <td>{p.proto}</td>
            <td>{p.addr}:{p.port}</td>
            <td><span style="color: var(--fg-primary)">{p.owner}</span> <span style="color: var(--fg-disabled)">{p.pid}</span></td>
            <td>{#if p.tag}<span class="tag">{p.tag}</span>{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</aside>
