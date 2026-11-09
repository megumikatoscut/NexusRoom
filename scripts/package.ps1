param([string]$AndroidSdk='',[switch]$SkipWebBuild,[string]$RuntimeSource='',[string]$SigningDirectory='',[switch]$DevelopmentSigning)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
& (Join-Path $PSScriptRoot 'prepare-voice.ps1')
$release=Get-NexusRelease
$version=$release.version
$artifactRoot=Get-NexusBuildReleaseRoot
if (!$RuntimeSource) {$RuntimeSource=Join-Path (Get-NexusWindowsPayload $root $version) 'runtime'}
$RuntimeSource=[IO.Path]::GetFullPath($RuntimeSource)
& (Join-Path $PSScriptRoot 'prepare-icons.ps1') -PythonExecutable (Join-Path $RuntimeSource 'primary-runtime\dependencies\python\python.exe')
if (!(Test-Path -LiteralPath (Join-Path $RuntimeSource 'harness\runtime-manifest.json'))) {throw 'A complete pinned runtime is required. Supply -RuntimeSource with the matched runtime directory.'}
$stage=Join-Path (Get-NexusCacheRoot) ('release-staging-'+[guid]::NewGuid().ToString('N'))
$saved=Save-NexusEnvironment
function Copy-NexusPayload([string]$Source,[string]$Destination) {
    & robocopy $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NP /NFL /NDL /NJH /NJS /MT:8 /XD __pycache__ .history /XF '*.log' '*.dmp'
    if ($LASTEXITCODE -gt 7) {throw ('Payload copy failed: '+$Source)}
}
try {
    Set-NexusBuildEnvironment -AndroidSdk $AndroidSdk
    Add-NexusToolPath (Join-Path $env:JAVA_HOME 'bin')
    Assert-NexusVersions
    $node=Get-NexusReleaseNode
    if (!$SkipWebBuild) {
        Initialize-NexusNpmProject (Join-Path $root 'src\NexusRoom.Web') 'web'
        Invoke-NexusNative $node.Executable @($node.NpmCli,'run','build','--prefix',(Join-Path $root 'src\NexusRoom.Web')) 'Web build'
    }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Invoke-NexusNative 'dotnet' @('publish',(Join-Path $root 'src\NexusRoom.Host'),'-c','Release','-r','win-x64','--self-contained','true','--disable-build-servers','-p:PublishSingleFile=false','-p:RestoreLockedMode=true','-o',$stage,'-v','minimal') 'Fresh self-contained Windows publish'
    Get-ChildItem -LiteralPath $stage -Filter '*.pdb' -File | Remove-Item -Force
    Copy-NexusPayload $RuntimeSource (Join-Path $stage 'runtime')
    $manifestPath=Join-Path $stage 'runtime\harness\runtime-manifest.json'
    $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.files=@($manifest.files | Where-Object {$_.path -notmatch '(^|[\\/])\.history([\\/]|$)'})
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 100)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    $unsigned=Join-Path (Get-NexusPaths).AndroidApp 'outputs\apk\release\app-release-unsigned.apk'
    New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -Force | Out-Null
    & (Join-Path $PSScriptRoot 'sign-release-apk.ps1') -UnsignedApk $unsigned -OutputApk (Join-Path $stage 'tools\NexusRoom-Android.apk') -AndroidSdk $env:ANDROID_HOME -SigningDirectory $SigningDirectory -DevelopmentSigning:$DevelopmentSigning
    & (Join-Path $PSScriptRoot 'verify-voice-apk.ps1') -Apk (Join-Path $stage 'tools\NexusRoom-Android.apk')
    $documents=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-documents.json') -Raw | ConvertFrom-Json
    New-Item -ItemType Directory -Path (Join-Path $stage 'docs') -Force | Out-Null
    foreach ($template in $documents.docs) {
        $file=$template.Replace('{version}',$version)
        if ($file -in @('PC_AGENT.md','VALIDATION.md','PROJECT_STRUCTURE.md')) {continue}
        $documentSource=if ($file -eq 'THIRD_PARTY_NOTICES.md') {Join-Path $PSScriptRoot 'templates\windows\THIRD_PARTY_NOTICES.md'} else {Join-Path $root ('docs\'+$file)}
        Copy-Item -LiteralPath $documentSource -Destination (Join-Path $stage ('docs\'+$file))
    }
    Copy-Item -LiteralPath (Join-Path $root 'docs\licenses') -Destination (Join-Path $stage 'docs') -Recurse
    foreach ($file in @($documents.root)+@('release.json')) {Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage}
    Copy-Item -LiteralPath (Join-Path $root 'scripts\templates\windows\README.md') -Destination (Join-Path $stage 'README.md') -Force
    foreach ($component in @('microsoft.netcore.app.runtime.win-x64','microsoft.aspnetcore.app.runtime.win-x64','microsoft.windowsdesktop.app.runtime.win-x64')) {
        $componentRoot=Join-Path $env:NUGET_PACKAGES $component
        $runtimeVersion=Get-ChildItem -LiteralPath $componentRoot -Directory | Sort-Object {[version]$_.Name} -Descending | Select-Object -First 1
        foreach ($name in @('LICENSE.TXT','THIRD-PARTY-NOTICES.TXT')) {
            $notice=Join-Path $runtimeVersion.FullName $name
            if (Test-Path -LiteralPath $notice) {Copy-Item -LiteralPath $notice -Destination (Join-Path $stage ("docs\licenses\$component-$name"))}
        }
    }
    & (Join-Path $PSScriptRoot 'invoke-release-verification.ps1') -NodeExecutable (Join-Path $stage 'runtime\node\node.exe') -PackageDirectory $stage
    $apk=Get-NexusBuildArtifactPath ('NexusRoom-Android-'+$version+'.apk')
    New-Item -ItemType Directory -Path (Split-Path $apk -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $stage 'tools\NexusRoom-Android.apk') -Destination $apk -Force
    & (Join-Path $PSScriptRoot 'build-single-exe.ps1') -PackageDirectory $stage -SkipRuntimeVerification
    Write-Host ('Single Windows EXE and installable Android APK: '+$artifactRoot)
} finally {Remove-NexusGenerated $stage (Get-NexusCacheRoot); Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
