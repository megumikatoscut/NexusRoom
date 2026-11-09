param([string]$PackageDirectory='', [switch]$SkipRuntimeVerification)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
$version=(Get-NexusRelease).version
if (!$PackageDirectory) {$PackageDirectory=Get-NexusWindowsPayload $root $version}
$package=[IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\')
$artifacts=Get-NexusBuildReleaseRoot
$output=Get-NexusBuildArtifactPath ('NexusRoom-Windows-x64-'+$version+'.exe')
New-Item -ItemType Directory -Path (Split-Path $output -Parent) -Force | Out-Null
function Remove-NexusBrowserInstallMetadata {
    $browserRoot=Join-Path $package 'runtime\browsers'
    if (!(Test-Path -LiteralPath $browserRoot -PathType Container)) {return}
    $paths=@(Join-Path $browserRoot '.links')
    $paths+=@(Get-ChildItem -LiteralPath $browserRoot -Recurse -File -Force | Where-Object {$_.Name -in @('INSTALLATION_COMPLETE','DEPENDENCIES_VALIDATED')} | Select-Object -ExpandProperty FullName)
    foreach ($path in $paths) {
        if (!(Test-Path -LiteralPath $path)) {continue}
        # Only disposable release staging belongs to this build. Installed
        # extraction caches retain their original inventory and contents.
        [void](Assert-NexusChildPath $package (Get-NexusCacheRoot))
        Remove-NexusGenerated $path $package
    }
}
Remove-NexusBrowserInstallMetadata
if ((Get-Content -LiteralPath (Join-Path $package 'release.json') -Raw | ConvertFrom-Json).version -ne $version) {throw 'Wrong payload version.'}
foreach ($binary in @('NexusRoom.Host.exe','NexusRoom.Host.dll')) {
    if ((Get-Item -LiteralPath (Join-Path $package $binary)).VersionInfo.FileVersion -ne ($version+'.0')) {throw 'Wrong Host binary version.'}
}
foreach ($item in Get-ChildItem -LiteralPath $package -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Linked payload item.'}
    if ($item.PSIsContainer -and $item.Name -in @('.local','.git','.history','.dsh','webview','browser-ui','session-data','__pycache__','.gradle','.gradle-user','.npm','_cacache','.pnpm-store','.pytest_cache','.mypy_cache','.ruff_cache','.vite','.cache','npm-cache','pnpm-store','obj')) {throw ('Runtime state or incremental cache must not be bundled: '+$item.Name)}
    if (!$item.PSIsContainer -and ($item.Name -match '^(?:state\.dat|launch\.dat|certificate\.dat|audit\.jsonl|\.env)$|\.(?:jks|keystore|pfx|p12|log|dmp|py[co]|tsbuildinfo)$')) {throw ('Private/generated payload: '+$item.Name)}
    if (!$item.PSIsContainer -and $item.FullName -in @((Join-Path $package 'docs\PC_AGENT.md'),(Join-Path $package 'docs\VALIDATION.md'),(Join-Path $package 'docs\PROJECT_STRUCTURE.md'))) {throw ('Historical validation document: '+$item.Name)}
}
if (!$SkipRuntimeVerification) {& (Join-Path $PSScriptRoot 'invoke-release-verification.ps1') -NodeExecutable (Join-Path $package 'runtime\node\node.exe') -PackageDirectory $package}
# Browser dependency validation may create its host-specific marker again.
Remove-NexusBrowserInstallMetadata
$work=Join-Path (Get-NexusCacheRoot) ('single-exe-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    $metadata=Join-Path $work 'AssemblyInfo.cs'
    [IO.File]::WriteAllText($metadata, ('[assembly:System.Reflection.AssemblyTitle("NexusRoom")][assembly:System.Reflection.AssemblyProduct("NexusRoom")][assembly:System.Reflection.AssemblyVersion("'+$version+'.0")][assembly:System.Reflection.AssemblyFileVersion("'+$version+'.0")]'), [Text.UTF8Encoding]::new($false))
    $csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $stub=Join-Path $work 'launcher.exe'
    & $csc /nologo /target:winexe /platform:x64 /optimize+ (('/out:')+$stub) (('/win32icon:')+(Join-Path $root 'PIC\PC.ico')) (('/win32manifest:')+(Join-Path $PSScriptRoot 'windows\launcher.manifest')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Security.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'windows\Launcher.cs') $metadata
    if ($LASTEXITCODE -ne 0) {throw 'Single EXE launcher compilation failed.'}
    $builder=Join-Path $work 'builder.exe'
    & $csc /nologo /target:exe /platform:x64 /optimize+ (('/out:')+$builder) (('/win32manifest:')+(Join-Path $PSScriptRoot 'windows\launcher.manifest')) /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'windows\BundleBuilder.cs')
    if ($LASTEXITCODE -ne 0) {throw 'Bundle builder compilation failed.'}
    # Validate the freshly compiled bootstrap with a tiny complete archive before
    # spending time compressing the production runtimes.
    $probe=Join-Path $work 'probe'; New-Item -ItemType Directory -Path $probe | Out-Null
    [IO.File]::WriteAllText((Join-Path $probe 'probe.txt'),'bootstrap smoke test')
    $probeExe=Join-Path $work 'probe.exe'
    & $builder $probe $stub $probeExe (Join-Path $work 'probe.zip') $version
    if ($LASTEXITCODE -ne 0) {throw 'Bootstrap probe assembly failed.'}
    $probeStart=[Diagnostics.ProcessStartInfo]::new(); $probeStart.FileName=$probeExe; $probeStart.Arguments='--verify-package'; $probeStart.UseShellExecute=$false; $probeStart.CreateNoWindow=$true
    $probeStart.RedirectStandardOutput=$true; $probeStart.RedirectStandardError=$true
    $probeProcess=[Diagnostics.Process]::Start($probeStart)
    try {
        $probeOutput=$probeProcess.StandardOutput.ReadToEndAsync(); $probeError=$probeProcess.StandardError.ReadToEndAsync(); $probeProcess.WaitForExit()
        if ($probeProcess.ExitCode -ne 0) {throw ('Bootstrap smoke test failed: '+$probeError.GetAwaiter().GetResult())}
        Write-Host $probeOutput.GetAwaiter().GetResult().Trim()
    } finally {$probeProcess.Dispose()}
    $pending=Join-Path $work 'NexusRoom.exe'
    Write-Host 'Compressing the complete pinned payload into one Windows EXE...'
    & $builder $package $stub $pending (Join-Path $work 'payload.zip') $version
    if ($LASTEXITCODE -ne 0) {throw 'Bundle compression failed.'}
    $start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=$pending; $start.Arguments='--verify-package'
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $process=[Diagnostics.Process]::Start($start)
    try {
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync(); $process.WaitForExit()
        Write-Host $stdout.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) {throw ('Single EXE integrity verification failed: '+$stderr.GetAwaiter().GetResult())}
    } finally {$process.Dispose()}
    $apk=Get-NexusBuildArtifactPath ('NexusRoom-Android-'+$version+'.apk')
    New-Item -ItemType Directory -Path (Split-Path $apk -Parent) -Force | Out-Null
    if (!(Test-Path -LiteralPath $apk)) {Copy-Item -LiteralPath (Join-Path $package 'tools\NexusRoom-Android.apk') -Destination $apk}
    if ((Get-FileHash -LiteralPath $apk).Hash -ne (Get-FileHash -LiteralPath (Join-Path $package 'tools\NexusRoom-Android.apk')).Hash) {throw 'APK copies differ.'}
    Move-Item -LiteralPath $pending -Destination $output -Force
    $lines=@($output,$apk) | ForEach-Object {(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+(Get-NexusBuildChecksumName $_)}
    foreach ($name in @('SHA256SUMS.txt','RELEASE_SHA256SUMS.txt')) {[IO.File]::WriteAllLines((Join-Path $artifacts $name),[string[]]$lines,[Text.UTF8Encoding]::new($false))}
    Write-Host ('Single Windows EXE: '+$output+' ('+(Get-Item -LiteralPath $output).Length+' bytes)')
} finally {Remove-NexusGenerated $work (Get-NexusCacheRoot)}
$global:LASTEXITCODE=0
