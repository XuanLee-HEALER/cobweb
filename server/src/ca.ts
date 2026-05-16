// Trust CA distribution: pulls the cluster root CA cert from CA_REMOTE_NODE
// via SSH (kubectl) and installs it into each managed node's OS trust store.
// Idempotent: status check compares the installed cert's SHA-256 against the
// expected one and skips re-install if it matches.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CA_CACHE_PATH, CA_CN, CA_KUBECTL_CMD, CA_REMOTE_FILENAME, CA_REMOTE_NODE } from "./config";
import {
  type ExecResult,
  loadNodes,
  type MeshNode,
  type NodeOS,
  sftpPut,
  sshExec,
  sshExecWithStdin,
} from "./mesh";
import type { ApplyLog } from "./tasks";

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

interface CaOps {
  uploadPath: string;
  installCmd: string;
  statusCmd: string;
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
  // then certutil -addstore (needs admin, granted because the user is in Administrators group).
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

export async function caStatus(): Promise<{
  sha256: string;
  subject: string;
  nodes: CaNodeStatus[];
}> {
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

export async function caApply(): Promise<{ logs: ApplyLog[]; sha256: string }> {
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
