param([switch]$SkipRuntimeVerification,[string]$PackageDirectory='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot; $version=(Get-NexusRelease).version
$package=if ($PackageDirectory) {[IO.Path]::GetFullPath($PackageDirectory)} else {Get-NexusWindowsPayload $root $version}
$stage=Join-Path (Get-NexusCacheRoot) ('finalize-'+[guid]::NewGuid().ToString('N'))
try {
    & robocopy $package $stage /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NP /NFL /NDL /NJH /NJS /MT:8 /XD .local __pycache__ /XF .nexus-complete '*.log' '*.dmp' '*.pyc'
    if ($LASTEXITCODE -gt 7) {throw 'Payload staging failed.'}
    $documents=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-documents.json') -Raw | ConvertFrom-Json
    foreach ($staleName in @('README.en.md','CONTRIBUTING.md','SECURITY.md')) {
        $stale=Join-Path $stage $staleName
        if (Test-Path -LiteralPath $stale -PathType Leaf) {Remove-Item -LiteralPath $stale -Force}
    }
    foreach ($document in Get-ChildItem -LiteralPath (Join-Path $stage 'docs') -File) {
        if ($document.Name -notin $documents.docs) {Remove-Item -LiteralPath $document.FullName -Force}
    }
    foreach ($file in @($documents.root)+@('release.json')) {Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage -Force}
    foreach ($language in @('README.md')) {Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('templates\windows\'+$language)) -Destination (Join-Path $stage $language) -Force}
    foreach ($template in $documents.docs) {
        $file=$template.Replace('{version}',$version)
        $target=Join-Path $stage ('docs\'+$file)
        if ($file -in @('PC_AGENT.md','VALIDATION.md','PROJECT_STRUCTURE.md')) {
            if (Test-Path -LiteralPath $target) {Remove-Item -LiteralPath $target -Force}
            continue
        }
        $documentSource=if ($file -eq 'THIRD_PARTY_NOTICES.md') {Join-Path $PSScriptRoot 'templates\windows\THIRD_PARTY_NOTICES.md'} else {Join-Path $root ('docs\'+$file)}
        Copy-Item -LiteralPath $documentSource -Destination $target -Force
    }
    # Refresh notices together with the documents that link to them. The retained
    # official VC license text/DOCX replace the old online page shell.
    Copy-Item -LiteralPath (Join-Path $root 'docs\licenses') -Destination (Join-Path $stage 'docs') -Recurse -Force
    $obsoleteLicense=Join-Path $stage 'docs\licenses\Microsoft-Visual-C-Runtime-LICENSE.html'
    if (Test-Path -LiteralPath $obsoleteLicense -PathType Leaf) {Remove-Item -LiteralPath $obsoleteLicense -Force}
    & (Join-Path $PSScriptRoot 'build-single-exe.ps1') -PackageDirectory $stage -SkipRuntimeVerification:$SkipRuntimeVerification
} finally {Remove-NexusGenerated $stage (Get-NexusCacheRoot)}
if (!(Test-Path -LiteralPath (Join-Path $root '.local')) -and !(Test-Path -LiteralPath (Join-Path $root 'src\NexusRoom.Web\node_modules')) -and !(Test-Path -LiteralPath (Join-Path $root 'tests\node_modules'))) {
    $node=Join-Path $package 'runtime\node\node.exe'
    # Statistics include the generated source manifest's size; the manifest
    # includes the statistics' digest. Settle both before final verification.
    for ($attempt=0; $attempt -lt 3; $attempt++) {
        Invoke-NexusNative $node @((Join-Path $PSScriptRoot 'distribute.mjs'),'--write-manifest') 'Source manifest'
        Invoke-NexusNative $node @((Join-Path $PSScriptRoot 'inventory.mjs'),'--write') 'Delivery statistics'
    }
    Invoke-NexusNative $node @((Join-Path $PSScriptRoot 'distribute.mjs'),'--write-manifest') 'Final source manifest'
    Invoke-NexusNative $node @((Join-Path $PSScriptRoot 'inventory.mjs'),'--check') 'Final delivery statistics'
    Invoke-NexusNative $node @((Join-Path $PSScriptRoot 'distribute.mjs')) 'Final source distribution'
}
$global:LASTEXITCODE=0
