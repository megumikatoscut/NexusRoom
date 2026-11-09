param([Parameter(Mandatory=$true)][string]$Apk)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$manifest=Get-Content -LiteralPath (Join-Path $root 'config\voice-models.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Apk))
try {
    foreach($model in $manifest.models) {
        $folder=($model.target -split '/')[0]
        $name=($model.source -split '/')[-1]
        $path='assets/voice/'+$folder+'/'+$name
        $entry=$archive.GetEntry($path)
        if(!$entry -or $entry.Length -ne $model.bytes){throw ('APK offline model missing or wrong size: '+$path)}
        $stream=$entry.Open(); $algorithm=[Security.Cryptography.SHA256]::Create()
        try {$digest=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
        finally {$stream.Dispose(); $algorithm.Dispose()}
        if($digest -ne $model.sha256){throw ('APK offline model checksum mismatch: '+$path)}
    }
    $entry=$archive.GetEntry('assets/voice/keywords.txt')
    if(!$entry){throw 'APK Hi Nexus keyword definition is missing.'}
    $reader=[IO.StreamReader]::new($entry.Open(),[Text.Encoding]::UTF8)
    try {if($reader.ReadToEnd().Trim() -ne $manifest.wakeTokens){throw 'APK wake keyword definition differs from pinned configuration.'}}
    finally {$reader.Dispose()}
    foreach($abi in @('arm64-v8a','armeabi-v7a','x86_64')) {
        if(!$archive.GetEntry('lib/'+$abi+'/libsherpa-onnx-jni.so')){throw ('APK native voice runtime is missing for '+$abi)}
    }
    foreach($license in @('sherpa-onnx-LICENSE.txt','ONNX-Runtime-LICENSE.txt')) {
        $entry=$archive.GetEntry('assets/licenses/'+$license)
        if(!$entry){throw ('APK voice license is missing: '+$license)}
        $reader=[IO.StreamReader]::new($entry.Open(),[Text.Encoding]::UTF8)
        try {if($reader.ReadToEnd() -ne [IO.File]::ReadAllText((Join-Path $root ('docs\licenses\'+$license)))){throw ('APK voice license differs from source: '+$license)}}
        finally {$reader.Dispose()}
    }
    Write-Host 'PASS Android APK: 8 pinned offline model hashes, Hi Nexus keywords, 3 native ABIs and complete voice licenses.'
} finally {$archive.Dispose()}
$global:LASTEXITCODE=0
