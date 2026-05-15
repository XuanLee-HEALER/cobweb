<script lang="ts">
  import type { Capability } from './data';
  import { NODES } from './data';
  import { openContextMenu } from './ui-state.svelte';
  import { nodeMenuItems } from './menu-builders';
  import ChannelBadge from './ChannelBadge.svelte';
  import DualStat from './DualStat.svelte';

  interface Props {
    cap: Capability;
    selectedNodes: Set<string>;
    toggle: (id: string) => void;
    selectAll: () => void;
    selectNone: () => void;
    invert: () => void;
    dryRun: boolean;
    setDryRun: (v: boolean) => void;
    onSubmit: () => void;
    presetDraft: { name: string } | null;
    setPresetDraft: (v: { name: string } | null) => void;
    onSavePreset: (name: string) => void;
  }
  let {
    cap, selectedNodes, toggle, selectAll, selectNone, invert,
    dryRun, setDryRun, onSubmit, presetDraft, setPresetDraft, onSavePreset,
  }: Props = $props();

  const managed = $derived(NODES.filter(n => !n.notManaged));

  const blockedCount = $derived(
    managed.filter(n => selectedNodes.has(n.id) && n.mesh === 'offline' && n.agent === 'offline').length
  );
  const fallbackCount = $derived(
    (cap.channel === 'agent' || cap.channel === 'agent-or-ssh')
      ? managed.filter(n => selectedNodes.has(n.id) && n.agent === 'offline' && n.mesh !== 'offline').length
      : 0
  );

  function onChipCtx(e: MouseEvent, n: typeof managed[number]) {
    e.preventDefault();
    openContextMenu({ x: e.clientX, y: e.clientY, items: nodeMenuItems(n) });
  }

  function onDraftKey(e: KeyboardEvent) {
    if (!presetDraft) return;
    if (e.key === 'Enter' && presetDraft.name.trim()) onSavePreset(presetDraft.name.trim());
    if (e.key === 'Escape') setPresetDraft(null);
  }
</script>

