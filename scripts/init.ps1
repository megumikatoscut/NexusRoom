param([switch]$InstallMissing,[string]$AndroidSdk='',[switch]$AcceptAndroidLicenses,[switch]$NonInteractive)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$saved=Save-NexusEnvironment
try {
    & (Join-Path $PSScriptRoot 'check-environment.ps1') -PrerequisitesOnly -InstallMissing:$InstallMissing
    [void](Initialize-NexusNode)
    $sdk=& (Join-Path $PSScriptRoot 'setup-android-sdk.ps1') -AndroidSdk $AndroidSdk -AcceptLicenses:$AcceptAndroidLicenses -NonInteractive:$NonInteractive -PassThru
    Save-NexusAndroidSdkConfiguration $sdk.SdkRoot
    Set-NexusBuildEnvironment -AndroidSdk $sdk.SdkRoot
    Add-NexusToolPath (Join-Path $env:JAVA_HOME 'bin')
    Assert-NexusVersions
    Initialize-NexusNpmProject (Join-Path (Get-NexusRoot) 'src\NexusRoom.Web') 'web'
    Initialize-NexusNpmProject (Join-Path (Get-NexusRoot) 'tests') 'tests'
    Invoke-NexusNative 'dotnet' @('restore',(Join-Path (Get-NexusRoot) 'NexusRoom.sln'),'--locked-mode','-v','minimal') 'Locked NuGet restore'
    & (Join-Path $PSScriptRoot 'check-environment.ps1') -AndroidSdk $sdk.SdkRoot
    Write-Host ('Ready; development dependencies stay in '+(Get-NexusCacheRoot))
} finally {Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
