# Service installers

Templates the bootstrap flow drops onto a managed node so the agent comes up
under the host's native service manager.

| OS      | Manager | Files | Path on host |
|---------|---------|-------|--------------|
| Linux   | systemd | `systemd/cobweb-agent.service` | `/etc/systemd/system/cobweb-agent.service` |
| macOS   | launchd | `launchd/com.cobweb.agent.plist` | `/Library/LaunchDaemons/com.cobweb.agent.plist` |
| Windows | SCM     | `windows/install.ps1`, `uninstall.ps1` | run from %TEMP%, registers `cobwebAgent` service |

All run the binary as root / SYSTEM. The agent reads its config from a
canonical path (`/etc/cobweb-agent/config.toml`, or `%ProgramData%\cobweb-agent\config.toml`)
and treats CLI flags as overrides.

## Linux

```
sudo install -m 0755 cobweb-agent /usr/local/bin/
sudo install -m 0644 service-installers/systemd/cobweb-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cobweb-agent
```

## macOS

```
sudo install -m 0755 cobweb-agent /usr/local/bin/
sudo install -m 0644 service-installers/launchd/com.cobweb.agent.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.cobweb.agent.plist
```

## Windows

From an elevated PowerShell (pwsh.exe 7+ recommended):

```
.\service-installers\windows\install.ps1 -Binary .\cobweb-agent.exe
```

To remove:

```
.\service-installers\windows\uninstall.ps1
```
