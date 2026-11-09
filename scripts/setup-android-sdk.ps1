<#
.SYNOPSIS
Prepare the project Android SDK outside the repository, without Android Studio.
.DESCRIPTION
Requires a compatible JDK. Existing complete SDKs are reused without changing
their tools or licenses. Missing command-line tools are downloaded from the
fixed Google archive in dependencies.lock.json and verified with SHA-256.
SDK licenses are interactive by default. Only -AcceptLicenses supplies yes.
-NonInteractive never accepts a license unless -AcceptLicenses is also given.
The selected SDK is remembered only in the external build cache; no User or
Machine environment variables are written.
.PARAMETER AndroidSdk
An absolute SDK directory outside the repository. It may not exist yet.
.PARAMETER AcceptLicenses
Explicit permission to accept Android SDK licenses for the selected SDK.
.PARAMETER NonInteractive
Prevent license prompts. Reuse accepted licenses, or explicitly also pass
-AcceptLicenses after reviewing the Android SDK terms.
.PARAMETER PassThru
Return one object with SdkRoot, SdkManager, JavaHome, CommandLineToolsVersion,
InstalledPackages, and PackageRevisions for callers such as init.ps1.
.EXAMPLE
.\scripts\setup-android-sdk.ps1
.EXAMPLE
.\scripts\setup-android-sdk.ps1 -AndroidSdk $env:ANDROID_HOME -AcceptLicenses -NonInteractive -PassThru
#>
[CmdletBinding()]
param(
    [string]$AndroidSdk='',
    [switch]$AcceptLicenses,
    [switch]$NonInteractive,
    [switch]$PassThru
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem) {throw 'Android SDK setup requires Windows x64.'}

function Get-NexusSdkProperty([string]$Directory,[string]$Name) {
    $properties=Join-Path $Directory 'source.properties'
    if (!(Test-Path -LiteralPath $properties -PathType Leaf)) {return ''}
    foreach ($line in [IO.File]::ReadAllLines($properties)) {
        if ($line -match ('^\s*'+[regex]::Escape($Name)+'\s*=\s*(.*?)\s*$')) {return $Matches[1]}
    }
    return ''
}

function Find-NexusSdkManager([string]$SdkRoot) {
    $toolsRoot=Join-Path $SdkRoot 'cmdline-tools'
    $candidates=@((Join-Path $toolsRoot 'latest'),(Join-Path $toolsRoot $script:AndroidLock.commandLineTools.version))
    if (Test-Path -LiteralPath $toolsRoot -PathType Container) {
        $candidates+=@(Get-ChildItem -LiteralPath $toolsRoot -Directory | Sort-Object Name -Descending | Select-Object -ExpandProperty FullName)
    }
    foreach ($directory in $candidates | Select-Object -Unique) {
        $manager=Join-Path $directory 'bin\sdkmanager.bat'
        if (Test-Path -LiteralPath $manager -PathType Leaf) {
            [void](Assert-NexusExternalDirectory $directory 'Android command-line tools')
            return [pscustomobject]@{Executable=$manager;Directory=$directory;Version=(Get-NexusSdkProperty $directory 'Pkg.Revision')}
        }
    }
    return $null
}

