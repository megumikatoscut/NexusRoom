param([string]$AndroidSdk=$env:ANDROID_HOME,[string]$GradleCache='',[string]$ServiceSource='')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'scripts\common.ps1')
if (!$GradleCache) {$gradleHome=if ($env:GRADLE_USER_HOME) {$env:GRADLE_USER_HOME} else {(Get-NexusPaths).GradleUser}; $GradleCache=Join-Path $gradleHome 'caches\modules-2\files-2.1'}
if (!$AndroidSdk) {$AndroidSdk=Get-NexusAndroidSdk}
$androidJar=Join-Path $AndroidSdk 'platforms\android-35\android.jar'
if (!(Test-Path -LiteralPath $androidJar)) {throw 'Android 35 SDK is required.'}
$fixture=Join-Path $root ('.local\android-room-session-'+[guid]::NewGuid().ToString('N'))
$classes=Join-Path $fixture 'classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
function CacheArtifact([string]$Artifact,[string]$Version,[string]$Extension='jar') {
    $directory=Join-Path $GradleCache ($Artifact+'\'+$Version)
    if (!(Test-Path -LiteralPath $directory) -and $env:GRADLE_USER_HOME) {
        $alternate=Join-Path $env:GRADLE_USER_HOME ('caches\modules-2\files-2.1\'+$Artifact+'\'+$Version)
        if (Test-Path -LiteralPath $alternate) {$directory=$alternate}
    }
    $file=Get-ChildItem -LiteralPath $directory -Filter ('*.'+$Extension) -Recurse | Where-Object {$_.Name -notmatch '-(sources|javadoc)\.'} | Select-Object -First 1
    if (!$file) {throw "Missing cached Java dependency: $Artifact $Version"}
    return $file.FullName
}
function LatestJar([string]$Artifact) {
    $directory=Join-Path $GradleCache $Artifact
    $file=Get-ChildItem -LiteralPath $directory -Filter '*.jar' -Recurse | Where-Object {$_.Name -notmatch '-(sources|javadoc)\.jar$'} | Sort-Object FullName -Descending | Select-Object -First 1
    if (!$file) {throw "Missing Android test-platform dependency: $Artifact"}
    return $file.FullName
}
$generatorDependencies=@(
    (LatestJar 'com.android.tools.build\builder'),
    (LatestJar 'com.android.tools\common'),
    (LatestJar 'com.google.guava\guava'),
    (LatestJar 'org.ow2.asm\asm'),
    (LatestJar 'org.ow2.asm\asm-tree'),
    (LatestJar 'org.ow2.asm\asm-commons')
)
$generatorClasspath=$generatorDependencies -join [IO.Path]::PathSeparator
& javac '-J-Duser.language=en' -encoding UTF-8 --release 17 -cp $generatorClasspath -d $classes (Join-Path $PSScriptRoot 'java\GenerateMockableAndroid.java')
if ($LASTEXITCODE -ne 0) {throw 'Android JVM platform generator compilation failed.'}
$mockableAndroid=Join-Path $fixture 'mockable-android.jar'
& java -cp ($classes+[IO.Path]::PathSeparator+$generatorClasspath) GenerateMockableAndroid $androidJar $mockableAndroid
if ($LASTEXITCODE -ne 0) {throw 'Android JVM platform generation failed.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function AarClasses([string]$Artifact,[string]$Version,[string]$Name) {
    $target=Join-Path $fixture ($Name+'.jar')
    $archive=[IO.Compression.ZipFile]::OpenRead((CacheArtifact $Artifact $Version 'aar'))
    try {[IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry('classes.jar'),$target)} finally {$archive.Dispose()}
    return $target
}
function LocalAarClasses([string]$Path,[string]$Name) {
    $target=Join-Path $fixture ($Name+'.jar')
    $archive=[IO.Compression.ZipFile]::OpenRead($Path)
    try {[IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry('classes.jar'),$target)} finally {$archive.Dispose()}
    return $target
}
# Compile and exercise the real RoomService and its real Java collaborators.
# Only Android framework calls use the AGP JVM platform; JSON and OkHttp are real.
$dependencies=@(
    (CacheArtifact 'org.json\json' '20240303'),
    (CacheArtifact 'com.squareup.okhttp3\okhttp' '4.12.0'),
    (CacheArtifact 'com.squareup.okio\okio-jvm' '3.6.0'),
    (CacheArtifact 'org.jetbrains.kotlin\kotlin-stdlib' '1.9.25'),
    (LatestJar 'com.google.zxing\core'),
    (AarClasses 'androidx.core\core' '1.13.1' 'androidx-core'),
    (AarClasses 'com.journeyapps\zxing-android-embedded' '4.3.0' 'zxing-embedded'),
    (AarClasses 'io.github.webrtc-sdk\android' '144.7559.15' 'webrtc'),
    (LocalAarClasses (Join-Path $root 'android\app\libs\sherpa-onnx-static-link-onnxruntime-1.13.8.aar') 'sherpa-onnx'),
    $mockableAndroid
)
$classpath=$dependencies -join [IO.Path]::PathSeparator
$main=Join-Path $root 'android\app\src\main\java\com\nexusroom\android'
$version=(Get-Content -Raw (Join-Path $root 'release.json') | ConvertFrom-Json).version
$buildConfig=Join-Path $fixture 'BuildConfig.java'
[IO.File]::WriteAllText($buildConfig,('package com.nexusroom.android; final class BuildConfig { static final String VERSION_NAME="'+$version+'"; }'),[Text.UTF8Encoding]::new($false))
$resource=Join-Path $fixture 'R.java'
$stringNames=@()
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'android\app\src\main\res\values') -Filter '*.xml') {
    [xml]$xml=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    $stringNames+=@($xml.SelectNodes('/resources/string') | ForEach-Object {$_.name})
}
$stringFields=($stringNames | Select-Object -Unique | ForEach-Object {'static final int '+$_+'=1;'}) -join ''
[IO.File]::WriteAllText($resource,('package com.nexusroom.android; final class R { static final class drawable { static final int ic_nexus=1; } static final class string {'+$stringFields+'} }'),[Text.UTF8Encoding]::new($false))
$sources=@(Get-ChildItem -LiteralPath $main -Filter '*.java' | Where-Object {!$ServiceSource -or $_.Name -ne 'RoomService.java'} | Select-Object -ExpandProperty FullName)
if ($ServiceSource) {$sources+=[IO.Path]::GetFullPath($ServiceSource)}
$sources+=@($buildConfig,$resource,(Join-Path $PSScriptRoot 'java\com\nexusroom\android\RoomSessionTest.java'),(Join-Path $PSScriptRoot 'java\com\nexusroom\android\CommunicationLifecycleTest.java'))
$sources+=(Join-Path $PSScriptRoot 'java\android\media\RecordingAudioManager.java')
& javac '-J-Duser.language=en' -encoding UTF-8 --release 17 -cp $classpath -d $classes $sources
if ($LASTEXITCODE -ne 0) {throw 'Android room session regression compilation failed.'}
& java -cp ($classes+[IO.Path]::PathSeparator+$classpath) com.nexusroom.android.RoomSessionTest
if ($LASTEXITCODE -ne 0) {throw 'Android room session regression checks failed.'}
& java -cp ($classes+[IO.Path]::PathSeparator+$classpath) com.nexusroom.android.CommunicationLifecycleTest
if ($LASTEXITCODE -ne 0) {throw 'Android communication lifecycle regression checks failed.'}
