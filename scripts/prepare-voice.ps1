param([string]$OutputDirectory='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
$manifest=Get-Content -LiteralPath (Join-Path $root 'config\voice-models.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {throw 'Unsupported voice model manifest.'}
$total=0L
foreach ($entry in $manifest.models) {
    $source=Assert-NexusChildPath (Join-Path $root $entry.source) $root
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) {throw ('Offline voice model is missing: '+$entry.source)}
    $item=Get-Item -LiteralPath $source
    if ($item.Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {throw ('Offline voice model checksum mismatch: '+$entry.source)}
    $total += $item.Length
    if ($OutputDirectory) {
        $outputRoot=[IO.Path]::GetFullPath($OutputDirectory)
        $target=Assert-NexusChildPath (Join-Path $outputRoot $entry.target) $outputRoot
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}
$keywords=Get-Content -LiteralPath (Join-Path $root 'src\NexusRoom.Host\Voice\keywords.txt') -Raw -Encoding UTF8
if ($keywords.Trim() -ne $manifest.wakeTokens) {throw 'Windows wake tokens differ from the pinned model manifest.'}
if ($OutputDirectory) {
    $target=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'kws\keywords.txt'
    [IO.File]::WriteAllText($target,$manifest.wakeTokens+"`n",[Text.UTF8Encoding]::new($false))
}
Write-Host ('Offline voice models verified: '+$manifest.models.Count+' files, '+$total+' bytes; Sherpa '+$manifest.runtimeVersion+'.')
$global:LASTEXITCODE=0
