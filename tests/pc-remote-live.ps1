param([string]$Serial=$env:NEXUS_QA_SERIAL,[string]$Apk=$env:NEXUS_REMOTE_APK,[string]$HostExecutable=$env:NEXUS_REMOTE_HOST,[string]$EvidenceDirectory=$env:NEXUS_REMOTE_EVIDENCE,[string]$Endpoint=$env:NEXUS_REMOTE_ENDPOINT,[switch]$MediaOnly,[switch]$NativeIme)
$ErrorActionPreference='Stop'
if(!$Serial){throw 'Choose the connected physical Android device or QA emulator with -Serial.'}
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'fixtures\PcClipboardFixture.ps1')
# Preserve available clipboard formats only in memory; never log or save user clipboard data.
$taskOriginal=[Windows.Forms.Clipboard]::GetDataObject()
$taskSaved=[Windows.Forms.DataObject]::new()
if($taskOriginal){foreach($format in $taskOriginal.GetFormats($false)){$value=$taskOriginal.GetData($format,$false);if($null -ne $value){$taskSaved.SetData($format,$false,$value)}}}
$taskNativeFormats=if($taskOriginal){@($taskOriginal.GetFormats($false))}else{@()}
$taskTextOnly=@($taskNativeFormats | Where-Object {$_ -notin @('UnicodeText','Text','OEMText','Locale')}).Count -eq 0
$taskNames=@('NEXUS_QA_SERIAL','NEXUS_REMOTE_APK','NEXUS_REMOTE_HOST','NEXUS_REMOTE_EVIDENCE','NEXUS_REMOTE_ENDPOINT','NEXUS_REMOTE_MEDIA_ONLY','NEXUS_REMOTE_CLIPBOARD','NEXUS_REMOTE_NATIVE_IME')
$taskEnvironment=@{}
foreach($name in $taskNames){$taskEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
 $env:NEXUS_QA_SERIAL=$Serial;$env:NEXUS_REMOTE_APK=$Apk;$env:NEXUS_REMOTE_HOST=$HostExecutable;$env:NEXUS_REMOTE_EVIDENCE=$EvidenceDirectory
 $env:NEXUS_REMOTE_ENDPOINT=$Endpoint
 $env:NEXUS_REMOTE_NATIVE_IME=if($NativeIme -or $taskEnvironment['NEXUS_REMOTE_NATIVE_IME'] -eq '1'){'1'}else{'0'}
 $env:NEXUS_REMOTE_MEDIA_ONLY=if($MediaOnly){'1'}else{'0'};$env:NEXUS_REMOTE_CLIPBOARD=if($MediaOnly -or !$taskTextOnly){'0'}else{'1'}
 & node (Join-Path $PSScriptRoot 'pc-remote-live.mjs')
 if($LASTEXITCODE -ne 0){throw 'Real Android PC remote acceptance failed.'}
}finally{
 # Node stops and removes its isolated room before this restoration.
 if(!$MediaOnly -and $taskTextOnly){[NexusFixtureClipboard]::SetText($taskSaved.GetText())}
 foreach($name in $taskNames){[Environment]::SetEnvironmentVariable($name,$taskEnvironment[$name],'Process')}
}
