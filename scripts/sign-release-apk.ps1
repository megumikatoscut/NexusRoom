param(
    [Parameter(Mandatory=$true)][string]$UnsignedApk,
    [Parameter(Mandatory=$true)][string]$OutputApk,
    [string]$AndroidSdk=$env:ANDROID_HOME,
    [string]$SigningDirectory='',
    [switch]$DevelopmentSigning
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'common.ps1')
$release=Get-Content -Raw (Join-Path $root 'release.json') | ConvertFrom-Json
$artifactRoot=[IO.Path]::GetFullPath((Get-NexusBuildReleaseRoot)).TrimEnd('\')
$cacheRoot=Get-NexusCacheRoot
$unsigned=[IO.Path]::GetFullPath($UnsignedApk)
$output=[IO.Path]::GetFullPath($OutputApk)
if ($output.StartsWith($cacheRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {$artifactRoot=$cacheRoot}
if (!$output.StartsWith($artifactRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($output) -ne '.apk') {throw 'Signed APK output must stay inside release artifacts or the external build cache.'}
$cursor=$output
while ($cursor.Length -ge $artifactRoot.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Refusing a linked APK output path.'}
    if ($cursor.Equals($artifactRoot,[StringComparison]::OrdinalIgnoreCase)) {break}
    $cursor=[IO.Path]::GetDirectoryName($cursor)
}
if (!(Test-Path -LiteralPath $unsigned -PathType Leaf)) {throw 'The production unsigned APK is missing.'}
if ((Get-Item -LiteralPath $unsigned -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Refusing a linked unsigned APK.'}
if (!$AndroidSdk) {$AndroidSdk=$env:ANDROID_SDK_ROOT}
. (Join-Path $root 'scripts\common.ps1')
if (!$AndroidSdk) {$AndroidSdk=Get-NexusAndroidSdk}
$buildTools=Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'build-tools') -Directory | Where-Object {$_.Name -match '^\d+\.\d+\.\d+$'} | Sort-Object {[version]$_.Name} -Descending | Select-Object -First 1
if (!$buildTools) {throw 'Android SDK build-tools are required.'}
$aapt=Join-Path $buildTools.FullName 'aapt.exe'
$signer=Join-Path $buildTools.FullName 'apksigner.bat'
$badging=(& $aapt dump badging $unsigned) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0 -or !$badging.Contains("package: name='com.nexusroom.android'") -or !$badging.Contains("versionName='$($release.version)'") -or !$badging.Contains("versionCode='$($release.androidVersionCode)'")) {throw 'Production APK application ID or release version mismatch.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$metadata=[IO.Compression.ZipFile]::OpenRead($unsigned)
try {
    if (@($metadata.Entries | Where-Object {$_.FullName -match 'version-control-info|(?:^|/)(?:state|launch|certificate)\.dat$'}).Count) {throw 'Unsigned APK contains VCS metadata or persisted state.'}
} finally {$metadata.Dispose()}
$keys=if ($SigningDirectory) {[IO.Path]::GetFullPath($SigningDirectory)} elseif ($env:NEXUS_SIGNING_DIR) {[IO.Path]::GetFullPath($env:NEXUS_SIGNING_DIR)} else {Join-Path $env:LOCALAPPDATA 'NexusRoom\signing'}
if ($DevelopmentSigning) {$keys=Join-Path (Get-NexusCacheRoot) 'development-signing'}
$vault=Join-Path $keys 'password.dat'
$keystore=Join-Path $keys 'nexusroom-release.jks'
if ($DevelopmentSigning -and !(Test-Path -LiteralPath $keystore)) {
    New-Item -ItemType Directory -Path $keys -Force | Out-Null
    & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -keystore $keystore -alias nexusroom -keyalg RSA -keysize 2048 -validity 3650 -storepass android -keypass android -dname 'CN=NexusRoom Development'
    if ($LASTEXITCODE -ne 0) {throw 'Development signing identity generation failed.'}
}
foreach ($file in @($vault,$keystore)) {
    if ($DevelopmentSigning -and $file -eq $vault) {continue}
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {throw 'The existing persistent release signing identity is required; this command never creates one.'}
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Refusing a linked release signing identity.'}
}
# Public certificate digest declared by the current release, never a key.
$expectedCertificate=$release.androidSigning.certificateSha256
if (!$DevelopmentSigning -and $expectedCertificate -notmatch '^[0-9a-f]{64}$') {throw 'release.json must declare the intended release certificate SHA-256.'}
New-Item -ItemType Directory -Path (Split-Path $output -Parent) -Force | Out-Null
$staged=Join-Path (Split-Path $output -Parent) ('.signed-'+[guid]::NewGuid().ToString('N')+'.apk')
$previousSigning=$env:NEXUS_SIGNING_PASSWORD
$secret=$null
$secretBytes=$null
try {
    Add-Type -AssemblyName System.Security
    if ($DevelopmentSigning) {$secret='android'} else {try {
        $secretBytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($vault),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $secret=[Text.Encoding]::UTF8.GetString($secretBytes)
    } catch {throw 'Existing release signing credentials could not be opened for the current Windows user.'}}
    $env:NEXUS_SIGNING_PASSWORD=$secret
    $previousNativePreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        & $signer sign --ks $keystore --ks-key-alias nexusroom --ks-pass env:NEXUS_SIGNING_PASSWORD --key-pass env:NEXUS_SIGNING_PASSWORD --out $staged $unsigned 2>&1 | Out-Null
        $signExit=$LASTEXITCODE
        if ($signExit -ne 0) {throw 'Production APK signing failed.'}
        $verification=(& $signer verify --print-certs $staged 2>&1) -join [Environment]::NewLine
        $verifyExit=$LASTEXITCODE
    } finally {$ErrorActionPreference=$previousNativePreference}
    if ($verifyExit -ne 0) {throw 'Signed APK verification failed.'}
    $certificates=[regex]::Matches($verification,'(?im)^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f]{64})\s*$')
    if ($certificates.Count -ne 1 -or (!$DevelopmentSigning -and $certificates[0].Groups[1].Value.ToLowerInvariant() -ne $expectedCertificate)) {throw 'Signed APK certificate differs from the intended NexusRoom release identity.'}
    if (Test-Path -LiteralPath $output) {[IO.File]::Replace($staged,$output,[NullString]::Value)}
    else {[IO.File]::Move($staged,$output)}
} finally {
    $env:NEXUS_SIGNING_PASSWORD=$previousSigning
    $secret=$null
    if ($secretBytes) {[Array]::Clear($secretBytes,0,$secretBytes.Length)}
    foreach ($file in @($staged,($staged+'.idsig'))) {if (Test-Path -LiteralPath $file) {Remove-Item -LiteralPath $file -Force}}
}
$global:LASTEXITCODE=0
