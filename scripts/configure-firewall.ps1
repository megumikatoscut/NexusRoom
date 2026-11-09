# Run once from an elevated PowerShell. Only the LAN device service is exposed.
param([string]$Program=(Join-Path (Split-Path $PSScriptRoot -Parent) 'NexusRoom.Host.exe'))
$ErrorActionPreference='Stop'
if (!(Test-Path -LiteralPath $Program)) {
    $projectRoot=Split-Path $PSScriptRoot -Parent
    $version=(Get-Content -LiteralPath (Join-Path $projectRoot 'release.json') -Raw | ConvertFrom-Json).version
    . (Join-Path $PSScriptRoot 'resolve-windows-payload.ps1')
    $Program=Join-Path (Get-NexusWindowsPayload $projectRoot $version) 'NexusRoom.Host.exe'
}
$programPath=(Resolve-Path -LiteralPath $Program).Path
if (!(Test-Path -LiteralPath $programPath -PathType Leaf)) { throw 'NexusRoom executable not found' }
foreach ($rule in @(@{Name='NexusRoom-LAN-TLS'; Protocol='TCP'; Port=17891},@{Name='NexusRoom-LAN-Discovery'; Protocol='UDP'; Port=17892},@{Name='NexusRoom-LAN-mDNS'; Protocol='UDP'; Port=5353})) {
    Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $rule.Name -DisplayName $rule.Name -Direction Inbound -Action Allow -Program $programPath -Protocol $rule.Protocol -LocalPort $rule.Port -RemoteAddress LocalSubnet -Profile Private,Public | Out-Null
}
Write-Host 'NexusRoom LAN rules configured. The Windows control centre remains loopback only.'