function Get-NexusSdkMissingPackages([string]$SdkRoot) {
    $platform=Join-Path $SdkRoot ('platforms\'+$script:AndroidLock.platform)
    $buildTools=Join-Path $SdkRoot ('build-tools\'+$script:AndroidLock.buildTools)
    $platformTools=Join-Path $SdkRoot 'platform-tools'
    # sdkmanager writes below these directories. Validate existing junctions
    # before reading them so an external SDK cannot redirect writes into Git.
    [void](Assert-NexusChildPath $platform $SdkRoot)
    [void](Assert-NexusChildPath $buildTools $SdkRoot)
    [void](Assert-NexusChildPath $platformTools $SdkRoot)
    if (!(Test-Path -LiteralPath (Join-Path $platform 'android.jar') -PathType Leaf) -or !(Get-NexusSdkProperty $platform 'Pkg.Revision')) {
        'platforms;'+$script:AndroidLock.platform
    }
    $buildComplete=(Get-NexusSdkProperty $buildTools 'Pkg.Revision') -eq $script:AndroidLock.buildTools
    foreach ($file in @('aapt.exe','aapt2.exe','zipalign.exe','apksigner.bat','lib\apksigner.jar')) {
        if (!(Test-Path -LiteralPath (Join-Path $buildTools $file) -PathType Leaf)) {$buildComplete=$false}
    }
    if (!$buildComplete) {'build-tools;'+$script:AndroidLock.buildTools}
    $platformToolsComplete=[bool](Get-NexusSdkProperty $platformTools 'Pkg.Revision')
    foreach ($file in @('adb.exe','AdbWinApi.dll','AdbWinUsbApi.dll')) {
        if (!(Test-Path -LiteralPath (Join-Path $platformTools $file) -PathType Leaf)) {$platformToolsComplete=$false}
    }
    if (!$platformToolsComplete) {$script:AndroidLock.platformToolsPackage}
}

function Invoke-NexusSdkManager($Manager,[string[]]$Arguments,[string]$Label) {
    # Native diagnostics use stderr; PowerShell 5.1 must not turn a warning
    # into an exception before we can inspect sdkmanager's actual exit code.
    $previousPreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        if ($AcceptLicenses) {
            1..64 | ForEach-Object {'y'} | & $Manager.Executable @Arguments | Out-Host
        } elseif ($NonInteractive) {
            1..64 | ForEach-Object {'n'} | & $Manager.Executable @Arguments | Out-Host
        } else {
            & $Manager.Executable @Arguments | Out-Host
        }
        $exitCode=$LASTEXITCODE
    } finally {$ErrorActionPreference=$previousPreference}
    if ($exitCode -ne 0) {throw ($Label+' failed (exit '+$exitCode+'). Check the SDK Manager diagnostics above.')}
}

$script:AndroidLock=(Get-NexusDependencyLock).android
if ($script:AndroidLock.commandLineTools.version -notmatch '^\d+\.\d+$' -or $script:AndroidLock.platform -notmatch '^android-\d+$' -or $script:AndroidLock.buildTools -notmatch '^\d+\.\d+\.\d+$' -or $script:AndroidLock.platformToolsPackage -ne 'platform-tools') {
    throw 'The Android dependency lock has invalid package versions.'
}
$java=Get-NexusJava
if ($java.Major -lt $script:AndroidLock.commandLineTools.minimumJavaMajor) {throw 'The pinned Android command-line tools require JDK 17 or later.'}
[void](Assert-NexusExternalDirectory $java.Home 'JDK')
$configuration=Get-NexusToolchainConfiguration
if (!$AndroidSdk) {
    foreach ($candidate in @($env:ANDROID_HOME,$env:ANDROID_SDK_ROOT,$configuration.androidSdk,[Environment]::GetEnvironmentVariable('ANDROID_HOME','User'),[Environment]::GetEnvironmentVariable('ANDROID_HOME','Machine'))) {
        if ($candidate) {$AndroidSdk=$candidate; break}
    }
}
if (!$AndroidSdk) {
    $studioSdk=Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    $AndroidSdk=if (Test-Path -LiteralPath $studioSdk -PathType Container) {$studioSdk} else {Join-Path $env:USERPROFILE '.cache\NexusRoom\android-sdk'}
}
$sdk=Assert-NexusExternalDirectory $AndroidSdk 'Android SDK'
if ($sdk -eq [IO.Path]::GetPathRoot($sdk).TrimEnd('\')) {throw 'Choose a dedicated Android SDK directory, not a drive root.'}
$paths=Get-NexusPaths
$saved=Save-NexusEnvironment
$lockHash=[Security.Cryptography.SHA256]::Create()
try {$sdkId=[BitConverter]::ToString($lockHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($sdk.ToUpperInvariant()))).Replace('-','')}
finally {$lockHash.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\NexusRoom-AndroidSdk-'+$sdkId))
$locked=$false
$downloadedTools=$false
$installedNow=@()
try {
    try {$locked=$mutex.WaitOne(60000)} catch [Threading.AbandonedMutexException] {$locked=$true}
    if (!$locked) {throw 'Another process is preparing this Android SDK. Retry after it completes.'}
    $env:JAVA_HOME=$java.Home
    $env:ANDROID_HOME=$sdk
    $env:ANDROID_SDK_ROOT=$sdk
    $missing=@(Get-NexusSdkMissingPackages $sdk)
    $manager=Find-NexusSdkManager $sdk
    if ($missing.Count) {
        if ($NonInteractive -and !$AcceptLicenses) {
            $license=Join-Path $sdk 'licenses\android-sdk-license'
            if (!(Test-Path -LiteralPath $license -PathType Leaf) -or [IO.File]::ReadAllText($license) -notmatch '(?m)^\s*[a-fA-F0-9]{40}\s*$') {
                throw 'Android SDK licenses have not been accepted. Rerun without -NonInteractive to review them, or explicitly add -AcceptLicenses after reviewing https://developer.android.com/studio/terms.'
            }
        }
        New-Item -ItemType Directory -Path $sdk -Force | Out-Null
        if (!$manager) {
            $tools=$script:AndroidLock.commandLineTools
            $archiveName=([uri]$tools.url).Segments[-1]
            $archive=Get-NexusVerifiedDownload $tools.url $tools.sha256 (Join-Path $paths.Downloads $archiveName)
            if ((Get-Item -LiteralPath $archive).Length -ne [long]$tools.archiveSize) {throw 'The Android command-line tools archive has an unexpected size.'}
            $stage=Join-Path $paths.Cache ('android-cli-extract-'+[guid]::NewGuid().ToString('N'))
            [void](Assert-NexusChildPath $stage $paths.Cache)
            $destination=Join-Path $sdk ('cmdline-tools\'+$tools.version)
            [void](Assert-NexusChildPath $destination $sdk)
            if (Test-Path -LiteralPath $destination) {throw ('Incomplete command-line tools already exist. Repair or rename this directory before retrying: '+$destination)}
            try {
                Write-Host ('Installing verified Android command-line tools '+$tools.version+' outside Git: '+$destination)
                Expand-Archive -LiteralPath $archive -DestinationPath $stage
                $unpacked=Join-Path $stage 'cmdline-tools'
                if ((Get-NexusSdkProperty $unpacked 'Pkg.Revision') -ne $tools.version -or !(Test-Path -LiteralPath (Join-Path $unpacked 'bin\sdkmanager.bat') -PathType Leaf)) {throw 'The verified archive has an unexpected command-line tools layout or revision.'}
                New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
                Move-Item -LiteralPath $unpacked -Destination $destination
                $downloadedTools=$true
            } finally {Remove-NexusGenerated $stage $paths.Cache}
            $manager=Find-NexusSdkManager $sdk
        }
        if (!$manager) {throw 'Android SDK Manager is unavailable after command-line tools setup.'}
        if (!$NonInteractive -or $AcceptLicenses) {
            if ($AcceptLicenses) {Write-Host 'Accepting Android SDK licenses because -AcceptLicenses was explicitly supplied.'}
            else {Write-Host 'Review the Android SDK licenses below. Accept or decline each prompt yourself.'}
            Invoke-NexusSdkManager $manager @(('--sdk_root='+$sdk),'--licenses') 'Android SDK license review'
        }
        Write-Host ('Installing missing Android packages: '+($missing -join ', '))
        Invoke-NexusSdkManager $manager (@(('--sdk_root='+$sdk),'--channel=0')+$missing) 'Android SDK component installation'
        $remaining=@(Get-NexusSdkMissingPackages $sdk)
        if ($remaining.Count) {throw ('Android SDK setup is incomplete: '+($remaining -join ', ')+'. Review the SDK licenses or the network diagnostics, then retry.')}
        $installedNow=$missing
    }
    Save-NexusAndroidSdkConfiguration $sdk
    $revisions=[ordered]@{}
    $revisions['platforms;'+$script:AndroidLock.platform]=Get-NexusSdkProperty (Join-Path $sdk ('platforms\'+$script:AndroidLock.platform)) 'Pkg.Revision'
    $revisions['build-tools;'+$script:AndroidLock.buildTools]=Get-NexusSdkProperty (Join-Path $sdk ('build-tools\'+$script:AndroidLock.buildTools)) 'Pkg.Revision'
    $revisions[$script:AndroidLock.platformToolsPackage]=Get-NexusSdkProperty (Join-Path $sdk 'platform-tools') 'Pkg.Revision'
    $result=[pscustomobject]@{
        SdkRoot=$sdk
        SdkManager=$(if ($manager) {$manager.Executable} else {''})
        JavaHome=$java.Home
        CommandLineToolsVersion=$(if ($manager) {$manager.Version} else {''})
        InstalledPackages=@(('platforms;'+$script:AndroidLock.platform),('build-tools;'+$script:AndroidLock.buildTools),$script:AndroidLock.platformToolsPackage)
        PackageRevisions=[pscustomobject]$revisions
        InstalledNow=$installedNow
        DownloadedCommandLineTools=$downloadedTools
    }
    [IO.File]::WriteAllText((Join-Path $paths.Cache 'android-sdk-result.json'),($result | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    Write-Host ('Android SDK ready: '+$sdk)
    Write-Host ('Package revisions: '+(($revisions.Keys | ForEach-Object {$_+'='+$revisions[$_]}) -join ', '))
    if ($PassThru) {$result}
} finally {
    Restore-NexusEnvironment $saved
    if ($locked) {$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
$global:LASTEXITCODE=0
