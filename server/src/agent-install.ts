// SSH-driven cobweb-agent bootstrap. Pushes the agent binary to each managed
// node and registers it under the host's native service manager.
//
// Mirrors `docs/agent-design.md` §10 and `docs/agent-impl-plan.md` §F (stage
// F19-20). All work happens over the existing SSH channel from `mesh.ts` —
// no chicken-and-egg between SSH and the agent itself.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config";
import { loadNodes, type MeshNode, sftpPut, sshExec } from "./mesh";
import type { ApplyLog } from "./tasks";

/** Default binary search paths (repo-local build artefacts). */
function agentBinaryFor(target: MeshNode): string | null {
  // Build outputs by `cargo build --release --manifest-path agent/Cargo.toml`
  // (or `--target=<triple>` for cross-builds). We only look in the local
  // workspace; cross-host CI/CD distribution is out of scope here.
  const candidates =
    target.os === "windows"
      ? [
          join(REPO_ROOT, "agent", "target", "release", "cobweb-agent.exe"),
          join(REPO_ROOT, "agent", "target", "debug", "cobweb-agent.exe"),
        ]
      : [
          join(REPO_ROOT, "agent", "target", "release", "cobweb-agent"),
          join(REPO_ROOT, "agent", "target", "debug", "cobweb-agent"),
        ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Linux systemd unit text — kept inline so we don't need a runtime file
 *  copy of `service-installers/systemd/cobweb-agent.service`. */
const SYSTEMD_UNIT = `[Unit]
Description=cobweb agent (mesh management daemon)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
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
        "build with `just agent-release` (or `agent-build` for debug)",
      );
      logs.push(log);
      continue;
    }
    record("locate cobweb-agent binary", true, binary);

    try {
      if (n.os === "windows") {
        await installWindows(n, binary, log);
      } else if (n.os === "macos") {
        await installMacos(n, binary, log);
      } else {
        await installLinux(n, binary, log);
      }
    } catch (e) {
      record("FATAL", false, String(e));
    }
    logs.push(log);
  }
  return { logs };
}

async function installLinux(n: MeshNode, binary: string, log: ApplyLog): Promise<void> {
  const record = (step: string, ok: boolean, detail?: string) =>
    log.steps.push({ step, ok, detail });

  // 1. sftp the binary into /tmp.
  await sftpPut(n, binary, "/tmp/cobweb-agent");
  record("sftp put /tmp/cobweb-agent", true);

  // 2. install + unit file + enable.
  const r = await sshExec(
    n,
    [
      "sudo install -m 755 /tmp/cobweb-agent /usr/local/bin/cobweb-agent",
      "sudo mkdir -p /etc/cobweb-agent",
      `sudo tee /etc/systemd/system/cobweb-agent.service > /dev/null <<'COBWEB_UNIT_EOF'\n${SYSTEMD_UNIT}\nCOBWEB_UNIT_EOF`,
      "sudo systemctl daemon-reload",
      "sudo systemctl enable --now cobweb-agent",
      "sleep 2 && sudo systemctl is-active cobweb-agent",
    ].join(" && "),
  );
  record(
    "install systemd unit + enable",
    r.code === 0,
    r.code === 0 ? r.stdout.trim() : `${r.stderr || r.stdout}`.trim(),
  );
}

async function installMacos(n: MeshNode, binary: string, log: ApplyLog): Promise<void> {
  const record = (step: string, ok: boolean, detail?: string) =>
    log.steps.push({ step, ok, detail });

  await sftpPut(n, binary, "/tmp/cobweb-agent");
  record("sftp put /tmp/cobweb-agent", true);

  const r = await sshExec(
    n,
    [
      "sudo install -m 755 /tmp/cobweb-agent /usr/local/bin/cobweb-agent",
      `sudo tee /Library/LaunchDaemons/com.cobweb.agent.plist > /dev/null <<'COBWEB_PLIST_EOF'\n${LAUNCHD_PLIST}\nCOBWEB_PLIST_EOF`,
      "sudo chown root:wheel /Library/LaunchDaemons/com.cobweb.agent.plist",
      "sudo launchctl unload /Library/LaunchDaemons/com.cobweb.agent.plist 2>/dev/null || true",
      "sudo launchctl load -w /Library/LaunchDaemons/com.cobweb.agent.plist",
    ].join(" && "),
  );
  record(
    "install launchd plist + load",
    r.code === 0,
    r.code === 0 ? r.stdout.trim() : `${r.stderr || r.stdout}`.trim(),
  );
}

async function installWindows(n: MeshNode, binary: string, log: ApplyLog): Promise<void> {
  const record = (step: string, ok: boolean, detail?: string) =>
    log.steps.push({ step, ok, detail });

  // 1. sftp into %TEMP%.
  const remoteTmp = `/C:/Windows/Temp/cobweb-agent.exe`;
  await sftpPut(n, binary, remoteTmp);
  record("sftp put cobweb-agent.exe", true);

  // 2. install via PowerShell — copy + register service.
  // We use sc.exe (delete first if it already exists so re-install replaces
  // the binary cleanly) then start the service.
  const ps = [
    `New-Item -Type Directory -Force \\"C:\\\\Program Files\\\\cobweb-agent\\" | Out-Null`,
    `try { Stop-Service cobwebAgent -Force -ErrorAction Stop } catch {}`,
    `Copy-Item -Force \\"C:\\\\Windows\\\\Temp\\\\cobweb-agent.exe\\" \\"C:\\\\Program Files\\\\cobweb-agent\\\\cobweb-agent.exe\\"`,
    `if (-not (Get-Service -Name cobwebAgent -ErrorAction SilentlyContinue)) { sc.exe create cobwebAgent binPath= \\"\\"\\"C:\\\\Program Files\\\\cobweb-agent\\\\cobweb-agent.exe\\"\\"\\" start= auto | Out-Null }`,
    `sc.exe failure cobwebAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null`,
    `Start-Service cobwebAgent`,
    `Start-Sleep -Seconds 2`,
    `(Get-Service cobwebAgent).Status`,
  ].join("; ");
  const r = await sshExec(n, `powershell.exe -NoProfile -Command "${ps}"`);
  record(
    "install service + start",
    r.code === 0,
    r.code === 0 ? r.stdout.trim() : `${r.stderr || r.stdout}`.trim(),
  );
}
