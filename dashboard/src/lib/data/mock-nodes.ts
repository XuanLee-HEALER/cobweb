// Type definitions, capability config, and pure formatters.
//
// Live data — nodes, latency matrix, tasks — comes from $lib/state/*. This
// file just re-exports node helpers so legacy imports keep compiling, and
// owns the parts that are static (capability list, quality classifiers,
// formatters, hash, deterministic series for sparklines).

// ─── Node helpers (live, backed by mesh state) ─────────────────────────

export type {
  AgentState,
  LocalView,
  MeshNode as Node,
  MeshState,
  PeerSummary,
} from "../state/mesh.svelte";
export {
  linkLatency,
  linkLatencyDir,
  linkLoss,
  linkTx,
  peerSummary,
} from "../state/mesh.svelte";

// ─── Service log / port placeholders ──────────────────────────────────
// These require the cobweb-agent (or SSH on demand). Until that ships,
// return empty arrays — the UI shows "no data" states.

export interface LogLine {
  t: string;
  l: "info" | "warn" | "error" | "ok";
  m: string;
}
export interface Port {
  proto: string;
  port: number;
  addr: string;
  owner: string;
  pid: number;
  tag: string;
}

export function logFor(_id: string): LogLine[] {
  return [];
}
export function portsFor(_id: string): Port[] {
  return [];
}

// ─── Distribute capabilities (static config) ──────────────────────────

export type Channel = "agent" | "ssh" | "agent-or-ssh";

export interface Capability {
  id: string;
  name: string;
  tag: string;
  desc: string;
  group: "active" | "future";
  channel: Channel;
}

export const CAPABILITIES: Capability[] = [
  {
    id: "dns",
    name: "DNS 设置",
    tag: "sys",
    desc: "写入 systemd-resolved / /etc/resolver / NRPT",
    group: "active",
    channel: "agent",
  },
  {
    id: "ca",
    name: "CA 信任根分发",
    tag: "tls",
    desc: "从 kubectl 拉取,推送到各节点 trust store",
    group: "active",
    channel: "agent",
  },
  {
    id: "ssh",
    name: "SSH key + mesh ssh",
    tag: "auth",
    desc: "私钥分发 · authorized_keys · ssh config fence",
    group: "active",
    channel: "agent-or-ssh",
  },
  {
    id: "agent",
    name: "Agent 安装 / 升级 / 卸载",
    tag: "wip",
    desc: "SSH 通道推送 Rust agent 二进制,注册为系统服务",
    group: "future",
    channel: "ssh",
  },
  {
    id: "script",
    name: "通用脚本分发",
    tag: "wip",
    desc: "任意 shell / powershell · agent exec,SSH 兜底",
    group: "future",
    channel: "agent-or-ssh",
  },
  {
    id: "file",
    name: "通用文件分发",
    tag: "wip",
    desc: "src → dst + post-install · agent file_put,SSH 兜底",
    group: "future",
    channel: "agent-or-ssh",
  },
  {
    id: "etconf",
    name: "EasyTier 配置同步",
    tag: "wip",
    desc: "通过 agent 调 easytier-cli · 滚动应用",
    group: "future",
    channel: "agent",
  },
  {
    id: "rotate",
    name: "证书 / 密钥轮换",
    tag: "wip",
    desc: "到期前自动轮换 · 失败回滚",
    group: "future",
    channel: "agent",
  },
];

// Task result types live on the backend; re-export so consumers can import
// from a single module.
export type { CellKind, TaskResult, TaskRow } from "@cobweb/server";

// ─── Quality classifiers (pure functions) ─────────────────────────────

export type Q = "q0" | "q1" | "q2" | "q3" | "q4" | "q5" | "unreach" | null;

export function latencyQ(ms: number | null): Q {
  if (ms == null) return null;
  if (ms < 0) return "unreach";
  if (ms < 10) return "q0";
  if (ms < 30) return "q1";
  if (ms < 80) return "q2";
  if (ms < 160) return "q3";
  if (ms < 240) return "q4";
  return "q5";
}
export function lossQ(pct: number | null): Q {
  if (pct == null) return null;
  if (pct < 0) return "unreach";
  if (pct === 0) return "q0";
  if (pct < 0.5) return "q1";
  if (pct < 1.5) return "q2";
  if (pct < 3) return "q3";
  if (pct < 6) return "q4";
  return "q5";
}
export function txQ(mbps: number | null): Q {
  if (mbps == null) return null;
  if (mbps < 0) return "unreach";
  if (mbps > 800) return "q0";
  if (mbps > 500) return "q1";
  if (mbps > 200) return "q2";
  if (mbps > 100) return "q3";
  if (mbps > 40) return "q4";
  return "q5";
}

// ─── Formatters ────────────────────────────────────────────────────────

export function fmtLatency(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 0) return "x";
  return ms.toFixed(0);
}
export function fmtLoss(pct: number | null): string {
  if (pct == null) return "";
  if (pct < 0) return "x";
  if (pct === 0) return "0";
  return pct.toFixed(1);
}
export function fmtTx(mbps: number | null): string {
  if (mbps == null) return "";
  if (mbps < 0) return "x";
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)}g`;
  return mbps.toFixed(0);
}

// ─── Hash + series (Matrix trends, sparklines, drill-down chart) ──────

export function hashPair(a: string, b: string): number {
  const s = `${a}|${b}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function seedRand(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return () => {
    h = (h * 1664525 + 1013904223) | 0;
    return ((h >>> 0) % 10000) / 10000;
  };
}

export function genSeries(
  seed: string,
  n: number,
  min: number,
  max: number,
  jitter = 0.18,
): number[] {
  const rand = seedRand(seed);
  const out = new Array<number>(n);
  let v = min + (max - min) * (0.35 + rand() * 0.3);
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * (max - min) * jitter;
    v = Math.max(min, Math.min(max, v + drift));
    out[i] = v;
  }
  return out;
}
