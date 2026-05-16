// cobweb backend entry — wires modules together and starts Bun.serve.
//
// Run from project root via `just serve` or `just serve-watch`, or directly
// from this package: `cd server && bun src/index.ts`.

import { CLI, HISTORY_LEN, HOST, NODES_FILE, PORT, SAMPLE_INTERVAL_MS } from "./config";
import { cobwebApp } from "./routes";
import { startSampler } from "./sampler";

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

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255, // Bun max; mesh/apply can take a minute+
  fetch: cobwebApp.fetch,
});

console.log(`cobweb backend: http://${HOST}:${PORT}/`);
console.log(`  cli: ${CLI}`);
console.log(`  nodes file: ${NODES_FILE}`);
console.log(`  sampler: every ${SAMPLE_INTERVAL_MS}ms · history ${HISTORY_LEN} points`);