<div class="cap-section">
  <h2>parameters</h2>
  {#if cap.id === 'ca'}
    <div class="field-row">
      <div class="field">
        <label>source</label>
        <select>
          <option value="kube">kubectl get configmap kube-root-ca.crt</option>
          <option value="file">file: /etc/ssl/ca.pem</option>
          <option value="stdin">stdin (paste PEM)</option>
        </select>
      </div>
      <div class="field" style="max-width: 200px">
        <label>context</label>
        <select><option>prod</option><option>stage</option></select>
      </div>
    </div>
    <div class="field">
      <label>cert label</label>
      <input type="text" value="kube-int-ca-2026q2" />
      <div class="hint">becomes the filename under /usr/local/share/ca-certificates/&lt;label&gt;.crt</div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>after install</label>
        <select>
          <option value="update">run update-ca-certificates</option>
          <option value="skip">skip · operator-managed</option>
        </select>
      </div>
      <div class="field">
        <label>verify by</label>
        <select>
          <option value="openssl">openssl verify against test endpoint</option>
          <option value="curl">curl https://&lt;test&gt; --cacert /dev/null</option>
        </select>
      </div>
    </div>
  {:else if cap.id === 'dns'}
    <div class="field-row">
      <div class="field" style="flex: 2">
        <label>zone</label>
        <input type="text" value="mesh.cobweb.lan" />
      </div>
      <div class="field" style="flex: 1">
        <label>nameserver</label>
        <input type="text" value="10.144.0.1" />
      </div>
    </div>
    <div class="field">
      <label>strategy</label>
      <select>
        <option value="resolved">systemd-resolved drop-in</option>
        <option value="resolver">/etc/resolver/&lt;zone&gt; (mac)</option>
        <option value="nrpt">NRPT (win)</option>
        <option value="auto">auto · per-os detect</option>
      </select>
    </div>
    <div class="field">
      <label>persist as</label>
      <input type="text" value="cobweb-mesh-internal" />
    </div>
  {:else if cap.id === 'ssh'}
    <div class="field-row">
      <div class="field" style="flex: 2">
        <label>key source</label>
        <select>
          <option value="archmbp">root@archmbp · ed25519 (last rotated 2026-04-12)</option>
          <option value="new">generate new ed25519</option>
        </select>
      </div>
      <div class="field" style="flex: 1">
        <label>op</label>
        <select>
          <option value="rotate">rotate</option>
          <option value="add">add to authorized_keys</option>
          <option value="revoke">revoke</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>authorized_keys path</label>
      <input type="text" value="/root/.ssh/authorized_keys" />
    </div>
    <div class="field">
      <label>fence (ssh config)</label>
      <textarea rows="3">{`# cobweb mesh
Match host *.mesh.cobweb.lan
  IdentityFile ~/.ssh/cobweb_ed25519
  IdentitiesOnly yes`}</textarea>
    </div>
  {:else if cap.group === 'future'}
    <div style="color: var(--fg-disabled); font-family: var(--font-mono); font-size: 12px">
      schema-driven form will be auto-generated from this capability's param list.
    </div>
  {/if}
</div>

<div class="cap-section">
  <h2>target nodes</h2>
  <div class="node-picker-bar">
    <div class="np-tools">
      <button onclick={selectAll}>全选</button>
      <button onclick={selectNone}>全不选</button>
      <button onclick={invert}>反选</button>
      <button>仅在线</button>
      <button>region:home-bj</button>
    </div>
    <div class="np-summary">
      selected <span class="num">{selectedNodes.size}</span> · managed <span class="num">{managed.length}</span>
      {#if fallbackCount > 0}
        <span class="channel-badge fallback" style="margin-left: 10px">
          {fallbackCount} via ssh fallback
        </span>
      {/if}
      {#if blockedCount > 0}
        <span style="margin-left: 10px; color: var(--status-warning)">
          {blockedCount} unreachable (will queue)
        </span>
      {/if}
    </div>
  </div>
  <div class="np-chips">
    {#each managed as n (n.id)}
      <span
        class="chip"
        class:selected={selectedNodes.has(n.id)}
        class:offline={n.mesh === 'offline' && n.agent === 'offline'}
        role="button"
        tabindex="0"
        onclick={() => toggle(n.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(n.id); }}
        oncontextmenu={(e) => onChipCtx(e, n)}>
        <DualStat mesh={n.mesh} agent={n.agent} size="sm" />
        {n.host}
      </span>
    {/each}
  </div>
</div>

<div class="cap-section">
  <h2>execute</h2>
  <div class="row gap-3" style="align-items: center">
    <label style="display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); cursor: pointer">
      <input type="checkbox" checked={dryRun} onchange={(e) => setDryRun(e.currentTarget.checked)} />
      dry run <span style="color: var(--fg-disabled)">(prints commands; does not execute)</span>
    </label>
    <span class="spacer"></span>
    <button class="icon-btn" onclick={() => setPresetDraft({ name: `上线 ${cap.name}` })}>
      Save as preset
    </button>
    <button class="icon-btn primary" onclick={onSubmit}>
      {dryRun ? 'Preview commands →' : `Execute on ${selectedNodes.size} nodes →`}
    </button>
  </div>
  {#if presetDraft}
    <div class="preset-form">
      <label>preset name</label>
      <input
        type="text"
        value={presetDraft.name}
        oninput={(e) => setPresetDraft({ name: e.currentTarget.value })}
        onkeydown={onDraftKey}
      />
      <span class="hint">
        saves selected nodes + current params as <span style="color: var(--fg-secondary)">{cap.name}</span>;
        future versions will chain multiple capabilities.
      </span>
      <span class="spacer"></span>
      <button class="icon-btn" onclick={() => setPresetDraft(null)}>Cancel</button>
      <button class="icon-btn primary" onclick={() => onSavePreset(presetDraft.name.trim())} disabled={!presetDraft.name.trim()}>Save</button>
    </div>
  {/if}
</div>
