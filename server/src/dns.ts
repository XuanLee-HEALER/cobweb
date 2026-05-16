// DNS dispatch: pushes a per-domain DNS rule (DNS_DOMAIN → DNS_SERVER_IP) to
// each managed node so they can resolve `.lan` via aliyun CoreDNS without
// going through the LAN router. Linux uses systemd-resolved drop-in; macOS
// uses /etc/resolver/<domain>; Windows uses NRPT.
//
// Sudoers prerequisite (POSIX nodes, NOPASSWD), one line per node:
//   <user> ALL=(ALL) NOPASSWD: /usr/bin/install, /usr/bin/tee, /usr/bin/systemctl
// (aliyun is already root, no sudoers needed.)

import {
  DNS_DOMAIN,
  DNS_EXPECTED_IP,
  DNS_FENCE_BEGIN,
  DNS_FENCE_END,
  DNS_NRPT_TAG,
  DNS_SERVER_IP,
  DNS_TEST_HOST,
} from "./config";
import { loadNodes, type MeshNode, type NodeOS, sshExec } from "./mesh";
import type { ApplyLog } from "./tasks";

interface DnsOps {
  applyCmd: string;
  statusFileCheck: string;
  digCmd: string;
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

export async function dnsStatus(): Promise<{
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

export async function dnsApply(): Promise<{ logs: ApplyLog[] }> {
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
