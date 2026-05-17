// SSH-driven cobweb-agent bootstrap. Pushes the agent binary + the private
// CA to each managed node and registers it under the host's native service
// manager with `--trust-ca` wired in.
//
// Mirrors `docs/agent-design.md` §10 and `docs/agent-impl-plan.md` §F (stage
// F19-20). All work happens over the existing SSH channel from `mesh.ts` —
// no chicken-and-egg between SSH and the agent itself.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config";
import { loadNodes, type MeshNode, sftpPut, sshExec } from "./mesh";
import type { ApplyLog } from "./tasks";

/** Where the agent binary should be found on the cobweb host. CI deploys
 *  release builds to `/opt/cobweb/agents/<artifact>/`; local dev uses the
 *  workspace target/. The first existing candidate wins. */
function agentBinaryFor(target: MeshNode): string | null {
  const candidates = (() => {
    switch (target.os) {
      case "windows":
        return [
          join(REPO_ROOT, "agents", "windows-x86_64", "cobweb-agent.exe"),
          join(REPO_ROOT, "agent", "target", "release", "cobweb-agent.exe"),
          join(REPO_ROOT, "agent", "target", "debug", "cobweb-agent.exe"),
        ];
      case "macos":
        return [
          join(REPO_ROOT, "agents", "macos-aarch64", "cobweb-agent"),
          join(REPO_ROOT, "agent", "target", "release", "cobweb-agent"),
          join(REPO_ROOT, "agent", "target", "debug", "cobweb-agent"),
        ];
      default:
        return [
          join(REPO_ROOT, "agents", "linux-x86_64", "cobweb-agent"),
          join(REPO_ROOT, "agent", "target", "release", "cobweb-agent"),
          join(REPO_ROOT, "agent", "target", "debug", "cobweb-agent"),
        ];
    }
  })();
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Private CA PEM the agent needs to trust the server's TLS handshake. */
function caBundleSource(): string | null {
  const candidates = [join(REPO_ROOT, "etmesh-ca.crt"), "/opt/cobweb/etmesh-ca.crt"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const AGENT_SERVER_URL = "wss://cobweb.lan:8088/agent/ws";

/** Linux systemd unit. `--trust-ca` points at the CA copied alongside the
 *  binary; `COBWEB_AGENT_SERVER_URL` overrides the default mesh IP so the
 *  TLS hostname matches the leaf cert (CN=`cobweb.lan`). */
const SYSTEMD_UNIT = `[Unit]
Description=cobweb agent (mesh management daemon)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="COBWEB_AGENT_SERVER_URL=${AGENT_SERVER_URL}"
Environment="COBWEB_AGENT_TRUST_CA=/etc/cobweb-agent/etmesh-ca.crt"
ExecStart=/usr/local/bin/cobweb-agent
Restart=on-failure
RestartSec=5
StartLimitBurst=10
StartLimitIntervalSec=120
User=root
Group=root
StandardOutput=journal
StandardError=journal
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
`;

const LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.cobweb.agent</string>
    <key>ProgramArguments</key><array><string>/usr/local/bin/cobweb-agent</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>UserName</key><string>root</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>COBWEB_AGENT_SERVER_URL</key><string>${AGENT_SERVER_URL}</string>
      <key>COBWEB_AGENT_TRUST_CA</key><string>/etc/cobweb-agent/etmesh-ca.crt</string>
    </dict>
    <key>StandardOutPath</key><string>/var/log/cobweb-agent.log</string>
    <key>StandardErrorPath</key><string>/var/log/cobweb-agent.log</string>
</dict>
</plist>
`;

export interface InstallOptions {
  /** Override the agent binary path. */
  binaryPath?: string;
  /** Subset of nodes to target. Defaults to every managed node. */
  onlyNodes?: string[];
}

export async function agentInstallApply(opts: InstallOptions = {}): Promise<{ logs: ApplyLog[] }> {
  const nodes = loadNodes().filter((n) => n.managed);
  const target = opts.onlyNodes ? nodes.filter((n) => opts.onlyNodes!.includes(n.name)) : nodes;

  const caBundle = caBundleSource();

  const logs: ApplyLog[] = [];
  for (const n of target) {
    const log: ApplyLog = { node: n.name, steps: [] };
    const record = (step: string, ok: boolean, detail?: string) =>
      log.steps.push({ step, ok, detail });

    const binary = opts.binaryPath ?? agentBinaryFor(n);
    if (!binary) {
      record(
        "locate cobweb-agent binary",
        false,
        "no binary in /opt/cobweb/agents/<os>/ or agent/target/{release,debug}/ — run `just agent-release` or trigger the CI deploy",
      );
      logs.push(log);
      continue;
    }
    record("locate cobweb-agent binary", true, binary);

    if (!caBundle) {
      record(
        "locate etmesh-ca.crt",
        false,
        "expected at /opt/cobweb/etmesh-ca.crt (deployed) or <REPO_ROOT>/etmesh-ca.crt; without it agent's rustls will fail UnknownIssuer against the private cert",
      );
      logs.push(log);
      continue;
    }
    record("locate etmesh-ca.crt", true, caBundle);

    try {
      if (n.os === "windows") {
        await installWindows(n, binary, caBundle, log);
      } else if (n.os === "macos") {
        await installMacos(n, binary, caBundle, log);
      } else {
        await installLinux(n, binary, caBundle, log);
      }
    } catch (e) {
      record("FATAL", false, String(e));
    }
    logs.push(log);
  }
  return { logs };
}

async function installLinux(
  n: MeshNode,
  binary: string,
  caBundle: string,
  log: ApplyLog,
): Promise<void> {
  const record = (step: string, ok: boolean, detail?: string) =>
    log.steps.push({ step, ok, detail });

  // 1. sftp the binary + CA into /tmp.
  await sftpPut(n, binary, "/tmp/cobweb-agent");
  record("sftp put /tmp/cobweb-agent", true);
  await sftpPut(n, caBundle, "/tmp/etmesh-ca.crt");
  record("sftp put /tmp/etmesh-ca.crt", true);

  // 2. install bin + CA, write unit, enable.
  const r = await sshExec(
    n,
    [
      "sudo install -m 755 /tmp/cobweb-agent /usr/local/bin/cobweb-agent",
      "sudo install -d -m 755 /etc/cobweb-agent",
      "sudo install -m 644 /tmp/etmesh-ca.crt /etc/cobweb-agent/etmesh-ca.crt",
      `sudo tee /etc/systemd/system/cobweb-agent.service > /dev/null <<'COBWEB_UNIT_EOF'\n${SYSTEMD_UNIT}\nCOBWEB_UNIT_EOF`,
      "sudo systemctl daemon-reload",
      "sudo systemctl enable --now cobweb-agent",
      "sleep 2 && sudo systemctl is-active cobweb-agent",
      "rm -f /tmp/cobweb-agent /tmp/etmesh-ca.crt",
    ].join(" && "),
  );
  record(
    "install systemd unit + enable",
    r.code === 0,
    r.code === 0 ? r.stdout.trim() : `${r.stderr || r.stdout}`.trim(),
  );
}

async function installMacos(
  n: MeshNode,
  binary: string,
  caBundle: string,
  log: ApplyLog,
): Promise<void> {
  const record = (step: string, ok: boolean, detail?: string) =>
    log.steps.push({ step, ok, detail });

  await sftpPut(n, binary, "/tmp/cobweb-agent");
  record("sftp put /tmp/cobweb-agent", true);
  await sftpPut(n, caBundle, "/tmp/etmesh-ca.crt");
  record("sftp put /tmp/etmesh-ca.crt", true);

  const r = await sshExec(
    n,
    [
      "sudo install -m 755 /tmp/cobweb-agent /usr/local/bin/cobweb-agent",
      "sudo install -d -m 755 /etc/cobweb-agent",
      "sudo install -m 644 /tmp/etmesh-ca.crt /etc/cobweb-agent/etmesh-ca.crt",
      `sudo tee /Library/LaunchDaemons/com.cobweb.agent.plist > /dev/null <<'COBWEB_PLIST_EOF'\n${LAUNCHD_PLIST}\nCOBWEB_PLIST_EOF`,
      "sudo chown root:wheel /Library/LaunchDaemons/com.cobweb.agent.plist",
      "sudo launchctl unload /Library/LaunchDaemons/com.cobweb.agent.plist 2>/dev/null || true",
      "sudo launchctl load -w /Library/LaunchDaemons/com.cobweb.agent.plist",
      "rm -f /tmp/cobweb-agent /tmp/etmesh-ca.crt",
    ].join(" && "),
  );
  record(
    "install launchd plist + load",
    r.code === 0,
    r.code === 0 ? r.stdout.trim() : `${r.stderr || r.stdout}`.trim(),
  );
}

async function installWindows(
  n: MeshNode,
  binary: string,
  caBundle: string,
  log: ApplyLog,
): Promise<void> {
  const record = (step: string, ok: boolean, detail?: string) =>
    log.steps.push({ step, ok, detail });

  // 1. sftp into %TEMP%.
  await sftpPut(n, binary, "/C:/Windows/Temp/cobweb-agent.exe");
  record("sftp put cobweb-agent.exe", true);
  await sftpPut(n, caBundle, "/C:/Windows/Temp/etmesh-ca.crt");
  record("sftp put etmesh-ca.crt", true);

  // 2. install via PowerShell. Windows services lack a clean per-service
  // env mechanism via sc.exe, so we encode the trust-ca path and the
  // server URL as explicit CLI flags baked into the binPath.
  //
  // sc.exe binPath= quoting is famously painful:
  //   - The whole thing must be one argument starting with binPath=
  //   - Quotes inside the argument must be triple-escaped (\"\"\")
  //   - PowerShell here adds another layer (\\\") and then ssh adds a final
  //     shell layer ("...")
  // Net result: each literal `"` you want sc.exe to see becomes `\\\"\\\"\\\"`.
  const exe = "C:\\\\Program Files\\\\cobweb-agent\\\\cobweb-agent.exe";
  const caPath = "C:\\\\ProgramData\\\\cobweb-agent\\\\etmesh-ca.crt";
  const ps = [
    `New-Item -Type Directory -Force \\"C:\\\\Program Files\\\\cobweb-agent\\" | Out-Null`,
    `New-Item -Type Directory -Force \\"C:\\\\ProgramData\\\\cobweb-agent\\" | Out-Null`,
    `try { Stop-Service cobwebAgent -Force -ErrorAction Stop } catch {}`,
    `Copy-Item -Force \\"C:\\\\Windows\\\\Temp\\\\cobweb-agent.exe\\" \\"${exe}\\"`,
    `Copy-Item -Force \\"C:\\\\Windows\\\\Temp\\\\etmesh-ca.crt\\" \\"${caPath}\\"`,
    `if (Get-Service -Name cobwebAgent -ErrorAction SilentlyContinue) { sc.exe delete cobwebAgent | Out-Null; Start-Sleep -Seconds 1 }`,
    `sc.exe create cobwebAgent binPath= \\"\\"\\"${exe}\\"\\"\\" --trust-ca \\"\\"\\"${caPath}\\"\\"\\" --server-url \\"\\"\\"${AGENT_SERVER_URL}\\"\\"\\" start= auto | Out-Null`,
    `sc.exe failure cobwebAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null`,
    `Start-Service cobwebAgent`,
    `Start-Sleep -Seconds 2`,
    `(Get-Service cobwebAgent).Status`,
    `Remove-Item -Force -ErrorAction SilentlyContinue \\"C:\\\\Windows\\\\Temp\\\\cobweb-agent.exe\\", \\"C:\\\\Windows\\\\Temp\\\\etmesh-ca.crt\\"`,
  ].join("; ");
  const r = await sshExec(n, `powershell.exe -NoProfile -Command "${ps}"`);
  record(
    "install service + start",
    r.code === 0,
    r.code === 0 ? r.stdout.trim() : `${r.stderr || r.stdout}`.trim(),
  );
}
