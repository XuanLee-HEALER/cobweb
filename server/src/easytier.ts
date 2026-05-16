// Thin wrapper over `easytier-cli`. All RPC calls go through cli<T>(args),
// returning whatever JSON the CLI emits parsed as T.

import { CLI, RPC } from "./config";

// ── output types ──────────────────────────────────────────────────────

export interface PeerRaw {
  cidr: string;
  ipv4: string;
  hostname: string;
  cost: string;
  lat_ms: string;
  loss_rate: string;
  rx_bytes: string;
  tx_bytes: string;
  tunnel_proto: string;
  nat_type: string;
  id: string;
  version: string;
}

export interface StatRaw {
  name: string;
  value: number;
  labels: Record<string, string>;
}

export interface PeerCenterPeer {
  node_id: string;
  hostname: string;
  ipv4: string;
  latency_ms: number;
}

export interface PeerCenterEntry {
  node_id: string;
  hostname: string;
  ipv4: string;
  direct_peers: PeerCenterPeer[];
}

// Minimal subset of `easytier-cli node info` output that the UI reads.
// Real CLI output has more fields; declare loose to avoid version coupling.
export interface NodeInfo {
  peer_id: number | string;
  ipv4_addr: string;
  hostname: string;
  version: string;
  listeners?: string[];
  stun_info?: { udp_nat_type?: number; tcp_nat_type?: number; public_ip?: string[] };
  [k: string]: unknown;
}

// Agent registry entry. Empty list until cobweb-agent ships.
export interface AgentInfo {
  peerId: string;
  status: "online" | "offline";
  version?: string;
}

// ── RPC entry point ───────────────────────────────────────────────────

export async function cli<T = unknown>(args: string[]): Promise<T> {
  const proc = Bun.spawn([CLI, "-p", RPC, "-o", "json", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${CLI} ${args.join(" ")} exit=${code}: ${err.trim()}`);
  }
  return JSON.parse(out) as T;
}
