param([switch]$Headless,[string]$DataDirectory='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
$root=Split-Path $PSScriptRoot -Parent
$version=(Get-Content -Raw (Join-Path $root 'release.json') | ConvertFrom-Json).version
$exe=Resolve-NexusProjectPath $root ('artifacts\NexusRoom-Windows-x64-'+$version+'.exe')
if (!(Test-Path -LiteralPath $exe)) {throw 'Build or download the single Windows EXE first: scripts/build.ps1'}
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne ($version+'.0')) {throw 'Unexpected Windows release version.'}
if (@(Get-NetTCPConnection -State Listen -LocalPort 17890,17891 -ErrorAction SilentlyContinue).Count -gt 0) {throw 'NexusRoom port 17890/17891 is occupied; close the running instance first.'}
$saved=[Environment]::GetEnvironmentVariable('NEXUS_DATA_DIR','Process')
try {
    if ($DataDirectory) {
        if (![IO.Path]::IsPathRooted($DataDirectory)) {$DataDirectory=Join-Path $root $DataDirectory}
        $env:NEXUS_DATA_DIR=[IO.Path]::GetFullPath($DataDirectory)
    }
    if ($Headless) {$process=Start-Process -FilePath $exe -WorkingDirectory $root -ArgumentList '--headless' -WindowStyle Hidden -PassThru}
    else {$process=Start-Process -FilePath $exe -WorkingDirectory $root -PassThru}
    for ($attempt=0; $attempt -lt 720; $attempt++) {
        Start-Sleep -Milliseconds 250
        $health=$null
        try {$health=Invoke-RestMethod -Uri 'http://127.0.0.1:17890/health' -TimeoutSec 1} catch { }
        if ($health) {
            if ($health.version -ne $version) {throw 'Unexpected version on port 17890.'}
            Write-Host "NexusRoom v$version is ready."
            return
        }
        $process.Refresh()
        if ($process.HasExited -and $process.ExitCode -ne 0) {throw "NexusRoom launcher failed (exit $($process.ExitCode))."}
    }
    throw 'NexusRoom did not become ready within 180 seconds.'
} finally {[Environment]::SetEnvironmentVariable('NEXUS_DATA_DIR',$saved,'Process')}
