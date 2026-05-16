// Periodic local sampler + peer-center poll.
//
// Every SAMPLE_INTERVAL_MS we capture the local peer view + the global
// peer-center N×N latency view. New data is appended to in-memory rings
// and broadcast on the `events` EventEmitter so SSE consumers in routes.ts
// can push to connected dashboards.

import { EventEmitter } from "node:events";
import { HISTORY_LEN, SAMPLE_INTERVAL_MS } from "./config";
import { cli, type PeerCenterEntry, type PeerRaw, type StatRaw } from "./easytier";

// ── parsing helpers ───────────────────────────────────────────────────

const BYTE_UNITS: Record<string, number> = {
  "": 1,
  B: 1,
  kB: 1024,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

function parseBytes(s: string): number {
  if (!s || s === "-") return 0;
  const m = s.trim().match(/^([\d.]+)\s*([kKMGT]?B)?$/);
  if (!m) return 0;
  const v = parseFloat(m[1]!);
  const unit = m[2] ?? "B";
  return Math.round(v * (BYTE_UNITS[unit] ?? 1));
}

function parseLat(s: string): number | null {
  if (!s || s === "-") return null;
  const v = parseFloat(s);
  return Number.isNaN(v) ? null : v;
}

function parseLoss(s: string): number {
  if (!s || s === "-") return 0;
  const v = parseFloat(s.replace("%", ""));
  return Number.isNaN(v) ? 0 : v;
}

// ── sample shapes ─────────────────────────────────────────────────────

export interface PeerSample {
  hostname: string;
  ipv4: string;
  cost: string;
  lat_ms: number | null;
  loss_pct: number;
  rx_bytes: number;
  tx_bytes: number;
}

export interface Sample {
  ts: number;
  peers: Record<string, PeerSample>;
  totals: { rx_bytes: number; tx_bytes: number };
}

// ── shared state ──────────────────────────────────────────────────────
// Two pub/sub channels: per-sample local view (every SAMPLE_INTERVAL_MS) and
// the global peer-center view (same cadence).

export const events = new EventEmitter();
export const samples: Sample[] = [];
export let latestPeerCenter: PeerCenterEntry[] = [];

// ── sampling loop ─────────────────────────────────────────────────────

async function takeSample(): Promise<Sample | null> {
  try {
    const [peers, stats] = await Promise.all([cli<PeerRaw[]>(["peer"]), cli<StatRaw[]>(["stats"])]);
    const peerMap: Record<string, PeerSample> = {};
    for (const p of peers) {
      peerMap[p.id] = {
        hostname: p.hostname,
        ipv4: p.ipv4.split("/")[0]!,
        cost: p.cost,
        lat_ms: parseLat(p.lat_ms),
        loss_pct: parseLoss(p.loss_rate),
        rx_bytes: parseBytes(p.rx_bytes),
        tx_bytes: parseBytes(p.tx_bytes),
      };
    }
    let totalRx = 0;
    let totalTx = 0;
    for (const s of stats) {
      if (s.name === "traffic_bytes_rx") totalRx += s.value;
      else if (s.name === "traffic_bytes_tx") totalTx += s.value;
    }
    return { ts: Date.now(), peers: peerMap, totals: { rx_bytes: totalRx, tx_bytes: totalTx } };
  } catch (e) {
    console.warn("sample failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function sampleLoop() {
  const s = await takeSample();
  if (s) {
    samples.push(s);
    if (samples.length > HISTORY_LEN) samples.shift();
    events.emit("sample", s);
  }
  // peer-center: full N×N latency view from any mesh node. Cheap (single RPC).
  try {
    const pc = await cli<PeerCenterEntry[]>(["peer-center"]);
    latestPeerCenter = pc;
    events.emit("peer-center", pc);
  } catch (e) {
    // easytier-cli unavailable or RPC unreachable — log once, keep last good.
    console.warn("peer-center failed:", e instanceof Error ? e.message : e);
  }
}

/** Start periodic sampling. Idempotent — calling twice is harmless but only
 *  the first call schedules the interval. */
let started = false;
export function startSampler(): void {
  if (started) return;
  started = true;
  sampleLoop();
  setInterval(sampleLoop, SAMPLE_INTERVAL_MS);
}
