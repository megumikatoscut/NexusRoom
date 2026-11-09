param([switch]$SkipPackage,[switch]$SkipTests,[switch]$DesktopRegression,[string]$AndroidSdk='',[string]$SigningDirectory='',[switch]$DevelopmentSigning)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
& (Join-Path $PSScriptRoot 'prepare-voice.ps1')
$saved=Save-NexusEnvironment
try {
    [void](Initialize-NexusNode)
    Set-NexusBuildEnvironment -AndroidSdk $AndroidSdk
    Add-NexusToolPath (Join-Path $env:JAVA_HOME 'bin')
    Assert-NexusVersions
    $node=Get-NexusReleaseNode
    & (Join-Path $PSScriptRoot 'prepare-icons.ps1')
    Initialize-NexusNpmProject (Join-Path $root 'src\NexusRoom.Web') 'web'
    foreach ($name in @('bin','obj','wwwroot')) {Remove-NexusGenerated (Join-Path $root ('src\NexusRoom.Host\'+$name)) $root}
    $tsCache=Join-Path $root 'src\NexusRoom.Web\tsconfig.tsbuildinfo'
    if (Test-Path -LiteralPath $tsCache) {Remove-Item -LiteralPath $tsCache -Force}
    Invoke-NexusNative $node.Executable @($node.NpmCli,'run','build','--prefix',(Join-Path $root 'src\NexusRoom.Web')) 'Fresh Web build'
    Invoke-NexusNative 'dotnet' @('restore',(Join-Path $root 'NexusRoom.sln'),'--locked-mode','-v','minimal') 'Locked NuGet restore'
    Invoke-NexusNative 'dotnet' @('build',(Join-Path $root 'src\NexusRoom.Host'),'--no-restore','--disable-build-servers','-v','minimal') 'Fresh Windows build'
    & (Join-Path $PSScriptRoot 'gradle.ps1') clean assembleDebug lintDebug assembleRelease lintRelease :app:prepareRoomRegressionDependencies --no-build-cache --rerun-tasks --console=plain
    if (!$SkipTests) {& (Join-Path $PSScriptRoot 'verify.ps1') -DesktopRegression:$DesktopRegression}
    if (!$SkipPackage) {
        & (Join-Path $PSScriptRoot 'package.ps1') -SkipWebBuild -AndroidSdk $env:ANDROID_HOME -SigningDirectory $SigningDirectory -DevelopmentSigning:$DevelopmentSigning
    }
} finally {Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
