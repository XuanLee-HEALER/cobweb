<#
.SYNOPSIS
    Remove cobweb-agent's Windows service. Leaves config + incoming/ in place.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "uninstall.ps1 must run from an elevated PowerShell session."
}

$svc = Get-Service -Name cobwebAgent -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Stop-Service cobwebAgent -Force
    }
    & sc.exe delete cobwebAgent | Out-Null
    Write-Host "cobwebAgent service removed."
} else {
    Write-Host "cobwebAgent not installed."
}
