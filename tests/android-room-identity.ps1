param([string]$AndroidSdk=$env:ANDROID_HOME,[string]$GradleCache='')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'scripts\common.ps1')
if (!$GradleCache) {$gradleHome=if ($env:GRADLE_USER_HOME) {$env:GRADLE_USER_HOME} else {(Get-NexusPaths).GradleUser}; $GradleCache=Join-Path $gradleHome 'caches\modules-2\files-2.1'}
if (!$AndroidSdk) {$AndroidSdk=Get-NexusAndroidSdk}
$androidJar=Join-Path $AndroidSdk 'platforms\android-35\android.jar'
if (!(Test-Path -LiteralPath $androidJar)) {throw 'Android 35 SDK is required.'}
$fixture=Join-Path $root ('.local\android-room-identity-'+[guid]::NewGuid().ToString('N'))
$classes=Join-Path $fixture 'classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
function CacheJar([string]$Artifact,[string]$Version) {
    $directory=Join-Path $GradleCache ($Artifact+'\'+$Version)
    $jar=Get-ChildItem -LiteralPath $directory -Filter '*.jar' -Recurse | Where-Object {$_.Name -notmatch '-(sources|javadoc)\.jar$'} | Select-Object -First 1
    if (!$jar) {throw "Missing cached Java dependency: $Artifact $Version"}
    return $jar.FullName
}
# Put the real JSON library before android.jar's non-executable JVM stubs.
$dependencies=@(
    (CacheJar 'org.json\json' '20240303'),
    (CacheJar 'com.squareup.okhttp3\okhttp' '4.12.0'),
    (CacheJar 'com.squareup.okio\okio-jvm' '3.6.0'),
    (CacheJar 'org.jetbrains.kotlin\kotlin-stdlib' '1.9.25'),
    $androidJar
)
$classpath=$dependencies -join [IO.Path]::PathSeparator
$buildConfig=Join-Path $fixture 'BuildConfig.java'
[IO.File]::WriteAllText($buildConfig,'package com.nexusroom.android; final class BuildConfig { static final String VERSION_NAME="identity-test"; }',[Text.UTF8Encoding]::new($false))
$main=Join-Path $root 'android\app\src\main\java\com\nexusroom\android'
$sources=@((Join-Path $main 'RoomConfig.java'),(Join-Path $main 'RoomDiscovery.java'),(Join-Path $main 'ReleaseStorage.java'),$buildConfig,(Join-Path $PSScriptRoot 'java\com\nexusroom\android\RoomIdentityTest.java'))
& javac -encoding UTF-8 --release 17 --add-modules jdk.httpserver -cp $classpath -d $classes $sources
if ($LASTEXITCODE -ne 0) {throw 'Android room identity regression compilation failed.'}
foreach ($name in @('original','stranger')) {
    $certificate=Join-Path $fixture ($name+'.p12')
    # Windows PowerShell treats keytool's successful stderr notice as an error.
    $previousErrorAction=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        & keytool -genkeypair -alias server -keyalg RSA -keysize 2048 -validity 2 -dname 'CN=NexusRoom Identity Fixture' -ext 'SAN=ip:127.0.0.1' -storetype PKCS12 -keystore $certificate -storepass fixture-only -keypass fixture-only -noprompt 2>&1 | Out-Null
        $certificateExitCode=$LASTEXITCODE
    } finally {$ErrorActionPreference=$previousErrorAction}
    if ($certificateExitCode -ne 0) {throw 'Local HTTPS fixture certificate creation failed.'}
}
& java --add-modules jdk.httpserver -cp ($classes+[IO.Path]::PathSeparator+$classpath) com.nexusroom.android.RoomIdentityTest (Join-Path $fixture 'original.p12') (Join-Path $fixture 'stranger.p12')
if ($LASTEXITCODE -ne 0) {throw 'Android room identity regression checks failed.'}
