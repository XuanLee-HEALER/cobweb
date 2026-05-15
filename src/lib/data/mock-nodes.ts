// ────────────────────────────────────────────────────────────────────
//  cobweb — mock data (port of cobweb-data.js)
//  Static + deterministic. Wired into real APIs at the integration layer.
// ────────────────────────────────────────────────────────────────────

export type MeshState = "online" | "degraded" | "offline";
export type AgentState = "online" | "offline";

export interface Node {
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

export const NODES: Node[] = [
  {
    id: "archmbp",
    host: "archmbp",
    ip: "10.144.0.1",
    os: "macOS 14.4",
    cost: 1,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "4d 02:11",
    heartbeat: "0.4s",
    proto: "wg",
    version: "0.2.3",
    region: "home-bj",
  },
  {
    id: "nuc-arch",
    host: "nuc-arch",
    ip: "10.144.0.2",
    os: "Arch Linux",
    cost: 1,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "3d 18:04",
    heartbeat: "0.6s",
    proto: "wg",
    version: "0.2.3",
    region: "home-bj",
  },
  {
    id: "work-mbp",
    host: "work-mbp",
    ip: "10.144.0.3",
    os: "macOS 14.4",
    cost: 5,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "6h 12m",
    heartbeat: "1.1s",
    proto: "tcp",
    version: "0.2.3",
    region: "office",
  },
  {
    id: "aliyun-hk",
    host: "aliyun-hk",
    ip: "10.144.0.4",
    os: "Debian 12",
    cost: 10,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "12d 04:30",
    heartbeat: "0.8s",
    proto: "wg",
    version: "0.2.3",
    region: "hk",
  },
  {
    id: "aliyun-sg",
    host: "aliyun-sg",
    ip: "10.144.0.5",
    os: "Debian 12",
    cost: 10,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.1",
    agentSince: "21d 09:14",
    heartbeat: "0.9s",
    proto: "wg",
    version: "0.2.2",
    region: "sg",
  },
  {
    id: "homelab-01",
    host: "homelab-01",
    ip: "10.144.0.6",
    os: "NixOS 24.05",
    cost: 1,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "8d 22:01",
    heartbeat: "0.5s",
    proto: "wg",
    version: "0.2.3",
    region: "home-bj",
  },
  {
    id: "rpi-edge",
    host: "rpi-edge",
    ip: "10.144.0.7",
    os: "Raspbian",
    cost: 2,
    mesh: "degraded",
    agent: "online",
    agentVersion: "0.4.1",
    agentSince: "1d 03:48",
    heartbeat: "2.4s",
    proto: "tcp",
    version: "0.2.3",
    region: "home-sh",
  },
  {
    id: "nas-truenas",
    host: "nas-truenas",
    ip: "10.144.0.8",
    os: "TrueNAS 13",
    cost: 1,
    mesh: "online",
    agent: "offline",
    agentVersion: "0.3.9",
    agentSince: "—",
    heartbeat: "14m 02s",
    proto: "wg",
    version: "0.2.3",
    region: "home-bj",
  },
  {
    id: "vps-fly",
    host: "vps-fly",
    ip: "10.144.0.9",
    os: "Alpine 3.20",
    cost: 10,
    mesh: "offline",
    agent: "offline",
    agentVersion: "0.3.9",
    agentSince: "—",
    heartbeat: "4h 12m",
    proto: "—",
    version: "0.2.1",
    region: "sjc",
  },
  {
    id: "proxmox-01",
    host: "proxmox-01",
    ip: "10.144.0.10",
    os: "Proxmox VE 8",
    cost: 1,
    mesh: "online",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "14d 11:22",
    heartbeat: "0.5s",
    proto: "wg",
    version: "0.2.3",
    region: "home-bj",
  },
  {
    id: "oracle-fra",
    host: "oracle-fra",
    ip: "10.144.0.11",
    os: "Ubuntu 22.04",
    cost: 10,
    mesh: "offline",
    agent: "online",
    agentVersion: "0.4.2",
    agentSince: "7d 14:08",
    heartbeat: "1.0s",
    proto: "wg",
    version: "0.2.3",
    region: "fra",
  },
  {
    id: "tablet-ipad",
    host: "tablet-ipad",
    ip: "10.144.0.12",
    os: "iPadOS 17",
    cost: 5,
    mesh: "online",
    agent: "offline",
    agentVersion: "—",
    agentSince: "—",
    heartbeat: "—",
    proto: "tcp",
    version: "0.2.3",
    region: "office",
    notManaged: true,
  },
];

// deterministic pseudo-rand from two ids
export function hashPair(a: string, b: string): number {
  const s = `${a}|${b}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const HOME_REGIONS = ["home-bj", "home-sh", "office"];

export function linkLatency(a: Node, b: Node): number | null {
  if (a.id === b.id) return null;
  if (a.mesh === "offline" || b.mesh === "offline") return -1;
  if (a.region === b.region) return 1 + (hashPair(a.id, b.id) % 7);
  if (HOME_REGIONS.includes(a.region) && HOME_REGIONS.includes(b.region)) {
    return 18 + (hashPair(a.id, b.id) % 24);
  }
  if (
    (HOME_REGIONS.includes(a.region) && ["hk", "sg"].includes(b.region)) ||
    (HOME_REGIONS.includes(b.region) && ["hk", "sg"].includes(a.region))
  ) {
    return 48 + (hashPair(a.id, b.id) % 42);
  }
  if (
    (HOME_REGIONS.includes(a.region) && b.region === "fra") ||
    (HOME_REGIONS.includes(b.region) && a.region === "fra")
  ) {
    return 188 + (hashPair(a.id, b.id) % 80);
  }
  if (
    (HOME_REGIONS.includes(a.region) && b.region === "sjc") ||
    (HOME_REGIONS.includes(b.region) && a.region === "sjc")
  ) {
    return 162 + (hashPair(a.id, b.id) % 70);
  }
  return 240 + (hashPair(a.id, b.id) % 120);
}

export function linkLatencyDir(a: Node, b: Node, dir: "sym" | "ab"): number | null {
  const base = linkLatency(a, b);
  if (base == null || base < 0) return base;
  if (dir !== "ab") return base;
  const h = hashPair(a.id, b.id);
  const bias = (h % 26) - 13;
  const sign = a.id < b.id ? 1 : -1;
  return Math.max(1, Math.round(base + bias * sign));
}

export function linkLoss(a: Node, b: Node): number | null {
  if (a.id === b.id) return null;
  if (a.mesh === "offline" || b.mesh === "offline") return -1;
  if (a.id === "rpi-edge" || b.id === "rpi-edge") return 2.4 + (hashPair(a.id, b.id) % 60) / 10;
  if (a.id === "tablet-ipad" || b.id === "tablet-ipad") return (hashPair(a.id, b.id) % 30) / 10;
  if (a.region === "fra" || b.region === "fra" || a.region === "sjc" || b.region === "sjc") {
    return (hashPair(a.id, b.id) % 12) / 10;
  }
  if (hashPair(a.id, b.id) % 5 === 0) return 0.1;
  return 0;
}

export function linkTx(a: Node, b: Node): number | null {
  if (a.id === b.id) return null;
  if (a.mesh === "offline" || b.mesh === "offline") return -1;
  const base = a.region === b.region ? 800 : 60;
  return Math.round(base + (hashPair(a.id, b.id) % 600));
}

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

export interface PeerSummary {
  id: string;
  host: string;
  mesh: MeshState;
  agent: AgentState;
  ms: number;
  loss: number;
}

export function peerSummary(node: Node): PeerSummary[] {
  return NODES.filter((n) => n.id !== node.id && !n.notManaged)
    .map((n) => ({
      id: n.id,
      host: n.host,
      mesh: n.mesh,
      agent: n.agent,
      ms: linkLatency(node, n) ?? 0,
      loss: linkLoss(node, n) ?? 0,
    }))
    .sort((a, b) => {
      if (a.ms < 0 && b.ms >= 0) return 1;
      if (b.ms < 0 && a.ms >= 0) return -1;
      return (a.ms ?? 9999) - (b.ms ?? 9999);
    });
}

export interface LogLine {
  t: string;
  l: "info" | "warn" | "error" | "ok";
  m: string;
}

const LOG_TEMPLATES: Record<string, LogLine[]> = {
  archmbp: [
    { t: "12:04:18", l: "info", m: "peer nuc-arch latency probe ok 4ms" },
    { t: "12:04:18", l: "info", m: "peer aliyun-hk latency probe ok 58ms" },
    { t: "12:04:17", l: "info", m: "tunnel wg established peer=oracle-fra" },
    { t: "12:04:11", l: "warn", m: "peer rpi-edge loss=4.2% over 60s window" },
    { t: "12:04:02", l: "info", m: "session refresh: 11 peers reachable, 1 offline" },
    { t: "12:03:54", l: "error", m: "peer vps-fly dial failed: i/o timeout (5s)" },
    { t: "12:03:48", l: "info", m: "mesh route table reloaded (12 entries)" },
    { t: "12:03:31", l: "ok", m: "easytier service started (pid 4821, v0.2.3)" },
  ],
  "rpi-edge": [
    { t: "12:04:19", l: "warn", m: "wlan0 retx burst, 6 packets in 200ms" },
    { t: "12:04:11", l: "warn", m: "peer aliyun-hk rtt jitter > 80ms" },
    { t: "12:04:02", l: "info", m: "fallback tcp tunnel: udp/51820 blocked" },
    { t: "12:03:48", l: "info", m: "mesh route table reloaded" },
    { t: "12:03:30", l: "ok", m: "easytier service started (pid 1124)" },
  ],
  "vps-fly": [
    {
      t: "11:58:02",
      l: "error",
      m: "connection lost to mesh root: read tcp: connection reset by peer",
    },
    { t: "11:57:54", l: "warn", m: "no keepalive ack from any peer in 30s" },
    { t: "11:57:30", l: "info", m: "peer probe cycle complete" },
  ],
};

const DEFAULT_LOG: LogLine[] = [
  { t: "12:04:20", l: "info", m: "peer probe cycle complete" },
  { t: "12:04:09", l: "info", m: "wg handshake refreshed: peer=archmbp" },
  { t: "12:03:50", l: "info", m: "mesh table sync (12 entries)" },
  { t: "12:03:30", l: "ok", m: "easytier service started" },
];

export function logFor(id: string): LogLine[] {
  return LOG_TEMPLATES[id] ?? DEFAULT_LOG;
}

export interface Port {
  proto: string;
  port: number;
  addr: string;
  owner: string;
  pid: number;
  tag: string;
}

const PORTS: Record<string, Port[]> = {
  archmbp: [
    { proto: "tcp", port: 22, addr: "0.0.0.0", owner: "sshd", pid: 412, tag: "" },
    { proto: "udp", port: 51820, addr: "0.0.0.0", owner: "easytier", pid: 4821, tag: "easytier" },
    { proto: "tcp", port: 5432, addr: "127.0.0.1", owner: "postgres", pid: 1108, tag: "" },
    { proto: "tcp", port: 8080, addr: "0.0.0.0", owner: "ethub", pid: 5012, tag: "mesh-svc" },
    { proto: "tcp", port: 9100, addr: "0.0.0.0", owner: "node_exp", pid: 1042, tag: "" },
  ],
};

const DEFAULT_PORTS: Port[] = [
  { proto: "tcp", port: 22, addr: "0.0.0.0", owner: "sshd", pid: 412, tag: "" },
  { proto: "udp", port: 51820, addr: "0.0.0.0", owner: "easytier", pid: 4001, tag: "easytier" },
];

export function portsFor(id: string): Port[] {
  return PORTS[id] ?? DEFAULT_PORTS;
}

// ────────────────────────────────────────────────────────────────────
//  Distribution Center mock
// ────────────────────────────────────────────────────────────────────

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

export type CellKind = "ok" | "fail" | "warn" | "skip" | "run" | "queue";

export interface TaskRow {
  node: string;
  mesh: MeshState;
  agent: AgentState;
  cells: CellKind[];
  failStep?: number;
}

export interface TaskResult {
  id: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  elapsed: string;
  steps: string[];
  rows: TaskRow[];
}

export const TASK_RESULT: Record<string, TaskResult> = {
  ca: {
    id: "task-2614",
    name: "CA 信任根分发 · kube-int-ca-2026q2",
    startedAt: "12:03:51",
    finishedAt: "12:04:12",
    elapsed: "21.4s",
    steps: ["probe", "upload", "install", "verify"],
    rows: [
      { node: "archmbp", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "nuc-arch", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "work-mbp", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      {
        node: "aliyun-hk",
        mesh: "online",
        agent: "online",
        cells: ["ok", "ok", "fail", "skip"],
        failStep: 2,
      },
      { node: "aliyun-sg", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "warn"] },
      { node: "homelab-01", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "rpi-edge", mesh: "degraded", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "nas-truenas", mesh: "online", agent: "offline", cells: ["ok", "ok", "ok", "ok"] },
      {
        node: "vps-fly",
        mesh: "offline",
        agent: "offline",
        cells: ["fail", "skip", "skip", "skip"],
        failStep: 0,
      },
      { node: "proxmox-01", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "oracle-fra", mesh: "offline", agent: "online", cells: ["ok", "ok", "run", "queue"] },
    ],
  },
  dns: {
    id: "task-2615",
    name: "DNS 设置 · mesh.cobweb.lan (10.144.0.1)",
    startedAt: "12:04:18",
    finishedAt: "—",
    elapsed: "running 6.2s",
    steps: ["probe", "resolve", "write", "verify"],
    rows: [
      { node: "archmbp", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "nuc-arch", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "run"] },
      { node: "work-mbp", mesh: "online", agent: "online", cells: ["ok", "ok", "run", "queue"] },
      {
        node: "aliyun-hk",
        mesh: "online",
        agent: "online",
        cells: ["ok", "run", "queue", "queue"],
      },
      {
        node: "aliyun-sg",
        mesh: "online",
        agent: "online",
        cells: ["ok", "queue", "queue", "queue"],
      },
      { node: "homelab-01", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      {
        node: "rpi-edge",
        mesh: "degraded",
        agent: "online",
        cells: ["ok", "queue", "queue", "queue"],
      },
      { node: "nas-truenas", mesh: "online", agent: "offline", cells: ["ok", "ok", "ok", "ok"] },
      {
        node: "vps-fly",
        mesh: "offline",
        agent: "offline",
        cells: ["fail", "skip", "skip", "skip"],
        failStep: 0,
      },
      { node: "proxmox-01", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
      { node: "oracle-fra", mesh: "offline", agent: "online", cells: ["ok", "ok", "ok", "ok"] },
    ],
  },
  ssh: {
    id: "task-2611",
    name: "SSH key + mesh ssh · key=root@archmbp · rotate",
    startedAt: "11:42:08",
    finishedAt: "11:42:26",
    elapsed: "18.1s",
    steps: ["probe", "upload key", "authz", "config", "verify"],
    rows: [
      { node: "archmbp", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok", "ok"] },
      { node: "nuc-arch", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok", "ok"] },
      { node: "work-mbp", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok", "ok"] },
      { node: "aliyun-hk", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok", "ok"] },
      { node: "aliyun-sg", mesh: "online", agent: "online", cells: ["ok", "ok", "ok", "ok", "ok"] },
      {
        node: "homelab-01",
        mesh: "online",
        agent: "online",
        cells: ["ok", "ok", "ok", "ok", "ok"],
      },
      {
        node: "rpi-edge",
        mesh: "degraded",
        agent: "online",
        cells: ["ok", "ok", "ok", "warn", "ok"],
      },
      {
        node: "nas-truenas",
        mesh: "online",
        agent: "offline",
        cells: ["ok", "ok", "ok", "ok", "ok"],
      },
      {
        node: "vps-fly",
        mesh: "offline",
        agent: "offline",
        cells: ["fail", "skip", "skip", "skip", "skip"],
        failStep: 0,
      },
      {
        node: "proxmox-01",
        mesh: "online",
        agent: "online",
        cells: ["ok", "ok", "ok", "ok", "ok"],
      },
      {
        node: "oracle-fra",
        mesh: "offline",
        agent: "online",
        cells: ["ok", "ok", "ok", "ok", "ok"],
      },
    ],
  },
};

export interface HistoryItem {
  id: string;
  cap: string;
  summary: string;
  when: string;
  ok: number;
  total: number;
  status: "running" | "partial" | "ok";
}

export const TASK_HISTORY: HistoryItem[] = [
  {
    id: "task-2615",
    cap: "dns",
    summary: "DNS · mesh.cobweb.lan",
    when: "just now",
    ok: 6,
    total: 11,
    status: "running",
  },
  {
    id: "task-2614",
    cap: "ca",
    summary: "CA · kube-int-ca-2026q2",
    when: "2m ago",
    ok: 9,
    total: 11,
    status: "partial",
  },
  {
    id: "task-2613",
    cap: "ssh",
    summary: "SSH · authz reset (oracle-fra)",
    when: "14m ago",
    ok: 11,
    total: 11,
    status: "ok",
  },
  {
    id: "task-2611",
    cap: "ssh",
    summary: "SSH · key rotate root@archmbp",
    when: "21m ago",
    ok: 10,
    total: 11,
    status: "partial",
  },
  {
    id: "task-2608",
    cap: "dns",
    summary: "DNS · clear stale fwd zone",
    when: "1h ago",
    ok: 11,
    total: 11,
    status: "ok",
  },
  {
    id: "task-2602",
    cap: "ca",
    summary: "CA · stage-ca rollout",
    when: "yesterday",
    ok: 11,
    total: 11,
    status: "ok",
  },
];

export interface FailDetail {
  cmd: string;
  exit: number;
  duration: string;
  stderr: string;
}

export const FAIL_DETAIL: Record<string, FailDetail> = {
  "aliyun-hk:ca:install": {
    cmd: "sudo update-ca-certificates --fresh",
    exit: 1,
    duration: "0.78s",
    stderr: `+ sudo update-ca-certificates --fresh
Clearing symlinks in /etc/ssl/certs...
done.
Updating certificates in /etc/ssl/certs...
rehash: warning: skipping ca-certificates.crt, it does not contain exactly one certificate or CRL
0 added, 0 removed; done.
Running hooks in /etc/ca-certificates/update.d...
update-ca-certificates: Permission denied: /usr/local/share/ca-certificates/kube-int.crt
update-ca-certificates: failed to write /etc/ssl/certs/kube-int.pem
done.
exit code 1`,
  },
  "vps-fly:ca:probe": {
    cmd: "easytier-cli probe vps-fly --timeout=5s",
    exit: 124,
    duration: "5.01s",
    stderr: `+ easytier-cli probe vps-fly --timeout=5s
2026-05-15T12:03:54.182Z  INFO probing peer vps-fly via wg
2026-05-15T12:03:59.183Z  WARN no response in 5.0s (5/5 retries failed)
2026-05-15T12:03:59.184Z  ERROR peer vps-fly unreachable (last seen 4h12m ago)
exit code 124 (timeout)`,
  },
};

// ────────────────────────────────────────────────────────────────────
//  Sparkline series generator
// ────────────────────────────────────────────────────────────────────

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
