// Live registry of connected cobweb-agent WebSocket sessions.
//
// Mirrors `docs/agent-design.md` §6 "Server 侧": one entry per peer_id, with
// last-seen timestamp + capability list. New connections from the same
// peer_id evict the old one (taking the old in-flight tasks with them).
//
// This is in-memory only — agents reconnect from scratch after a backend
// restart. That matches the agent's own state-loss-tolerant design
// (impl-plan §2.3 hand-over).

import type { ServerWebSocket } from "bun";

export type AgentCapability = "cli" | "exec" | "file" | "log" | "pty" | "event";

export interface AgentHello {
  type: "hello";
  protocol_version: number;
  agent_version: string;
  hostname: string;
  peer_id: string;
  os: "linux" | "macos" | "windows";
  capabilities: AgentCapability[];
}

export interface AgentEntry {
  peerId: string;
  hostname: string;
  agentVersion: string;
  os: AgentHello["os"];
  capabilities: AgentCapability[];
  /** Unix ms; updated on every inbound frame. */
  lastSeen: number;
  /** Unix ms of the hello frame. */
  connectedAt: number;
  /** Remote socket reference; closing it kicks the agent. */
  ws: ServerWebSocket<{ peerId?: string }>;
}

/** Lightweight public view of one agent — what /api/agents returns. */
export interface AgentInfoView {
  peerId: string;
  hostname: string;
  agentVersion: string;
  os: AgentHello["os"];
  capabilities: AgentCapability[];
  status: "online" | "offline";
  lastSeen: number;
  connectedAt: number;
}

class AgentRegistry {
  /** Live entries keyed by peer_id. */
  private readonly agents = new Map<string, AgentEntry>();

  /** Recently-disconnected entries; kept for 60 s so UI can show "stale". */
  private readonly stale = new Map<string, Omit<AgentEntry, "ws"> & { offlineAt: number }>();

  upsert(hello: AgentHello, ws: ServerWebSocket<{ peerId?: string }>): AgentEntry {
    const existing = this.agents.get(hello.peer_id);
    if (existing && existing.ws !== ws) {
      // Stale duplicate — boot the old socket.
      try {
        existing.ws.close(1000, "replaced");
      } catch {}
    }
    const now = Date.now();
    const entry: AgentEntry = {
      peerId: hello.peer_id,
      hostname: hello.hostname,
      agentVersion: hello.agent_version,
      os: hello.os,
      capabilities: hello.capabilities,
      lastSeen: now,
      connectedAt: now,
      ws,
    };
    this.agents.set(hello.peer_id, entry);
    this.stale.delete(hello.peer_id);
    return entry;
  }

  touch(peerId: string): void {
    const a = this.agents.get(peerId);
    if (a) a.lastSeen = Date.now();
  }

  remove(peerId: string): void {
    const a = this.agents.get(peerId);
    if (!a) return;
    this.agents.delete(peerId);
    const { ws: _ws, ...rest } = a;
    this.stale.set(peerId, { ...rest, offlineAt: Date.now() });
  }

  removeByWs(ws: ServerWebSocket<{ peerId?: string }>): void {
    for (const [id, e] of this.agents) {
      if (e.ws === ws) {
        this.remove(id);
        return;
      }
    }
  }

  get(peerId: string): AgentEntry | undefined {
    return this.agents.get(peerId);
  }

  list(): AgentInfoView[] {
    const now = Date.now();
    // Purge stale older than 60 s.
    for (const [id, s] of this.stale) {
      if (now - s.offlineAt > 60_000) this.stale.delete(id);
    }
    const live = Array.from(this.agents.values()).map<AgentInfoView>((e) => ({
      peerId: e.peerId,
      hostname: e.hostname,
      agentVersion: e.agentVersion,
      os: e.os,
      capabilities: e.capabilities,
      status: "online",
      lastSeen: e.lastSeen,
      connectedAt: e.connectedAt,
    }));
    const off = Array.from(this.stale.values()).map<AgentInfoView>((s) => ({
      peerId: s.peerId,
      hostname: s.hostname,
      agentVersion: s.agentVersion,
      os: s.os,
      capabilities: s.capabilities,
      status: "offline",
      lastSeen: s.lastSeen,
      connectedAt: s.connectedAt,
    }));
    return [...live, ...off].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  /** Broadcast a server-side message to one agent. Returns false if missing. */
  send(peerId: string, msg: unknown): boolean {
    const a = this.agents.get(peerId);
    if (!a) return false;
    a.ws.send(JSON.stringify(msg));
    return true;
  }
}

export const agents = new AgentRegistry();
