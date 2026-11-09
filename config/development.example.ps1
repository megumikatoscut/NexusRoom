# Optional, credential-free process configuration. Run from any directory.
$projectRoot = Split-Path $PSScriptRoot -Parent
$releaseVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'release.json') -Raw | ConvertFrom-Json).version
$env:NEXUS_DATA_DIR = Join-Path $projectRoot ('.local\development-v' + $releaseVersion)
# Existing SDKs are discovered from ANDROID_HOME / ANDROID_SDK_ROOT.
# NEXUS_CACHE_DIR and NEXUS_SIGNING_DIR may point to dedicated external
# directories chosen by the developer. Never commit credentials or keystores.
