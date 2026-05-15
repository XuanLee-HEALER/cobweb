// Reactive mesh state. Populated on mount by initMesh() from /api/node-info +
// /api/agents and kept fresh by the /api/stream SSE channel.
//
// Replaces the old static NODES mock — components read directly from
// `mesh.nodes` / `mesh.latency` and get re-renders for free.

import type { PeerCenterEntry } from "../../../server";

// ─── Types ────────────────────────────────────────────────────────────

export type MeshState = "online" | "degraded" | "offline";
export type AgentState = "online" | "offline";

export interface MeshNode {
  id: string;
  host: string;
  ip: string;
  os: string;
  cost: number;
  mesh: MeshState;
  agent: AgentState;
  agentVersion: string;
  agentSince: string;
  heartbeat: string;
  proto: string;
  version: string;
  region: string;
  notManaged?: boolean;
}

export interface LocalView {
  loss: number;
  rxBytes: number;
  txBytes: number;
  cost: string;
  latMs: number | null;
}

interface SamplePayload {
  ts: number;
  peers: Record<
    string,
    {
      hostname: string;
      ipv4: string;
      cost: string;
      lat_ms: number | null;
      loss_pct: number;
      rx_bytes: number;
      tx_bytes: number;
    }
  >;
  totals: { rx_bytes: number; tx_bytes: number };
}

// ─── State ────────────────────────────────────────────────────────────

export const mesh = $state({
  loaded: false,
  sseConnected: false,
  /** peer_id of the local easytier node — populated once from /api/node-info. */
  selfId: "",
  nodes: [] as MeshNode[],
  /** directional latency: `latency[from][to] = ms`. missing = no data. */
  latency: {} as Record<string, Record<string, number>>,
  /** per-peer local view (only meaningful for selfId's row). */
  localView: {} as Record<string, LocalView>,
  totals: { rxBytes: 0, txBytes: 0 },
  /** ms timestamp of the most recent push. */
  lastUpdate: 0,
});

export const agents = $state({
  /** peerId → status. Always empty until cobweb-agent ships. */
  byPeerId: {} as Record<string, AgentState>,
});

// ─── Update reducers ─────────────────────────────────────────────────

function applyPeerCenter(entries: PeerCenterEntry[]) {
  const nodes: MeshNode[] = entries.map((e) => ({
    id: e.node_id,
    host: e.hostname,
    ip: e.ipv4.split("/")[0] || e.ipv4,
    os: "—",
    cost: 1,
    mesh: "online",
    agent: agents.byPeerId[e.node_id] ?? "offline",
    agentVersion: "—",
    agentSince: "—",
    heartbeat: "—",
    proto: "wg",
    version: "—",
    region: "—",
  }));
  const latency: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    latency[e.node_id] = {};
    for (const p of e.direct_peers) {
      latency[e.node_id][p.node_id] = p.latency_ms;
    }
  }
  mesh.nodes = nodes;
  mesh.latency = latency;
  mesh.lastUpdate = Date.now();
  mesh.loaded = true;
}

function applySample(s: SamplePayload) {
  const lv: Record<string, LocalView> = {};
  for (const [peerId, p] of Object.entries(s.peers)) {
    lv[peerId] = {
      loss: p.loss_pct,
      rxBytes: p.rx_bytes,
      txBytes: p.tx_bytes,
      cost: p.cost,
      latMs: p.lat_ms,
    };
  }
  mesh.localView = lv;
  mesh.totals = { rxBytes: s.totals.rx_bytes, txBytes: s.totals.tx_bytes };
  mesh.lastUpdate = s.ts;
}

// ─── Bootstrapping ───────────────────────────────────────────────────

let es: EventSource | null = null;

export async function initMesh(): Promise<void> {
  // local peer_id — needed to know which row in the matrix is "us"
  try {
    const r = await fetch("/api/node-info");
    if (r.ok) {
      const info = (await r.json()) as { peer_id?: number | string };
      if (info.peer_id != null) mesh.selfId = String(info.peer_id);
    }
  } catch {
    // backend offline; SSE retry will still hit when available
  }
  // agent status table (empty until agent ships)
  try {
    const r = await fetch("/api/agents");
    if (r.ok) {
      const list = (await r.json()) as Array<{ peerId: string; status: AgentState }>;
      const map: Record<string, AgentState> = {};
      for (const a of list) map[a.peerId] = a.status;
      agents.byPeerId = map;
    }
  } catch {}
  startMeshStream();
}

export function startMeshStream(): void {
  if (es) return;
  es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    mesh.sseConnected = true;
  });
  es.addEventListener("error", () => {
    mesh.sseConnected = false;
  });
  es.addEventListener("peer-center", (ev) => {
    try {
      applyPeerCenter(JSON.parse((ev as MessageEvent).data) as PeerCenterEntry[]);
    } catch {}
  });
  es.addEventListener("sample", (ev) => {
    try {
      applySample(JSON.parse((ev as MessageEvent).data) as SamplePayload);
    } catch {}
  });
  es.addEventListener("history", (ev) => {
    try {
      const arr = JSON.parse((ev as MessageEvent).data) as SamplePayload[];
      if (arr.length > 0) applySample(arr[arr.length - 1]);
    } catch {}
  });
}

export function stopMeshStream(): void {
  if (es) {
    es.close();
    es = null;
  }
  mesh.sseConnected = false;
}

// ─── Derived helpers (read state directly so callers stay reactive) ──

export function linkLatency(a: MeshNode, b: MeshNode): number | null {
  if (a.id === b.id) return null;
  if (a.mesh === "offline" || b.mesh === "offline") return -1;
  const v = mesh.latency[a.id]?.[b.id];
  return v == null ? -1 : v;
}

export function linkLatencyDir(a: MeshNode, b: MeshNode, dir: "sym" | "ab"): number | null {
  const ab = linkLatency(a, b);
  if (dir === "ab" || ab == null || ab < 0) return ab;
  // sym: average A→B and B→A when both are available (often differ).
  const ba = mesh.latency[b.id]?.[a.id];
  if (ba == null) return ab;
  return Math.round((ab + ba) / 2);
}

export function linkLoss(a: MeshNode, b: MeshNode): number | null {
  if (a.id === b.id) return null;
  // peer-center has no loss info; only OUR node has loss for outgoing peers.
  if (a.id === mesh.selfId && mesh.localView[b.id]) {
    return mesh.localView[b.id].loss;
  }
  return -1;
}

export function linkTx(a: MeshNode, b: MeshNode): number | null {
  if (a.id === b.id) return null;
  // cumulative bytes only; rate needs history. Until we add proper rate calc,
  // surface "no data" for non-local rows.
  return -1;
}

export interface PeerSummary {
  id: string;
  host: string;
  mesh: MeshState;
  agent: AgentState;
  ms: number;
  loss: number;
}

export function peerSummary(node: MeshNode): PeerSummary[] {
  return mesh.nodes
    .filter((n) => n.id !== node.id && !n.notManaged)
    .map<PeerSummary>((n) => ({
      id: n.id,
      host: n.host,
      mesh: n.mesh,
      agent: n.agent,
      ms: mesh.latency[node.id]?.[n.id] ?? -1,
      loss: node.id === mesh.selfId && mesh.localView[n.id] ? mesh.localView[n.id].loss : -1,
    }))
    .sort((a, b) => {
      if (a.ms < 0 && b.ms >= 0) return 1;
      if (b.ms < 0 && a.ms >= 0) return -1;
      return a.ms - b.ms;
    });
}
