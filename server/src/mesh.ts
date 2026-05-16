// Mesh node config (nodes.json) + SSH/SFTP primitives + meshStatus/Init/Apply.
//
// The dashboard's "SSH key + mesh ssh" capability uses this module's
// meshApply() to push a managed ed25519 key + ssh_config block to each
// node listed in nodes.json. meshStatus probes for the current state.

import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORIZED_KEYS_TAG,
  FENCE_BEGIN,
  FENCE_END,
  KEY_PATH,
  KEY_PUB_PATH,
  NODES_FILE,
  REMOTE_KEY_NAME,
} from "./config";
import type { ApplyLog } from "./tasks";

// ── nodes.json model ──────────────────────────────────────────────────

export type NodeOS = "linux" | "macos" | "windows";

export interface MeshNode {
  name: string;
  ip: string;
  user: string;
  port: number;
  os: NodeOS;
  managed: boolean;
}

export function loadNodes(): MeshNode[] {
  if (!existsSync(NODES_FILE)) return [];
  return JSON.parse(readFileSync(NODES_FILE, "utf8")) as MeshNode[];
}

// ── ssh / sftp primitives ─────────────────────────────────────────────

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

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function sshExec(n: MeshNode, command: string): Promise<ExecResult> {
  const proc = Bun.spawn(["ssh", ...SSH_OPTS, "-p", String(n.port), targetOf(n), command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

export async function sshExecWithStdin(
  n: MeshNode,
  command: string,
  stdin: string,
): Promise<ExecResult> {
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

export async function sftpPut(n: MeshNode, localPath: string, remotePath: string): Promise<void> {
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

export async function sftpGet(n: MeshNode, remotePath: string): Promise<string | null> {
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

// ── fence helpers ─────────────────────────────────────────────────────

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

// ── per-OS commands ───────────────────────────────────────────────────

export interface OsOps {
  ensureSshDir: string;
  authorizedKeysPath: string;
  sshConfigPath: string;
  keyPrivPath: string;
  keyPubPath: string;
  fixKeyPerms: string;
  fixSshDirPerms: string;
}

export function opsFor(n: MeshNode): OsOps {
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

// ── status / init / apply ─────────────────────────────────────────────

export interface NodeStatus {
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

export async function meshStatus(): Promise<{ keys_initialized: boolean; nodes: NodeStatus[] }> {
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

export async function meshInitKeys(force = false): Promise<{ generated: boolean; pub: string }> {
  if (!force && existsSync(KEY_PATH) && existsSync(KEY_PUB_PATH)) {
    return { generated: false, pub: readFileSync(KEY_PUB_PATH, "utf8") };
  }
  if (existsSync(KEY_PATH)) unlinkSync(KEY_PATH);
  if (existsSync(KEY_PUB_PATH)) unlinkSync(KEY_PUB_PATH);
  const proc = Bun.spawn(
    ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "etmesh-managed", "-f", KEY_PATH],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ssh-keygen failed: ${err.trim()}`);
  }
  chmodSync(KEY_PATH, 0o600);
  return { generated: true, pub: readFileSync(KEY_PUB_PATH, "utf8") };
}

export async function meshApply(): Promise<{ logs: ApplyLog[] }> {
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
