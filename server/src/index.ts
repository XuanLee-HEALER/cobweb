// cobweb backend — Hono RPC over Bun.
// Run: bun src/index.ts (or via root justfile `just serve` / `just dev`).

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

function defaultCliPath(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE ?? "C:\\Users\\Default";
    return `${userProfile}\\bin\\easytier\\easytier-cli.exe`;
  }
  return "/usr/local/bin/easytier-cli";
}

const RPC = process.env.ET_RPC ?? "127.0.0.1:15888";
const PORT = Number(process.env.PORT ?? 8088);
const HOST = process.env.HOST ?? "127.0.0.1";
const CLI = process.env.ET_CLI ?? defaultCliPath();
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS ?? 5000);
const HISTORY_LEN = Number(process.env.HISTORY_LEN ?? 720);
// import.meta.dir is server/src/. Anchor runtime paths to the repo root so
// nodes.json / ed25519 keys / dashboard/dist resolve consistently no matter
// where `bun start` is invoked from.
const SERVER_SRC = import.meta.dir;
const REPO_ROOT = join(SERVER_SRC, "..", "..");
const DIST = join(REPO_ROOT, "dashboard", "dist");
const NODES_FILE = join(REPO_ROOT, "nodes.json");
const KEY_PATH = join(REPO_ROOT, "etmesh-id_ed25519");
const KEY_PUB_PATH = `${KEY_PATH}.pub`;
const REMOTE_KEY_NAME = "etmesh-id_ed25519";
const FENCE_BEGIN = "# etmesh BEGIN (managed by dashboard, do not edit)";
const FENCE_END = "# etmesh END";
const AUTHORIZED_KEYS_TAG = "etmesh-managed";

// DNS dispatch (per-domain DNS to aliyun CoreDNS)
const DNS_FENCE_BEGIN = "# etmesh-dns BEGIN (managed by dashboard)";
const DNS_FENCE_END = "# etmesh-dns END";
const DNS_SERVER_IP = process.env.DNS_SERVER_IP ?? "10.177.0.1";
const DNS_DOMAIN = process.env.DNS_DOMAIN ?? "lan";
const DNS_TEST_HOST = process.env.DNS_TEST_HOST ?? "archmbp.lan";
const DNS_EXPECTED_IP = process.env.DNS_EXPECTED_IP ?? "10.177.0.6";
const DNS_NRPT_TAG = "etmesh-managed";

// Trust CA distribution (cluster root CA → every node's trust store)
const CA_CACHE_PATH = join(REPO_ROOT, "etmesh-ca.crt");
const CA_REMOTE_NODE = process.env.CA_REMOTE_NODE ?? "archmbp";
const CA_KUBECTL_CMD =
  process.env.CA_KUBECTL_CMD ??
  "kubectl get secret -n cert-manager etmesh-root-ca -o jsonpath='{.data.ca\\.crt}' | base64 -d";
const CA_REMOTE_FILENAME = "etmesh-root-ca.crt";
const CA_CN = "etmesh-root-ca";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

// ────── easytier-cli ──────────────────────────────────────────────────────

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

// Shape consumed by the UI's task result matrix.
export type CellKind = "ok" | "fail" | "warn" | "skip" | "run" | "queue";
export interface TaskRow {
  node: string;
  mesh: "online" | "degraded" | "offline";
  agent: "online" | "offline";
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
  failDetails?: Record<string, { cmd: string; exit: number; duration: string; stderr: string }>;
}

async function cli<T = unknown>(args: string[]): Promise<T> {
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

// ────── sampler / history ─────────────────────────────────────────────────

interface PeerSample {
  hostname: string;
  ipv4: string;
  cost: string;
  lat_ms: number | null;
  loss_pct: number;
  rx_bytes: number;
  tx_bytes: number;
}
interface Sample {
  ts: number;
  peers: Record<string, PeerSample>;
  totals: { rx_bytes: number; tx_bytes: number };
}

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

// Internal pub/sub for SSE clients. Two channels: per-sample local view
// (the sampler runs on this node, every SAMPLE_INTERVAL_MS) and the global
// peer-center view (cli "peer-center", same cadence).
const events = new EventEmitter();

const samples: Sample[] = [];
let latestPeerCenter: PeerCenterEntry[] = [];
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
    let totalRx = 0,
      totalTx = 0;
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
sampleLoop();
setInterval(sampleLoop, SAMPLE_INTERVAL_MS);

// ────── mesh: nodes + ssh ops ─────────────────────────────────────────────

type NodeOS = "linux" | "macos" | "windows";
interface MeshNode {
  name: string;
  ip: string;
  user: string;
  port: number;
  os: NodeOS;
  managed: boolean;
}

function loadNodes(): MeshNode[] {
  if (!existsSync(NODES_FILE)) return [];
  return JSON.parse(readFileSync(NODES_FILE, "utf8")) as MeshNode[];
}

const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=10",
];

