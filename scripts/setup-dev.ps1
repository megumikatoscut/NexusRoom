param([switch]$ConfigureOnly,[switch]$NoInstall,[string]$AndroidSdk='',[switch]$AcceptAndroidLicenses,[switch]$NonInteractive)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'init.ps1') -InstallMissing:(!$NoInstall) -AndroidSdk $AndroidSdk -AcceptAndroidLicenses:$AcceptAndroidLicenses -NonInteractive:$NonInteractive
if (!$ConfigureOnly) {& (Join-Path $PSScriptRoot 'build.ps1') -AndroidSdk $AndroidSdk}
$global:LASTEXITCODE=0
