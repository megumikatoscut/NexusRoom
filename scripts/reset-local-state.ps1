# Explicit user-data reset; not a build/release cleanup step.
param()
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$version=(Get-Content -Raw -LiteralPath (Join-Path $root 'release.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') {throw 'Invalid version.'}
if (@(Get-CimInstance Win32_Process -Filter "Name='NexusRoom.Host.exe'").Count) {throw 'Close NexusRoom before resetting user data.'}
$parent=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NexusRoom')).TrimEnd('\')
$target=[IO.Path]::GetFullPath((Join-Path $parent ('user-state-v'+$version)))
if ([IO.Path]::GetDirectoryName($target) -ne $parent) {throw 'Reset path escaped the application data directory.'}
if (Test-Path -LiteralPath $target) {
    $cursor=$target
    while ($cursor) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Refusing linked user data.'}
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    foreach ($item in Get-ChildItem -LiteralPath $target -Recurse -Force) {if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Refusing a link within user data.'}}
    Remove-Item -LiteralPath $target -Recurse -Force
}
Write-Host ('Current version user data removed: '+$target)
