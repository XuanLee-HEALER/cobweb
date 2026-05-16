<#
.SYNOPSIS
    Install / update cobweb-agent as a Windows service.

.DESCRIPTION
    Copies the binary to %ProgramFiles%\cobweb-agent\, registers a Windows
    service named "cobwebAgent" that auto-starts on boot, and starts it.

    Requires Administrator (the service runs as SYSTEM; only an admin can
    create services). Re-running is safe — the script stops + replaces the
    binary + restarts.

.PARAMETER Binary
    Path to the cobweb-agent.exe to install. Defaults to .\cobweb-agent.exe.

.PARAMETER ConfigDir
    Where to place config.toml. Default: %ProgramData%\cobweb-agent.

.EXAMPLE
    PS> .\install.ps1
    PS> .\install.ps1 -Binary C:\downloads\cobweb-agent.exe
#>

[CmdletBinding()]
param(
    [string]$Binary = ".\cobweb-agent.exe",
    [string]$ConfigDir = (Join-Path $env:ProgramData "cobweb-agent"),
    [string]$InstallDir = (Join-Path $env:ProgramFiles "cobweb-agent")
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "install.ps1 must run from an elevated PowerShell session."
}

if (-not (Test-Path $Binary)) {
    throw "cannot find $Binary — pass -Binary to point at cobweb-agent.exe."
}

# Create install + config dirs.
if (-not (Test-Path $InstallDir)) { New-Item -Path $InstallDir -ItemType Directory | Out-Null }
if (-not (Test-Path $ConfigDir))  { New-Item -Path $ConfigDir  -ItemType Directory | Out-Null }
$IncomingDir = Join-Path $ConfigDir "incoming"
if (-not (Test-Path $IncomingDir)) { New-Item -Path $IncomingDir -ItemType Directory | Out-Null }
$LogDir = Join-Path $ConfigDir "logs"
if (-not (Test-Path $LogDir))     { New-Item -Path $LogDir -ItemType Directory | Out-Null }

$Target = Join-Path $InstallDir "cobweb-agent.exe"

# Stop the service if it already exists so we can replace the binary.
$svc = Get-Service -Name cobwebAgent -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Write-Host "stopping existing cobwebAgent service..."
        Stop-Service cobwebAgent -Force
    }
}

Copy-Item -Path $Binary -Destination $Target -Force
Write-Host "binary deployed to $Target"

# Seed a default config if one isn't there yet.
$ConfigFile = Join-Path $ConfigDir "config.toml"
if (-not (Test-Path $ConfigFile)) {
@"
# cobweb-agent config — edit and restart the service to apply.
server_url            = "wss://10.177.0.1:8088/agent/ws"
log_level             = "info"
server_cert_fingerprint = ""
rate_limit_bps        = 10485760
heartbeat_interval_ms = 10000
peer_view_interval_ms = 5000
buffer_max_bytes      = 8388608
incoming_dir          = "$($IncomingDir.Replace('\','\\'))"
"@ | Set-Content -Encoding UTF8 $ConfigFile
    Write-Host "seeded default config $ConfigFile"
}

# (Re)register the service.
if (-not $svc) {
    Write-Host "creating service cobwebAgent..."
    & sc.exe create cobwebAgent binPath= "`"$Target`"" start= auto DisplayName= "cobweb agent" | Out-Null
    & sc.exe description cobwebAgent "Node-side daemon for cobweb mesh management." | Out-Null
    # Restart on failure (3 attempts, 5s apart).
    & sc.exe failure cobwebAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
}

$env:COBWEB_AGENT_CONFIG = $ConfigFile
Write-Host "starting service..."
Start-Service cobwebAgent

Write-Host "done — running as SYSTEM. Tail logs from event viewer or the file in $LogDir."