function targetOf(n: MeshNode): string {
  return `${n.user}@${n.ip}`;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function sshExec(n: MeshNode, command: string): Promise<ExecResult> {
  const proc = Bun.spawn(["ssh", ...SSH_OPTS, "-p", String(n.port), targetOf(n), command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function sshExecWithStdin(n: MeshNode, command: string, stdin: string): Promise<ExecResult> {
  const proc = Bun.spawn(["ssh", ...SSH_OPTS, "-p", String(n.port), targetOf(n), command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function sftpPut(n: MeshNode, localPath: string, remotePath: string): Promise<void> {
  const batch = `put ${localPath} ${remotePath}\nbye\n`;
  const proc = Bun.spawn(["sftp", ...SSH_OPTS, "-P", String(n.port), "-b", "-", targetOf(n)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(batch);
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`sftp put ${remotePath} failed: ${stderr.trim()}`);
}

async function sftpGet(n: MeshNode, remotePath: string): Promise<string | null> {
  const tmp = join(tmpdir(), `etmesh-get-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const batch = `get ${remotePath} ${tmp}\nbye\n`;
  const proc = Bun.spawn(["sftp", ...SSH_OPTS, "-P", String(n.port), "-b", "-", targetOf(n)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(batch);
  proc.stdin.end();
  await proc.exited;
  if (!existsSync(tmp)) return null;
  const buf = readFileSync(tmp, "utf8");
  try {
    unlinkSync(tmp);
  } catch {}
  return buf;
}

// Fence helpers ────────────────────────────────────────────────────────────

function stripFenced(text: string, begin: string, end: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const ln of lines) {
    if (!inside && ln.trim() === begin.trim()) {
      inside = true;
      continue;
    }
    if (inside && ln.trim() === end.trim()) {
      inside = false;
      continue;
    }
    if (!inside) out.push(ln);
  }
  return out.join("\n");
}

function buildSshConfigBlock(nodes: MeshNode[]): string {
  const lines: string[] = [FENCE_BEGIN];
  for (const n of nodes) {
    lines.push(`Host ${n.name}`);
    lines.push(`    HostName ${n.ip}`);
    lines.push(`    User ${n.user}`);
    if (n.port !== 22) lines.push(`    Port ${n.port}`);
    lines.push(`    IdentityFile ~/.ssh/${REMOTE_KEY_NAME}`);
    lines.push(`    IdentitiesOnly yes`);
    lines.push("");
  }
  lines.push(FENCE_END);
  return lines.join("\n");
}

function ensureFinalNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

function appendIfMissing(text: string, line: string, marker: string): string {
  // skip if a line containing the marker already exists
  for (const ln of text.split(/\r?\n/)) {
    if (ln.includes(marker)) return text;
  }
  return `${ensureFinalNewline(text) + line}\n`;
}

// Per-OS commands ──────────────────────────────────────────────────────────

interface OsOps {
  ensureSshDir: string; // command to mkdir ~/.ssh with right perms
  authorizedKeysPath: string; // remote path string used in shell
  sshConfigPath: string;
  keyPrivPath: string;
  keyPubPath: string;
  // After we put files via sftp, fix perms
  fixKeyPerms: string;
  fixSshDirPerms: string;
}

function opsFor(n: MeshNode): OsOps {
  if (n.os === "windows") {
    // OpenSSH for Windows: %USERPROFILE%\.ssh stores private key + ssh config.
    // BUT authorized_keys is special: if the SSH user is in the Administrators
    // group, sshd reads ProgramData\ssh\administrators_authorized_keys and
    // IGNORES ~/.ssh/authorized_keys (this is the default sshd_config Match
    // Group rule). Mesh users are typically admins, so target the admin file.
    return {
      ensureSshDir: `powershell -NoProfile -Command "New-Item -Type Directory -Force ~\\.ssh | Out-Null"`,
      // SFTP path: leading "/" is required for absolute paths (otherwise the
      // path is resolved relative to the user's home dir).
      authorizedKeysPath: "/C:/ProgramData/ssh/administrators_authorized_keys",
      sshConfigPath: ".ssh/config",
      keyPrivPath: `.ssh/${REMOTE_KEY_NAME}`,
      keyPubPath: `.ssh/${REMOTE_KEY_NAME}.pub`,
      // Windows OpenSSH requires user-only ACL on private key.
      // Use the node's known user from nodes.json instead of $env:USERNAME —
      // when sshd spawns a sub-PowerShell via -Command, USERNAME is sometimes
      // empty in that scope, leading to icacls "/grant:r :F" → invalid.
      fixKeyPerms: `powershell -NoProfile -Command "icacls $env:USERPROFILE\\.ssh\\${REMOTE_KEY_NAME} /inheritance:r /grant:r ${n.user}:F | Out-Null"`,
      fixSshDirPerms: `powershell -NoProfile -Command "Write-Host ok"`,
    };
  }
  // POSIX (linux/macos)
  return {
    ensureSshDir: `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
    authorizedKeysPath: ".ssh/authorized_keys",
    sshConfigPath: ".ssh/config",
    keyPrivPath: `.ssh/${REMOTE_KEY_NAME}`,
    keyPubPath: `.ssh/${REMOTE_KEY_NAME}.pub`,
    fixKeyPerms: `chmod 600 ~/.ssh/${REMOTE_KEY_NAME} && chmod 644 ~/.ssh/${REMOTE_KEY_NAME}.pub`,
    fixSshDirPerms: `chmod 700 ~/.ssh`,
  };
}

// Mesh operations ──────────────────────────────────────────────────────────

interface NodeStatus {
  name: string;
  reachable: boolean;
  hasKey: boolean;
  authorizedHasKey: boolean;
  configHasFence: boolean;
  configFenceMatches: boolean;
  message?: string;
}

function loadOrThrowKeyPub(): string {
  if (!existsSync(KEY_PUB_PATH)) {
    throw new Error(`mesh public key not found at ${KEY_PUB_PATH}; call /api/mesh/init-keys first`);
  }
  return readFileSync(KEY_PUB_PATH, "utf8").trim();
}

async function meshStatus(): Promise<{ keys_initialized: boolean; nodes: NodeStatus[] }> {
  const nodes = loadNodes();
  const haveKey = existsSync(KEY_PATH) && existsSync(KEY_PUB_PATH);
  const expectedPubLine = haveKey ? readFileSync(KEY_PUB_PATH, "utf8").trim() : "";
  const expectedConfig = buildSshConfigBlock(nodes);

  const results: NodeStatus[] = [];
  await Promise.all(
    nodes
      .filter((n) => n.managed)
      .map(async (n) => {
        const r: NodeStatus = {
          name: n.name,
          reachable: false,
          hasKey: false,
          authorizedHasKey: false,
          configHasFence: false,
          configFenceMatches: false,
        };
        try {
          // probe via ssh
          const probe = await sshExec(
            n,
            n.os === "windows" ? `powershell -NoProfile -Command "Write-Host ok"` : `echo ok`,
          );
          r.reachable = probe.code === 0;
          if (!r.reachable) {
            r.message = (probe.stderr || probe.stdout || "no output").trim();
            results.push(r);
            return;
          }

          const ak = (await sftpGet(n, opsFor(n).authorizedKeysPath)) ?? "";
          const cfg = (await sftpGet(n, opsFor(n).sshConfigPath)) ?? "";
          const priv = (await sftpGet(n, opsFor(n).keyPrivPath)) ?? null;
          r.hasKey = priv != null && priv.length > 0;
          r.authorizedHasKey =
            haveKey && ak.split(/\r?\n/).some((ln) => ln.includes(expectedPubLine));
          r.configHasFence = cfg.includes(FENCE_BEGIN) && cfg.includes(FENCE_END);
          r.configFenceMatches = cfg.includes(expectedConfig);
        } catch (e) {
          r.message = String(e);
        }
        results.push(r);
      }),
  );
  return { keys_initialized: haveKey, nodes: results };
}

async function meshInitKeys(force = false): Promise<{ generated: boolean; pub: string }> {
  if (!force && existsSync(KEY_PATH) && existsSync(KEY_PUB_PATH)) {
    return { generated: false, pub: readFileSync(KEY_PUB_PATH, "utf8") };
  }
  // Remove old key (if force)
  if (existsSync(KEY_PATH)) unlinkSync(KEY_PATH);
  if (existsSync(KEY_PUB_PATH)) unlinkSync(KEY_PUB_PATH);
  const proc = Bun.spawn(
    ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "etmesh-managed", "-f", KEY_PATH],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ssh-keygen failed: ${err.trim()}`);
  }
  chmodSync(KEY_PATH, 0o600);
  return { generated: true, pub: readFileSync(KEY_PUB_PATH, "utf8") };
}

interface ApplyLog {
  node: string;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
}

async function meshApply(): Promise<{ logs: ApplyLog[] }> {
  const nodes = loadNodes();
  const managed = nodes.filter((n) => n.managed);
  if (!existsSync(KEY_PATH))
    throw new Error("keys not initialized; call /api/mesh/init-keys first");
  const pub = loadOrThrowKeyPub();
  const expectedConfig = buildSshConfigBlock(nodes);
  const authorizedLine = `${pub.split(/\s+/).slice(0, 2).join(" ")} ${AUTHORIZED_KEYS_TAG}`;

  const logs: ApplyLog[] = [];
  for (const n of managed) {
    const log: ApplyLog = { node: n.name, steps: [] };
    const ops = opsFor(n);
    const record = (step: string, ok: boolean, detail?: string) =>
      log.steps.push({ step, ok, detail });
    try {
      // 1. ensure ~/.ssh exists with proper perms
      const r1 = await sshExec(n, ops.ensureSshDir);
      record("mkdir ~/.ssh", r1.code === 0, r1.code === 0 ? undefined : r1.stderr || r1.stdout);
      if (r1.code !== 0) {
        logs.push(log);
        continue;
      }

      // 2. put private key
      try {
        await sftpPut(n, KEY_PATH, ops.keyPrivPath);
        record("put private key", true);
      } catch (e) {
        record("put private key", false, String(e));
        logs.push(log);
        continue;
      }

      // 3. put public key
      try {
        await sftpPut(n, KEY_PUB_PATH, ops.keyPubPath);
        record("put public key", true);
      } catch (e) {
        record("put public key", false, String(e));
        logs.push(log);
        continue;
      }

      // 4. fix key permissions
      const r4 = await sshExec(n, ops.fixKeyPerms);
      record("fix key perms", r4.code === 0, r4.code === 0 ? undefined : r4.stderr || r4.stdout);

      // 5. merge authorized_keys
      const akCurrent = (await sftpGet(n, ops.authorizedKeysPath)) ?? "";
      const akNew = appendIfMissing(akCurrent, authorizedLine, AUTHORIZED_KEYS_TAG);
      if (akNew !== akCurrent) {
        const tmp = join(tmpdir(), `etmesh-ak-${n.name}-${Date.now()}`);
        writeFileSync(tmp, akNew);
        try {
          await sftpPut(n, tmp, ops.authorizedKeysPath);
          record("merge authorized_keys", true);
        } catch (e) {
          record("merge authorized_keys", false, String(e));
        } finally {
          try {
            unlinkSync(tmp);
          } catch {}
        }
      } else {
        record("merge authorized_keys", true, "already present");
      }
      // fix authorized_keys perms (Windows needs ACL)
      if (n.os === "windows") {
        // administrators_authorized_keys must be writable only by Administrators
        // and SYSTEM, otherwise sshd refuses to read it. Bare names (no quotes)
        // — cmd doesn't treat single quotes as string delimiters, so quoting
        // would pass literal apostrophes to icacls and break it.
        const r5 = await sshExec(
          n,
          `powershell -NoProfile -Command "icacls C:\\ProgramData\\ssh\\administrators_authorized_keys /inheritance:r /grant:r Administrators:F /grant:r SYSTEM:F | Out-Null"`,
        );
        record(
          "fix authorized_keys ACL",
          r5.code === 0,
          r5.code === 0 ? undefined : r5.stderr || r5.stdout,
        );
      } else {
        const r5 = await sshExec(n, `chmod 600 ~/.ssh/authorized_keys`);
        record(
          "chmod authorized_keys",
          r5.code === 0,
          r5.code === 0 ? undefined : r5.stderr || r5.stdout,
        );
      }

      // 6. merge ssh config (replace fence)
      const cfgCurrent = (await sftpGet(n, ops.sshConfigPath)) ?? "";
      const cfgStripped = stripFenced(cfgCurrent, FENCE_BEGIN, FENCE_END);
      const cfgNew = `${ensureFinalNewline(cfgStripped) + expectedConfig}\n`;
      if (cfgNew !== cfgCurrent) {
        const tmp = join(tmpdir(), `etmesh-cfg-${n.name}-${Date.now()}`);
        writeFileSync(tmp, cfgNew);
        try {
          await sftpPut(n, tmp, ops.sshConfigPath);
          record("merge ssh config", true);
        } catch (e) {
          record("merge ssh config", false, String(e));
        } finally {
          try {
            unlinkSync(tmp);
          } catch {}
        }
      } else {
        record("merge ssh config", true, "already up to date");
      }
    } catch (e) {
      record("FATAL", false, String(e));
    }
    logs.push(log);
  }
  return { logs };
}

// ────── DNS dispatch ──────────────────────────────────────────────────────
// Pushes a per-domain DNS rule (DNS_DOMAIN → DNS_SERVER_IP) to each managed
// node so they can resolve `.lan` via aliyun CoreDNS without going through
// the LAN router. Linux uses systemd-resolved drop-in; macOS uses
// /etc/resolver/<domain>; Windows uses NRPT.
//
// Sudoers prerequisite (POSIX nodes, NOPASSWD), one line per node:
//   <user> ALL=(ALL) NOPASSWD: /usr/bin/install, /usr/bin/tee, /usr/bin/systemctl
// (aliyun is already root, no sudoers needed.)

interface DnsOps {
  applyCmd: string; // shell command to write config file + reload resolver
  statusFileCheck: string; // stdout="OK" iff config is in place
  digCmd: string; // stdout = first IP returned for DNS_TEST_HOST
}

function dnsOpsFor(n: MeshNode): DnsOps {
  if (n.os === "linux") {
    const filePath = "/etc/systemd/resolved.conf.d/etmesh-lan.conf";
    // Use printf | tee instead of heredoc — heredoc is bash/zsh syntax,
    // not portable to fish (which is the default shell on archmbp).
    return {
      applyCmd:
        `sudo /usr/bin/install -d -m 0755 /etc/systemd/resolved.conf.d && ` +
        `printf '%s\\n' ` +
        `'${DNS_FENCE_BEGIN}' ` +
        `'[Resolve]' ` +
        `'DNS=${DNS_SERVER_IP}' ` +
        `'Domains=~${DNS_DOMAIN}' ` +
        `'${DNS_FENCE_END}' ` +
        `| sudo /usr/bin/tee ${filePath} > /dev/null && ` +
        `sudo /usr/bin/systemctl restart systemd-resolved`,
      statusFileCheck:
        `[ -f ${filePath} ] && grep -q "DNS=${DNS_SERVER_IP}" ${filePath} && ` +
        `grep -q "Domains=~${DNS_DOMAIN}" ${filePath} && echo OK || echo MISS`,
      // ahostsv4 forces A records; getent hosts can return AAAA first.
      digCmd: `getent ahostsv4 ${DNS_TEST_HOST} 2>/dev/null | awk 'NR==1{print $1}'`,
    };
  }
  if (n.os === "macos") {
    const filePath = `/etc/resolver/${DNS_DOMAIN}`;
    return {
      applyCmd:
        `sudo /usr/bin/install -d -m 0755 /etc/resolver && ` +
        `printf '%s\\n' ` +
        `'${DNS_FENCE_BEGIN}' ` +
        `'nameserver ${DNS_SERVER_IP}' ` +
        `'${DNS_FENCE_END}' ` +
        `| sudo /usr/bin/tee ${filePath} > /dev/null`,
      statusFileCheck: `[ -f ${filePath} ] && grep -q "nameserver ${DNS_SERVER_IP}" ${filePath} && echo OK || echo MISS`,
      // dscacheutil queries via mDNSResponder, which IS what /etc/resolver/<domain>
      // affects. host(1) and nslookup are BIND tools that bypass mDNSResponder,
      // so they would always miss the per-domain DNS rule.
      digCmd: `dscacheutil -q host -a name ${DNS_TEST_HOST} 2>/dev/null | awk '/^ip_address:/{print $2; exit}'`,
    };
  }
  // windows: NRPT rule (registry-persisted, takes effect immediately)
  const psApply = [
    `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${DNS_NRPT_TAG}' } | Remove-DnsClientNrptRule -Force -ErrorAction SilentlyContinue`,
    `Add-DnsClientNrptRule -Namespace '.${DNS_DOMAIN}' -NameServers '${DNS_SERVER_IP}' -Comment '${DNS_NRPT_TAG}' | Out-Null`,
    `Write-Output OK`,
  ].join("; ");
  const psStatus = `if (Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${DNS_NRPT_TAG}' }) { Write-Output OK } else { Write-Output MISS }`;
  const psDig = `(Resolve-DnsName -Name '${DNS_TEST_HOST}' -Type A -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress -First 1)`;
  // Quotes inside double-quoted -Command: PowerShell handles single-quoted strings fine.
  return {
    applyCmd: `powershell -NoProfile -Command "${psApply}"`,
    statusFileCheck: `powershell -NoProfile -Command "${psStatus}"`,
    digCmd: `powershell -NoProfile -Command "${psDig}"`,
  };
}

interface DnsNodeStatus {
  name: string;
  os: NodeOS;
  reachable: boolean;
  configured: boolean;
  resolves: boolean;
  resolvedIp?: string;
  message?: string;
}

async function dnsStatus(): Promise<{
  server: string;
  domain: string;
  expected: string;
  nodes: DnsNodeStatus[];
}> {
  const nodes = loadNodes().filter((n) => n.managed);
  const results: DnsNodeStatus[] = [];
  await Promise.all(
    nodes.map(async (n) => {
      const r: DnsNodeStatus = {
        name: n.name,
        os: n.os,
        reachable: false,
        configured: false,
        resolves: false,
      };
      try {
        const ops = dnsOpsFor(n);
        const probe = await sshExec(
          n,
          n.os === "windows" ? `powershell -NoProfile -Command "Write-Host ok"` : `echo ok`,
        );
        r.reachable = probe.code === 0;
        if (!r.reachable) {
          r.message = (probe.stderr || probe.stdout || "ssh probe failed").trim();
        } else {
          const [statusR, digR] = await Promise.all([
            sshExec(n, ops.statusFileCheck),
            sshExec(n, ops.digCmd),
          ]);
          r.configured = statusR.stdout.trim().includes("OK");
          const ip = digR.stdout.trim();
          r.resolvedIp = ip || undefined;
          r.resolves = ip === DNS_EXPECTED_IP;
        }
      } catch (e) {
        r.message = String(e);
      }
      results.push(r);
    }),
  );
  return { server: DNS_SERVER_IP, domain: DNS_DOMAIN, expected: DNS_EXPECTED_IP, nodes: results };
}

async function dnsApply(): Promise<{ logs: ApplyLog[] }> {
  const nodes = loadNodes().filter((n) => n.managed);
  // Nodes run in parallel; Promise.all preserves input order in the result.
  const logs = await Promise.all(
    nodes.map(async (n): Promise<ApplyLog> => {
      const log: ApplyLog = { node: n.name, steps: [] };
      const record = (step: string, ok: boolean, detail?: string) =>
        log.steps.push({ step, ok, detail });
      try {
        const ops = dnsOpsFor(n);
        const probe = await sshExec(
          n,
          n.os === "windows" ? `powershell -NoProfile -Command "Write-Host ok"` : `echo ok`,
        );
        if (probe.code !== 0) {
          record("ssh probe", false, (probe.stderr || probe.stdout || "").trim());
          return log;
        }
        record("ssh probe", true);

        // Fast path: if already configured AND resolves to the expected IP, skip
        // the apply (avoids restarting systemd-resolved / churning NRPT on re-apply).
        const [preStatus, preDig] = await Promise.all([
          sshExec(n, ops.statusFileCheck),
          sshExec(n, ops.digCmd),
        ]);
        if (preStatus.stdout.trim().includes("OK") && preDig.stdout.trim() === DNS_EXPECTED_IP) {
          record("already configured", true, `→ ${preDig.stdout.trim()}`);
          return log;
        }

        const r2 = await sshExec(n, ops.applyCmd);
        if (r2.code !== 0) {
          record("apply dns config", false, (r2.stderr || r2.stdout || "").trim());
          return log;
        }
        record("apply dns config", true);

        const r3 = await sshExec(n, ops.statusFileCheck);
        const okFile = r3.stdout.trim().includes("OK");
        record("verify config", okFile, okFile ? undefined : (r3.stderr || r3.stdout || "").trim());

        const r4 = await sshExec(n, ops.digCmd);
        const ip = r4.stdout.trim();
        const okDig = ip === DNS_EXPECTED_IP;
        const detail = ip
          ? okDig
            ? `→ ${ip}`
            : `→ ${ip} (expected ${DNS_EXPECTED_IP})`
          : (r4.stderr || "no answer").trim();
        record(`resolve ${DNS_TEST_HOST}`, okDig, detail);
      } catch (e) {
        record("FATAL", false, String(e));
      }
      return log;
    }),
  );
  return { logs };
}

// ────── Trust CA distribution ─────────────────────────────────────────────
// Pulls the cluster root CA cert from CA_REMOTE_NODE via SSH (kubectl) and
// installs it into each managed node's OS trust store. Idempotent: status
// check compares the installed cert's SHA-256 against the expected one and
// skips re-install if it matches.

function pemToDerSha256(pem: string): string {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!m) throw new Error("invalid PEM cert (no BEGIN/END markers)");
  const der = Buffer.from(m[1]!.replace(/\s/g, ""), "base64");
  return createHash("sha256").update(der).digest("hex");
}

async function fetchCaCert(): Promise<string> {
  const nodes = loadNodes();
  const remote = nodes.find((n) => n.name === CA_REMOTE_NODE);
  if (!remote) throw new Error(`CA_REMOTE_NODE "${CA_REMOTE_NODE}" not found in nodes.json`);
  const r = await sshExec(remote, CA_KUBECTL_CMD);
  if (r.code !== 0 || !r.stdout.includes("BEGIN CERTIFICATE")) {
    throw new Error(
      `fetch CA from ${CA_REMOTE_NODE} failed: ${(r.stderr || r.stdout || "no output").trim()}`,
    );
  }
  writeFileSync(CA_CACHE_PATH, r.stdout);
  return r.stdout;
}

function _loadOrThrowCaCert(): string {
  if (!existsSync(CA_CACHE_PATH)) {
    throw new Error(
      `CA cert not yet cached; call POST /api/mesh/ca/refresh or /api/mesh/ca/apply first`,
    );
  }
  return readFileSync(CA_CACHE_PATH, "utf8");
}

interface CaOps {
  uploadPath: string; // sftp put destination
  installCmd: string; // sudo install + run trust update
  statusCmd: string; // stdout="OK" iff installed AND sha256 matches expected
}

function caOpsFor(n: MeshNode, expectedSha256: string): CaOps {
  if (n.os === "linux") {
    const tmp = `/tmp/${CA_REMOTE_FILENAME}.staging`;
    // Multi-line bash script delivered via stdin (sshExecWithStdin + "bash -s")
    // so we don't depend on the remote login shell — archmbp uses fish, which
    // doesn't grok bash's if/elif/fi.
    return {
      uploadPath: tmp,
      installCmd:
        `set -e\n` +
        `if [ -f /etc/arch-release ]; then\n` +
        `  sudo /usr/bin/install -m 644 -o root -g root ${tmp} /etc/ca-certificates/trust-source/anchors/${CA_REMOTE_FILENAME}\n` +
        `  sudo /usr/bin/trust extract-compat\n` +
        `elif [ -f /etc/debian_version ]; then\n` +
        `  sudo /usr/bin/install -m 644 -o root -g root ${tmp} /usr/local/share/ca-certificates/${CA_REMOTE_FILENAME}\n` +
        `  sudo /usr/sbin/update-ca-certificates\n` +
        `else\n` +
        `  echo unsupported-distro >&2; exit 1\n` +
        `fi\n` +
        `rm -f ${tmp}\n`,
      // Compare DER form sha256 (matches what server computed via pemToDerSha256),
      // not the entire PEM file sha256.
      statusCmd:
        `if [ -f /etc/arch-release ]; then F=/etc/ca-certificates/trust-source/anchors/${CA_REMOTE_FILENAME}\n` +
        `elif [ -f /etc/debian_version ]; then F=/usr/local/share/ca-certificates/${CA_REMOTE_FILENAME}\n` +
        `else echo MISS; exit 0\n` +
        `fi\n` +
        `if [ ! -f "$F" ]; then echo MISS; exit 0; fi\n` +
        `S=$(openssl x509 -in "$F" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)\n` +
        `[ "$S" = "${expectedSha256}" ] && echo OK || echo MISS\n`,
    };
  }
  if (n.os === "macos") {
    const tmp = `/tmp/${CA_REMOTE_FILENAME}.staging`;
    return {
      uploadPath: tmp,
      // Note: `security add-trusted-cert -k /Library/Keychains/System.keychain`
      // requires GUI authorization on macOS even under sudo; it WILL fail in a
      // non-interactive SSH session with "SecTrustSettingsSetTrustSettings:
      // The authorization was denied since no user interaction was possible."
      // The cert still gets imported into the keychain though (status check
      // will read OK). For full trust the user must run the command from a
      // GUI Terminal.app session once. We try -p ssl which sometimes works.
      installCmd:
        `set -e\n` +
        `sudo /usr/bin/security delete-certificate -c "${CA_CN}" /Library/Keychains/System.keychain 2>/dev/null || true\n` +
        `if ! sudo /usr/bin/security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain ${tmp} 2>&1; then\n` +
        `  echo "" >&2\n` +
        `  echo "macOS blocks non-interactive trust setting. Run this in a GUI Terminal once:" >&2\n` +
        `  echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${tmp}" >&2\n` +
        `  exit 1\n` +
        `fi\n` +
        `rm -f ${tmp}\n`,
      statusCmd:
        `T=$(sudo /usr/bin/security find-certificate -c ${CA_CN} -p /Library/Keychains/System.keychain 2>/dev/null)\n` +
        `if [ -z "$T" ]; then echo MISS; exit 0; fi\n` +
        `S=$(echo "$T" | /usr/bin/openssl x509 -outform DER 2>/dev/null | /usr/bin/shasum -a 256 | cut -d' ' -f1)\n` +
        `[ "$S" = "${expectedSha256}" ] && echo OK || echo MISS\n`,
    };
  }
  // windows: drop file via sftp under user's home (forward slash works on OpenSSH server),
  // then certutil -addstore (needs admin, granted because lixuan is in Administrators group).
  const winTmp = `etmesh-ca-staging.crt`; // relative to user home
  const psInstall = [
    `certutil -addstore -f Root $env:USERPROFILE\\${winTmp} | Out-Null`,
    `Remove-Item $env:USERPROFILE\\${winTmp} -Force -ErrorAction SilentlyContinue`,
    `Write-Output OK`,
  ].join("; ");
  // Status: enumerate Cert:\LocalMachine\Root and compare RawData SHA-256.
  // Cert: drive needs PKI module which Windows PowerShell ships with;
  // PowerShell 7 may need explicit Import-Module pki.
  const psStatus =
    `try { Import-Module pki -ErrorAction Stop } catch { Write-Output MISS; exit 0 }; ` +
    `$c = Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Subject -like '*${CA_CN}*' } | Select-Object -First 1; ` +
    `if ($c) { ` +
    `$sha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)).Replace('-','').ToLower(); ` +
    `if ($sha -eq '${expectedSha256}') { Write-Output OK } else { Write-Output MISS } ` +
    `} else { Write-Output MISS }`;
  return {
    uploadPath: winTmp,
    installCmd: `powershell -NoProfile -Command "${psInstall}"`,
    statusCmd: `powershell -NoProfile -Command "${psStatus}"`,
  };
}

interface CaNodeStatus {
  name: string;
  os: NodeOS;
  reachable: boolean;
  trusted: boolean;
  message?: string;
}

// Linux/macOS receive scripts via stdin (bash -s) to avoid the remote login
// shell mangling our bash syntax (archmbp uses fish). Windows nodes get the
// command as a normal ssh arg (powershell -NoProfile -Command "...").
async function caRunScript(n: MeshNode, script: string): Promise<ExecResult> {
  if (n.os === "windows") return sshExec(n, script);
  return sshExecWithStdin(n, "bash -s", script);
}

async function caStatus(): Promise<{ sha256: string; subject: string; nodes: CaNodeStatus[] }> {
  const cert = existsSync(CA_CACHE_PATH)
    ? readFileSync(CA_CACHE_PATH, "utf8")
    : await fetchCaCert();
  const expectedSha = pemToDerSha256(cert);
  const subject = CA_CN;

  const nodes = loadNodes().filter((n) => n.managed);
  const results = await Promise.all(
    nodes.map(async (n): Promise<CaNodeStatus> => {
      const r: CaNodeStatus = { name: n.name, os: n.os, reachable: false, trusted: false };
      try {
        const probe = await sshExec(
          n,
          n.os === "windows" ? `powershell -NoProfile -Command "Write-Host ok"` : `echo ok`,
        );
        r.reachable = probe.code === 0;
        if (!r.reachable) {
          r.message = (probe.stderr || probe.stdout || "ssh probe failed").trim();
          return r;
        }
        const ops = caOpsFor(n, expectedSha);
        const status = await caRunScript(n, ops.statusCmd);
        r.trusted = status.stdout.trim().includes("OK");
      } catch (e) {
        r.message = String(e);
      }
      return r;
    }),
  );
  return { sha256: expectedSha, subject, nodes: results };
}

async function caApply(): Promise<{ logs: ApplyLog[]; sha256: string }> {
  // Always refresh from cluster — cert may have rotated.
  const cert = await fetchCaCert();
  const expectedSha = pemToDerSha256(cert);

  const nodes = loadNodes().filter((n) => n.managed);
  const logs = await Promise.all(
    nodes.map(async (n): Promise<ApplyLog> => {
      const log: ApplyLog = { node: n.name, steps: [] };
      const record = (step: string, ok: boolean, detail?: string) =>
        log.steps.push({ step, ok, detail });
      try {
        const ops = caOpsFor(n, expectedSha);

        const probe = await sshExec(
          n,
          n.os === "windows" ? `powershell -NoProfile -Command "Write-Host ok"` : `echo ok`,
        );
        if (probe.code !== 0) {
          record("ssh probe", false, (probe.stderr || probe.stdout || "").trim());
          return log;
        }
        record("ssh probe", true);

        // Idempotent fast path: skip re-install when sha256 already matches.
        const pre = await caRunScript(n, ops.statusCmd);
        if (pre.stdout.trim().includes("OK")) {
          record("already trusted", true, `sha256 ${expectedSha.slice(0, 12)}…`);
          return log;
        }

        try {
          await sftpPut(n, CA_CACHE_PATH, ops.uploadPath);
          record("upload ca cert", true);
        } catch (e) {
          record("upload ca cert", false, String(e));
          return log;
        }

        const install = await caRunScript(n, ops.installCmd);
        if (install.code !== 0) {
          record("install ca cert", false, (install.stderr || install.stdout || "").trim());
          return log;
        }
        record("install ca cert", true);

        const verify = await caRunScript(n, ops.statusCmd);
        const ok = verify.stdout.trim().includes("OK");
        record(
          "verify trust",
          ok,
          ok
            ? `sha256 ${expectedSha.slice(0, 12)}…`
            : (verify.stderr || verify.stdout || "").trim(),
        );
      } catch (e) {
        record("FATAL", false, String(e));
      }
      return log;
    }),
  );
  return { logs, sha256: expectedSha };
}

// ────── task store (in-memory) ────────────────────────────────────────────
// Apply endpoints return TaskResult synchronously; we also remember them so
// the History view can list recent runs. Capped at 50 entries.

const tasks: TaskResult[] = [];
const MAX_TASK_HISTORY = 50;

function newTaskId(): string {
  return `task-${Math.floor(Date.now() / 1000).toString(36)}`;
}

function fmtHms(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function applyLogsToTaskResult(name: string, logs: ApplyLog[], startedAt: number): TaskResult {
  // Take the union of step names in encounter order. Apply paths short-circuit
  // on failure, so some logs have fewer steps than others; we backfill "skip".
  const canonicalSteps: string[] = [];
  for (const log of logs) {
    for (const s of log.steps) if (!canonicalSteps.includes(s.step)) canonicalSteps.push(s.step);
  }

  const failDetails: NonNullable<TaskResult["failDetails"]> = {};
  const rows: TaskRow[] = logs.map((log) => {
    const cells: CellKind[] = canonicalSteps.map((stepName) => {
      const step = log.steps.find((s) => s.step === stepName);
      if (!step) return "skip";
      return step.ok ? "ok" : "fail";
    });
    const failStep = cells.indexOf("fail");
    // Collect stderr/details for failed steps so the UI can show them inline.
    for (let i = 0; i < log.steps.length; i++) {
      const s = log.steps[i];
      if (!s.ok && s.detail) {
        const idx = canonicalSteps.indexOf(s.step);
        if (idx >= 0) {
          failDetails[`${log.node}:${idx}`] = {
            cmd: s.step,
            exit: -1,
            duration: "—",
            stderr: s.detail,
          };
        }
      }
    }
    return {
      node: log.node,
      mesh: "online",
      agent: "offline",
      cells,
      failStep: failStep >= 0 ? failStep : undefined,
    };
  });

  const result: TaskResult = {
    id: newTaskId(),
    name,
    startedAt: fmtHms(startedAt),
    finishedAt: fmtHms(Date.now()),
    elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    steps: canonicalSteps,
    rows,
    failDetails: Object.keys(failDetails).length ? failDetails : undefined,
  };
  tasks.unshift(result);
  if (tasks.length > MAX_TASK_HISTORY) tasks.length = MAX_TASK_HISTORY;
  return result;
}

// ────── http server (Hono) ────────────────────────────────────────────────

function safeStaticPath(urlPath: string): string | null {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.split("?")[0]!;
  const full = normalize(join(DIST, rel));
  if (!full.startsWith(DIST)) return null;
  if (!existsSync(full)) return null;
  if (!statSync(full).isFile()) return null;
  return full;
}

const app = new Hono()
  // Global error trap — handlers may throw freely; we project to JSON 500.
  .onError((e, c) => c.json({ error: String(e) }, 500))

  // ── local easytier RPC mirrors ─────────────────────────────────
  .get("/api/peers", async (c) => c.json(await cli<PeerRaw[]>(["peer"])))
  .get("/api/peer-center", async (c) => c.json(await cli<PeerCenterEntry[]>(["peer-center"])))
  .get("/api/peer-center/cached", (c) => c.json(latestPeerCenter))
  .get("/api/stats", async (c) => c.json(await cli<StatRaw[]>(["stats"])))
  .get("/api/route", async (c) => c.json(await cli<unknown>(["route"])))
  .get("/api/node-info", async (c) => c.json(await cli<NodeInfo>(["node", "info"])))
  .get("/api/history", (c) => c.json(samples))

  // ── mesh management (uses nodes.json + ssh) ────────────────────
  .get("/api/mesh/nodes", (c) => c.json(loadNodes()))
  .get("/api/mesh/status", async (c) => c.json(await meshStatus()))
  .post("/api/mesh/init-keys", async (c) => {
    const force = c.req.query("force") === "1";
    return c.json(await meshInitKeys(force));
  })

  // ── distribute apply endpoints (sync; return TaskResult) ───────
  .post("/api/mesh/apply", async (c) => {
    const t = Date.now();
    const { logs } = await meshApply();
    return c.json(applyLogsToTaskResult("SSH key + mesh ssh · apply", logs, t));
  })
  .get("/api/mesh/dns/status", async (c) => c.json(await dnsStatus()))
  .post("/api/mesh/dns/apply", async (c) => {
    const t = Date.now();
    const { logs } = await dnsApply();
    return c.json(applyLogsToTaskResult(`DNS 设置 · ${DNS_DOMAIN}`, logs, t));
  })
  .get("/api/mesh/ca/status", async (c) => c.json(await caStatus()))
  .post("/api/mesh/ca/apply", async (c) => {
    const t = Date.now();
    const { logs, sha256 } = await caApply();
    return c.json(applyLogsToTaskResult(`CA 信任根分发 · ${sha256.slice(0, 12)}…`, logs, t));
  })

  // ── task store ─────────────────────────────────────────────────
  .get("/api/tasks", (c) => c.json(tasks))
  .get("/api/tasks/:id", (c) => {
    const id = c.req.param("id");
    const t = tasks.find((x) => x.id === id);
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  })

  // ── agent placeholder (no agent infrastructure yet) ────────────
  .get("/api/agents", (c) => c.json([] as AgentInfo[]))

  // ── SSE: pushes peer-center + samples whenever they refresh ────
  .get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      // initial snapshot — send last known peer-center and the full history
      // window so the client can paint without waiting for the next sample.
      if (latestPeerCenter.length > 0) {
        await stream.writeSSE({ event: "peer-center", data: JSON.stringify(latestPeerCenter) });
      }
      await stream.writeSSE({ event: "history", data: JSON.stringify(samples) });

      const onSample = (s: Sample) =>
        stream.writeSSE({ event: "sample", data: JSON.stringify(s) }).catch(() => {});
      const onPc = (pc: PeerCenterEntry[]) =>
        stream.writeSSE({ event: "peer-center", data: JSON.stringify(pc) }).catch(() => {});
      events.on("sample", onSample);
      events.on("peer-center", onPc);
      stream.onAbort(() => {
        events.off("sample", onSample);
        events.off("peer-center", onPc);
      });

      // keep open until the client aborts
      while (!stream.aborted) await stream.sleep(60_000);
    }),
  )

  // ── static + SPA fallback (production) ─────────────────────────
  .get("*", (c) => {
    const url = new URL(c.req.url);
    const filePath = safeStaticPath(url.pathname);
    if (filePath)
      return new Response(Bun.file(filePath), {
        headers: { "Content-Type": mimeFor(filePath) },
      });
    const fallback = safeStaticPath("/index.html");
    if (fallback)
      return new Response(Bun.file(fallback), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    return c.text("not found", 404);
  });

export type AppType = typeof app;

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255, // Bun max; mesh/apply can take a minute+
  fetch: app.fetch,
});

console.log(`cobweb backend: http://${HOST}:${PORT}/`);
console.log(`  cli: ${CLI}`);
console.log(`  nodes file: ${NODES_FILE}`);
console.log(`  sampler: every ${SAMPLE_INTERVAL_MS}ms · history ${HISTORY_LEN} points`);
