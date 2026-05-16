// cobweb backend entry — wires modules together and starts Bun.serve.
//
// Run from project root via `just serve` or `just serve-watch`, or directly
// from this package: `cd server && bun src/index.ts`.

import { agentWsHandlers, tryUpgradeAgent } from "./agent-ws";
import {
  CLI,
  HISTORY_LEN,
  HOST,
  loadTlsCertificate,
  NODES_FILE,
  PORT,
  SAMPLE_INTERVAL_MS,
} from "./config";
import { cobwebApp } from "./routes";
import { startSampler } from "./sampler";

export type { AgentInfoView } from "./agent-registry";
export type {
  AgentInfo,
  NodeInfo,
  PeerCenterEntry,
  PeerCenterPeer,
  PeerRaw,
  StatRaw,
} from "./easytier";
// Re-export the public API surface the dashboard imports from
// `@cobweb/server` — the typed Hono client + every type the UI touches.
export type { AppType } from "./routes";
export type { ApplyLog, CellKind, TaskResult, TaskRow } from "./tasks";

startSampler();

const tls = loadTlsCertificate();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  tls,
  fetch: (req, srv) => {
    const upgrade = tryUpgradeAgent(req, srv);
    if (upgrade) return upgrade;
    return cobwebApp.fetch(req);
  },
  websocket: agentWsHandlers,
});

const scheme = tls ? "https" : "http";
console.log(`cobweb backend: ${scheme}://${HOST}:${PORT}/`);
console.log(`  agent ws:    ${tls ? "wss" : "ws"}://${HOST}:${PORT}/agent/ws`);
console.log(`  cli: ${CLI}`);
console.log(`  nodes file: ${NODES_FILE}`);
console.log(`  sampler: every ${SAMPLE_INTERVAL_MS}ms · history ${HISTORY_LEN} points`);

// Silence "unused" warnings — server handle is retained so `Bun.serve` keeps
// the process alive.
void server;
