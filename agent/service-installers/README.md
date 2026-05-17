# Service installers

Templates the bootstrap flow drops onto a managed node so the agent comes up
under the host's native service manager.

| OS      | Manager | Files | Path on host |
|---------|---------|-------|--------------|
| Linux   | systemd | `systemd/cobweb-agent.service` | `/etc/systemd/system/cobweb-agent.service` |
| macOS   | launchd | `launchd/com.cobweb.agent.plist` | `/Library/LaunchDaemons/com.cobweb.agent.plist` |
| Windows | SCM     | `windows/install.ps1`, `uninstall.ps1` | run from %TEMP%, registers `cobwebAgent` service |

All run the binary as root / SYSTEM. The unit / plist / service template
preset two pieces of state the agent needs to dial the cobweb server:

- `COBWEB_AGENT_SERVER_URL=wss://cobweb.lan:8088/agent/ws`
- `COBWEB_AGENT_TRUST_CA=/etc/cobweb-agent/etmesh-ca.crt` (POSIX)
  or `%ProgramData%\cobweb-agent\etmesh-ca.crt` (Windows)

The CA file **must exist at that path** before the service starts —
without it rustls falls back to public-roots-only and rejects the cobweb
server cert with `UnknownIssuer`. The dashboard's "Agent 安装/升级"
flow installs the CA automatically; the manual flows below need you to
drop it in by hand (you can fetch `etmesh-ca.crt` from the cobweb host
at `/opt/cobweb/etmesh-ca.crt`).

The agent reads its config from a canonical path
(`/etc/cobweb-agent/config.toml`, or `%ProgramData%\cobweb-agent\config.toml`)
and treats CLI flags / env vars as overrides.

## Linux

```sh
# 1. binary + CA
sudo install -m 0755 cobweb-agent /usr/local/bin/
sudo install -d -m 0755 /etc/cobweb-agent
sudo install -m 0644 etmesh-ca.crt /etc/cobweb-agent/etmesh-ca.crt

# 2. unit + start
sudo install -m 0644 service-installers/systemd/cobweb-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cobweb-agent
```

## macOS

```sh
sudo install -m 0755 cobweb-agent /usr/local/bin/
sudo install -d -m 0755 /etc/cobweb-agent
sudo install -m 0644 etmesh-ca.crt /etc/cobweb-agent/etmesh-ca.crt

sudo install -m 0644 service-installers/launchd/com.cobweb.agent.plist /Library/LaunchDaemons/
sudo launchctl load -w /Library/LaunchDaemons/com.cobweb.agent.plist
```

## Windows

From an elevated PowerShell (pwsh.exe 7+ recommended):

```powershell
# -TrustCa points at the etmesh-ca.crt you fetched from the cobweb host.
.\service-installers\windows\install.ps1 `
    -Binary .\cobweb-agent.exe `
    -TrustCa .\etmesh-ca.crt
```

To remove:

```powershell
.\service-installers\windows\uninstall.ps1
```
