param([switch]$Headless)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
# Run the freshly published self-contained client so browser/Office/Agent dependencies
# behave exactly like the end-user distribution. Give development a separate data directory.
& (Join-Path $PSScriptRoot 'start-local.ps1') -Headless:$Headless -DataDirectory (Join-Path $root ('.local\development-v'+(Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw | ConvertFrom-Json).version))
