// WebSocket upgrade glue for /agent/ws. Lives outside routes.ts so the typed
// Hono RPC client never sees the WS shape (it's a Bun-native upgrade, not a
// fetch response).
//
// `attachAgentWs(req, server)` returns a Response when the path doesn't match
// or the request isn't a WS upgrade — the main `Bun.serve` falls through to
// the Hono app in that case. Otherwise it returns the upgrade Response itself.

import type { ServerWebSocket } from "bun";

import { type AgentHello, agents } from "./agent-registry";

const AGENT_PATH = "/agent/ws";

interface AgentSocketData {
  peerId?: string;
}

type UpgradableServer = {
  upgrade(req: Request, opts: { data: AgentSocketData }): boolean;
};

/** Try to handle `/agent/ws`. Returns null when the caller should fall
 *  through to the Hono app. */
export function tryUpgradeAgent(req: Request, server: UpgradableServer): Response | null {
  const url = new URL(req.url);
  if (url.pathname !== AGENT_PATH) return null;
  const ok = server.upgrade(req, {
    data: { peerId: undefined },
  });
  if (!ok) {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  return new Response(null, { status: 101 });
}

/** Handlers passed to `Bun.serve({ websocket: ... })`. */
export const agentWsHandlers = {
  open(_ws: ServerWebSocket<AgentSocketData>) {
    // Nothing to do until we see a hello. Agents that never send a hello
    // will time out on the idle timeout.
  },

  message(ws: ServerWebSocket<AgentSocketData>, raw: string | Buffer) {
    if (typeof raw !== "string") return;
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const hello = msg as unknown as AgentHello;
      // Fallback identity when the agent couldn't read peer_id (no easytier
      // yet, dev mode, etc.) — keyed by hostname so we still get one entry.
      if (!hello.peer_id) hello.peer_id = `host:${hello.hostname}`;
      ws.data.peerId = hello.peer_id;
      agents.upsert(hello, ws);
      ws.send(
        JSON.stringify({
          type: "hello_ack",
          server_version: "0.2.0",
        }),
      );
      return;
    }
    if (ws.data.peerId != null && ws.data.peerId !== "") {
      agents.touch(ws.data.peerId);
    }
    // For now we just observe; future patches will dispatch responses /
    // replay handshakes here.
  },

  close(ws: ServerWebSocket<AgentSocketData>) {
    if (ws.data.peerId) {
      agents.remove(ws.data.peerId);
    } else {
      agents.removeByWs(ws);
    }
  },

  drain() {},
};
