param([string]$PythonExecutable='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
$manifestPath=Join-Path $root 'PIC\ICON_MANIFEST.json'
if (Test-Path -LiteralPath $manifestPath) {
    $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $current=$manifest.schemaVersion -eq 1 -and $manifest.files.Count -eq 15
    foreach ($file in $manifest.files) {
        $path=[IO.Path]::GetFullPath((Join-Path $root $file.path))
        if (!$path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {throw 'Icon resource path is outside the project.'}
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {$current=$false}
    }
    if ($current) {Write-Host 'Application icon resources match PIC.'; return}
}
if (!$PythonExecutable) {
    $package=Get-NexusWindowsPayload $root (Get-NexusRelease).version
    $PythonExecutable=Join-Path $package 'runtime\primary-runtime\dependencies\python\python.exe'
}
Invoke-NexusNative $PythonExecutable @((Join-Path $PSScriptRoot 'prepare-icons.py')) 'Application icon resources'
