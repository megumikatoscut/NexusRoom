param(
    [switch]$InstallMissing,[switch]$RuntimeOnly,[switch]$RequireHarness,
    [string]$AndroidSdk='',[switch]$Json,[switch]$SkipAndroid,
    [switch]$PrerequisitesOnly,[switch]$AcceptAndroidLicenses,[switch]$NonInteractive
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$lock=Get-NexusDependencyLock
$release=Get-NexusRelease
$checks=New-Object 'Collections.Generic.List[object]'
function Add-Check([string]$Name,[bool]$Passed,[string]$Detail,[string]$Fix) {
    $checks.Add([pscustomobject]@{Name=$Name;Passed=$Passed;Detail=$Detail;Fix=$Fix})
}
function Install-Winget([string]$Id,[string]$Version='') {
    $command=Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $winget=if ($command) {$command.Source} else {Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'}
    if (!(Test-Path -LiteralPath $winget -PathType Leaf)) {throw 'winget is unavailable. Install Microsoft App Installer (https://aka.ms/getwinget), or use the official installers in docs/SETUP.md and rerun.'}
    $arguments=@('install','--exact','--id',$Id,'--source','winget','--accept-package-agreements','--accept-source-agreements','--silent')
    if ($Version) {$arguments+=@('--version',$Version)}
    Invoke-NexusNative $winget $arguments ('Install '+$Id+'; if this fixed version is unavailable, use the official installer in docs/SETUP.md')
}
function Test-NexusWebView {
    $id='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($base in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients','HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients','HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients')) {
        $entry=Get-ItemProperty -LiteralPath (Join-Path $base $id) -Name pv -ErrorAction SilentlyContinue
        if ($entry -and $entry.pv -and $entry.pv -ne '0.0.0.0') {return $true}
    }
    return $false
}
if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem -or ![Environment]::Is64BitProcess) {throw 'Use Windows x64 and 64-bit PowerShell 5.1 or 7.'}
Add-Check 'PowerShell' ($PSVersionTable.PSVersion -ge [version]'5.1') $PSVersionTable.PSVersion.ToString() 'Use Windows PowerShell 5.1 or PowerShell 7.'
$dotnet=$null
try {$dotnet=Get-NexusDotnet -RequireSdk:(!$RuntimeOnly)} catch { }
if (!$dotnet -and $InstallMissing) {
    if ($RuntimeOnly) {Install-Winget 'Microsoft.DotNet.DesktopRuntime.10'; Install-Winget 'Microsoft.DotNet.AspNetCore.10'}
    else {Install-Winget $lock.dotnet.wingetId $lock.dotnet.sdk}
    try {$dotnet=Get-NexusDotnet -RequireSdk:(!$RuntimeOnly)} catch { }
}
if ($dotnet) {Add-NexusToolPath $dotnet.Home}
$runtimes=if ($dotnet) {$dotnet.Runtimes} else {''}
if ($RuntimeOnly -and $InstallMissing -and $dotnet) {
    if ($runtimes -notmatch 'Microsoft.WindowsDesktop.App 10\.') {Install-Winget 'Microsoft.DotNet.DesktopRuntime.10'}
    if ($runtimes -notmatch 'Microsoft.AspNetCore.App 10\.') {Install-Winget 'Microsoft.DotNet.AspNetCore.10'}
    $dotnet=Get-NexusDotnet
    $runtimes=$dotnet.Runtimes
}
foreach ($name in @('Microsoft.NETCore.App','Microsoft.AspNetCore.App','Microsoft.WindowsDesktop.App')) {
    $passed=$runtimes -match ([regex]::Escape($name)+' 10\.')
    Add-Check $name $passed $(if ($passed) {'10.x installed'} else {'Missing runtime'}) 'Install .NET 10 Desktop and ASP.NET Core runtimes, or the fixed SDK.'
}
$vcPath=Join-Path $env:SystemRoot 'System32\vcruntime140.dll'
if (!(Test-Path -LiteralPath $vcPath) -and $InstallMissing) {Install-Winget 'Microsoft.VCRedist.2015+.x64' $release.vcRuntime.version}
Add-Check 'Visual C++ runtime x64' (Test-Path -LiteralPath $vcPath) 'Required by Node/native PC Agent dependencies' 'Run with -InstallMissing, or install the official Visual C++ x64 redistributable.'
$webViewAvailable=Test-NexusWebView
$paths=Get-NexusPaths
$chromeAvailable=[bool](Get-ChildItem -LiteralPath $paths.Browsers -Filter chrome.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
if (!$webViewAvailable -and !$chromeAvailable -and $InstallMissing) {
    Install-Winget 'Microsoft.EdgeWebView2Runtime'
    $webViewAvailable=Test-NexusWebView
}
Add-Check 'Desktop Web renderer' ($webViewAvailable -or $chromeAvailable) $(if ($webViewAvailable) {'WebView2 installed'} elseif ($chromeAvailable) {'External Chromium installed'} else {'WebView2 / external Chromium missing'}) 'Install Microsoft Edge WebView2 Runtime; full PC Agent setup also prepares Chromium.'
if (!$RuntimeOnly) {
    Add-Check '.NET SDK' ([bool]$dotnet) ('Required '+$lock.dotnet.sdk) ('Run with -InstallMissing, or install SDK '+$lock.dotnet.sdk+' from https://dotnet.microsoft.com/download/dotnet/10.0')
    $git=$null
    try {$git=Get-NexusGit} catch { }
    if (!$git -and $InstallMissing) {Install-Winget 'Git.Git'; try {$git=Get-NexusGit} catch { }}
    if ($git) {Add-NexusToolPath $git.Home}
    Add-Check 'Git' ([bool]$git) $(if ($git) {$git.Version+' at '+$git.Executable} else {'Missing Git for Windows'}) 'Install Git for Windows from https://git-scm.com/downloads/win.'
    if (!$SkipAndroid) {
        $java=$null
        try {$java=Get-NexusJava} catch { }
        if (!$java -and $InstallMissing) {Install-Winget $lock.java.wingetId; try {$java=Get-NexusJava} catch { }}
        if ($java) {$env:JAVA_HOME=$java.Home; Add-NexusToolPath (Split-Path $java.Executable -Parent)}
        Add-Check 'JDK' ([bool]$java) $(if ($java) {'JDK '+$java.Major+' at '+$java.Home} else {'Compatible full JDK not found'}) 'Install Temurin JDK 17 or 21, or use -InstallMissing. Gradle allows JDK 17 through 23.'
        if (!$PrerequisitesOnly) {
            if ($InstallMissing -and $java) {
                $sdkResult=& (Join-Path $PSScriptRoot 'setup-android-sdk.ps1') -AndroidSdk $AndroidSdk -AcceptLicenses:$AcceptAndroidLicenses -NonInteractive:$NonInteractive -PassThru
                $AndroidSdk=$sdkResult.SdkRoot
            }
            try {
                $sdk=Get-NexusAndroidSdk $AndroidSdk
                foreach ($component in @('platform-tools\adb.exe',('platforms\'+$lock.android.platform+'\android.jar'),('build-tools\'+$lock.android.buildTools+'\aapt.exe'),('build-tools\'+$lock.android.buildTools+'\apksigner.bat'))) {
                    Add-Check ('Android '+$component) (Test-Path -LiteralPath (Join-Path $sdk $component) -PathType Leaf) $sdk 'Run scripts/setup-android-sdk.ps1, review SDK licenses and install the locked components.'
                }
            } catch {Add-Check 'Android SDK' $false $_.Exception.Message 'Run scripts/setup-android-sdk.ps1 or setup-dev.cmd; an existing external SDK is reused.'}
        }
    }
    if (!$PrerequisitesOnly) {
        $node=$null
        try {$node=Get-NexusReleaseNode} catch { }
        if (!$node -and $InstallMissing) {$node=Initialize-NexusNode}
        Add-Check 'Node' ([bool]$node) $(if ($node) {$node.Version+' at '+$node.Executable} else {'Required v'+$release.pcKernel.nodeVersion}) 'Run scripts/init.ps1; it downloads and verifies the fixed official archive into the external cache.'
    }
}
if ($RequireHarness) {
    $manifest=Join-Path $paths.HarnessRuntime 'runtime-manifest.json'
    $primary=Join-Path $paths.HarnessPrimary 'primary-runtime\runtime.json'
    $valid=$false; $primaryValid=$false
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $metadata=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        $valid=$metadata.release -eq $release.version -and $metadata.kernel.commit -eq $release.pcKernel.commit
    }
    if (Test-Path -LiteralPath $primary -PathType Leaf) {
        $metadata=Get-Content -LiteralPath $primary -Raw -Encoding UTF8 | ConvertFrom-Json
        $primaryValid=$metadata.payloadDigest -eq $release.pcKernel.primaryRuntime.payloadDigest
    }
    Add-Check 'PC Agent' $valid ('Pinned Harness '+$release.pcKernel.commit.Substring(0,12)) 'Run scripts/init.ps1 -SetupHarness for the full PC Agent, browser and Office dependencies.'
    Add-Check 'Office primary runtime' $primaryValid 'Fixed external runtime digest' 'Run scripts/setup-harness.ps1 without -SkipPrimaryRuntime.'
}
if ($Json) {$checks | ConvertTo-Json -Depth 5}
else {
    $checks | Select-Object @{Name='Status';Expression={if ($_.Passed) {'OK'} else {'MISSING'}}},Name,Detail | Format-Table -AutoSize
    foreach ($check in $checks | Where-Object {!$_.Passed}) {Write-Host ($check.Name+': '+$check.Fix)}
    Write-Host ('External dependency cache: '+(Get-NexusCacheRoot))
}
if (@($checks | Where-Object {!$_.Passed}).Count) {throw 'Environment check found missing requirements. Follow the messages above or docs/SETUP.md.'}
$global:LASTEXITCODE=0
