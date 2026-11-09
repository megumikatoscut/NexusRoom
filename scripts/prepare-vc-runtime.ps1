param([string]$Output='')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$release=Get-Content -Raw (Join-Path $root 'release.json') | ConvertFrom-Json
$runtime=$release.vcRuntime
if (!$runtime -or !$runtime.files.Count) {throw 'Pin the Visual C++ runtime in release.json before packaging.'}
if (!$Output) {$Output=Join-Path $root ('.local\vc-runtime-'+$runtime.version)}
function Valid-Payload([string]$Directory) {
    foreach ($file in $runtime.files) {
        $path=Join-Path $Directory $file.name
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {return $false}
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {return $false}
    }
    return $true
}
if (Valid-Payload $Output) {Write-Host ('Verified app-local Visual C++ runtime '+$runtime.version); return}
$downloads=Join-Path $root '.local\downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
$archive=Join-Path $downloads ('vc_redist-'+$runtime.version+'-x64.exe')
if (!(Test-Path -LiteralPath $archive)) {Invoke-WebRequest -Uri $runtime.archiveUrl -OutFile $archive -UseBasicParsing}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.archiveSha256) {throw 'Visual C++ runtime archive digest mismatch.'}
if ((Get-Item -LiteralPath $archive).VersionInfo.FileVersion -ne $runtime.version) {throw 'Visual C++ runtime archive version mismatch.'}
# WiX extracts the official Burn container. The redistributable installer is never run.
$wix=Join-Path $root '.local\wix\wix.exe'
if (!(Test-Path -LiteralPath $wix)) {
    & dotnet tool install wix --tool-path (Join-Path $root '.local\wix') --version 6.0.2
    if ($LASTEXITCODE -ne 0) {throw 'WiX archive extraction tool preparation failed.'}
}
$extract=Join-Path $root ('.local\vc-extract-'+[guid]::NewGuid().ToString('N'))
try {
    & $wix burn extract $archive -o $extract -oba (Join-Path $extract 'bootstrapper')
    if ($LASTEXITCODE -ne 0) {throw 'Visual C++ archive extraction failed.'}
    $cab=Join-Path $extract 'WixAttachedContainer\packages\vcRuntimeMinimum_amd64\cab1.cab'
    $expanded=Join-Path $extract 'expanded'
    New-Item -ItemType Directory -Path $expanded -Force | Out-Null
    & expand.exe '-F:*' $cab $expanded | Out-Null
    if ($LASTEXITCODE -ne 0) {throw 'Visual C++ CAB extraction failed.'}
    New-Item -ItemType Directory -Path $Output -Force | Out-Null
    foreach ($file in $runtime.files) {
        $source=Join-Path $expanded ($file.name+'_amd64')
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {throw ('Visual C++ DLL digest mismatch: '+$file.name)}
        Copy-Item -LiteralPath $source -Destination (Join-Path $Output $file.name) -Force
    }
    if (!(Valid-Payload $Output)) {throw 'Visual C++ runtime payload validation failed.'}
    Write-Host ('Prepared app-local Visual C++ runtime '+$runtime.version+' without installing it')
} finally {
    $full=[IO.Path]::GetFullPath($extract)
    $local=[IO.Path]::GetFullPath((Join-Path $root '.local'))
    if (!$full.StartsWith($local+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {throw 'Visual C++ extraction cleanup escaped .local.'}
    if (Test-Path -LiteralPath $full) {Remove-Item -LiteralPath $full -Recurse -Force}
}
