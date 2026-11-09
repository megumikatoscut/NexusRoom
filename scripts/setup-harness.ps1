param([switch]$VerifySourceOnly)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
$release=Get-NexusRelease
$paths=Get-NexusPaths
$node=Initialize-NexusNode
$source=(& $node.Executable (Join-Path $PSScriptRoot 'resolve-harness-source.mjs'))
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $source -PathType Container)) {throw 'Pinned Harness source archive extraction failed.'}
$buildSource=Join-Path $paths.Cache ('sources\snapshot-'+$release.pcKernel.commit)
$saved=Save-NexusEnvironment
try {
    Add-NexusToolPath (Split-Path $node.Executable -Parent)
    Invoke-NexusNative $node.Executable @((Join-Path $PSScriptRoot 'package-harness.mjs'),'--source',$source,'--verify-source-only','--output',(Join-Path $paths.Cache 'source-verification')) 'Full pinned Harness source verification'
    if ($VerifySourceOnly) {return}
    # Work on an external source copy so the distributed snapshot stays exact.
    if (!(Test-Path -LiteralPath (Join-Path $buildSource 'HARNESS_SOURCE.json'))) {
        New-Item -ItemType Directory -Path $buildSource -Force | Out-Null
        & robocopy $source $buildSource /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NP /NFL /NDL /NJH /NJS /MT:8
        if ($LASTEXITCODE -gt 7) {throw 'External Harness source copy failed.'}
    }
    Invoke-NexusNative $node.Executable @((Join-Path $PSScriptRoot 'package-harness.mjs'),'--source',$buildSource,'--verify-source-only','--output',(Join-Path $paths.Cache 'source-verification')) 'External source verification'
    $pnpmVersion=(Get-NexusDependencyLock).pnpm.version
    $pnpm=Join-Path $paths.Pnpm 'node_modules\pnpm\bin\pnpm.cjs'
    if (!(Test-Path -LiteralPath $pnpm)) {Invoke-NexusNative $node.Executable @($node.NpmCli,'install','--prefix',$paths.Pnpm,'--no-audit','--no-fund',('pnpm@'+$pnpmVersion)) 'Fixed pnpm installation'}
    if ((& $node.Executable $pnpm --version) -ne $pnpmVersion) {throw 'pnpm version mismatch.'}
    Add-NexusToolPath (Join-Path $paths.Pnpm 'node_modules\.bin')
    $env:DSH_CLIENT_COMMIT_HASH=$release.pcKernel.commit
    $env:DSH_DESKTOP_BUILD_COMMIT=$release.pcKernel.commit
    Push-Location $buildSource
    try {
        Invoke-NexusNative $node.Executable @('--use-env-proxy',$pnpm,'install','--frozen-lockfile','--store-dir',(Join-Path $paths.Cache 'pnpm-store'),'--network-concurrency','4') 'Harness frozen dependencies'
        Invoke-NexusNative $node.Executable @('--use-env-proxy',$pnpm,'run','build') 'Complete Harness build'
    } finally {Pop-Location}
    $runtime=Join-Path $paths.Cache 'rebuilt-runtime'
    Remove-NexusGenerated $runtime $paths.Cache
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Invoke-NexusNative $node.Executable @((Join-Path $PSScriptRoot 'package-harness.mjs'),'--source',$buildSource,'--output',(Join-Path $runtime 'harness')) 'Production Harness assembly'
    $original=Join-Path (Get-NexusWindowsPayload $root $release.version) 'runtime'
    # Node and the fixed primary/browser payload are immutable dependencies.
    # Copying verified artifacts avoids redownloading hundreds of MB.
    foreach($directory in @('node','primary-runtime','office-skills','browsers')) {
        & robocopy (Join-Path $original $directory) (Join-Path $runtime $directory) /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NP /NFL /NDL /NJH /NJS /MT:8 /XD __pycache__ /XF '*.log' '*.dmp'
        if($LASTEXITCODE -gt 7){throw ('Fixed runtime copy failed: '+$directory)}
    }
    Write-Host ('Rebuilt Harness runtime: '+$runtime)
} finally {Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
