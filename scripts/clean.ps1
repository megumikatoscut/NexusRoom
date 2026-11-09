# Deletes generated project files only. Never traverses a dependency junction.
param([switch]$ExternalIntermediates)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')
$root=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$generated=@('.local','src\NexusRoom.Host\bin','src\NexusRoom.Host\obj','src\NexusRoom.Host\wwwroot','src\NexusRoom.Web\dist','scripts\__pycache__','tests\__pycache__','tests\voice\bin','tests\voice\obj','tests\VoiceNativeSmoke\bin','tests\VoiceNativeSmoke\obj','android\.gradle','android\build','android\app\build')
foreach ($relativePath in $generated) {
    $target=[IO.Path]::GetFullPath((Join-Path $root $relativePath))
    if (!$target.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Cleanup path outside the distribution.'}
    if (!(Test-Path -LiteralPath $target)) {continue}
    $item=Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Refusing a linked generated directory.'}
    Remove-NexusGenerated $target $root
}
foreach ($item in Get-ChildItem -LiteralPath (Resolve-NexusProjectPath $root 'artifacts') -Directory -Force -ErrorAction SilentlyContinue) {
    if ($item.Name -match '^\.(?:staging|finalize|single-exe)-[0-9a-f]{32}$') {
        Remove-NexusGenerated $item.FullName (Resolve-NexusProjectPath $root 'artifacts')
    }
}
foreach ($relativePath in @('src\NexusRoom.Web\node_modules','tests\node_modules')) {
    $target=Join-Path $root $relativePath
    if (!(Test-Path -LiteralPath $target)) {continue}
    $item=Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {[IO.Directory]::Delete($target)}
    else {Remove-Item -LiteralPath $target -Recurse -Force}
}
foreach ($relativePath in @('src\NexusRoom.Web\tsconfig.tsbuildinfo','android\local.properties','artifacts\.dev-signature-check.apk')) {
    $target=Join-Path $root $relativePath
    if (Test-Path -LiteralPath $target) {Remove-Item -LiteralPath $target -Force}
}
if ($ExternalIntermediates) {
    $cacheRoot=Get-NexusCacheRoot
    foreach ($relativePath in @('android\app','android\root','android\project-cache')) {
        Remove-NexusGenerated (Join-Path $cacheRoot $relativePath) $cacheRoot
    }
    # Build caches in the version-specific NexusRoom Gradle home are disposable.
    # A shared GRADLE_USER_HOME may also serve other projects; its dependencies
    # and global caches are outside this cleanup's project scope.
    $gradleCache=Join-Path (Get-NexusPaths).GradleUser 'caches'
    foreach ($item in Get-ChildItem -LiteralPath $gradleCache -Directory -Force -ErrorAction SilentlyContinue) {
        if ($item.Name -match '^build-cache-\d+$') {Remove-NexusGenerated $item.FullName $cacheRoot}
    }
}
Write-Host 'Clean source tree; application binaries, required runtime and external developer dependencies retained.'
