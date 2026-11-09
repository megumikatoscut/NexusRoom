param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot; $version=(Get-NexusRelease).version
$artifacts=Resolve-NexusProjectPath $root 'artifacts'
$exe=Resolve-NexusProjectPath $root ('artifacts\NexusRoom-Windows-x64-'+$version+'.exe')
if (!(Test-Path -LiteralPath $exe)) {& (Join-Path $PSScriptRoot 'finalize-release.ps1')}
$package=Get-NexusWindowsPayload $root $version
& (Join-Path $PSScriptRoot 'invoke-release-verification.ps1') -NodeExecutable (Join-Path $package 'runtime\node\node.exe') -PackageDirectory $package -InventoryOnly -AllowHistoricalDocuments
$apk=Resolve-NexusProjectPath $root ('artifacts\NexusRoom-Android-'+$version+'.apk')
if ((Get-FileHash -LiteralPath $apk).Hash -ne (Get-FileHash -LiteralPath (Join-Path $package 'tools\NexusRoom-Android.apk')).Hash) {throw 'APK copies differ.'}
$lines=@($exe,$apk) | ForEach-Object {(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+(Get-NexusChecksumName $root $_)}
foreach ($name in @('SHA256SUMS.txt','RELEASE_SHA256SUMS.txt')) {[IO.File]::WriteAllLines((Join-Path $artifacts $name),[string[]]$lines,[Text.UTF8Encoding]::new($false))}
Write-Host ('Release attachments ready: single Windows EXE, Android APK and RELEASE_SHA256SUMS.txt for v'+$version)
