param([string]$Serial='emulator-5554',[string]$Wav='', [switch]$ExpectWake,[switch]$Lifecycle,[switch]$EarlyRelease,[switch]$OverlayCancel,[switch]$WakePresentation,[string]$AndroidSdk=$env:ANDROID_HOME)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$testDir=Join-Path $root '.local\android-voice-vad-test'
New-Item -ItemType Directory -Force $testDir | Out-Null
& javac -encoding UTF-8 --release 17 -d $testDir (Join-Path $root 'android\app\src\main\java\com\nexusroom\android\VoiceVad.java') (Join-Path $root 'tests\java\com\nexusroom\android\VoiceVadTest.java')
if($LASTEXITCODE -ne 0){throw 'Voice VAD test compile failed'}
& java -cp $testDir com.nexusroom.android.VoiceVadTest
if($LASTEXITCODE -ne 0){throw 'Voice VAD regression failed'}
$adb=Join-Path $AndroidSdk 'platform-tools\adb.exe'
$deviceRoot='/data/user/0/com.nexusroom.android/files'
& $adb -s $Serial shell run-as com.nexusroom.android mkdir -p files
& $adb -s $Serial shell run-as com.nexusroom.android rm -f files/voice-test-result.json
$start=@('-s',$Serial,'shell','am','start','-S','-n','com.nexusroom.android/.VoiceFixtureActivity')
if($Wav){$source=(Resolve-Path -LiteralPath $Wav).Path;& $adb -s $Serial push $source '/data/local/tmp/nexusroom-voice-fixture.wav';if($LASTEXITCODE -ne 0){throw 'WAV push failed'};& $adb -s $Serial shell run-as com.nexusroom.android cp '/data/local/tmp/nexusroom-voice-fixture.wav' ($deviceRoot+'/voice-fixture.wav');if($LASTEXITCODE -ne 0){throw 'App-private WAV copy failed'};$start+=@('--es','wav',($deviceRoot+'/voice-fixture.wav'))}
if($ExpectWake){$start+=@('--ez','expectWake','true')}
if($Lifecycle){$start+=@('--ez','lifecycle','true')}
if($EarlyRelease){$start+=@('--ez','earlyRelease','true')}
if($OverlayCancel){$start+=@('--ez','overlayCancel','true')}
if($WakePresentation){$start+=@('--ez','wakePresentation','true')}
& $adb @start
if($LASTEXITCODE -ne 0){throw 'Voice fixture launch failed'}
$resultPath=$deviceRoot+'/voice-test-result.json'
$deadline=[DateTime]::UtcNow.AddSeconds(90)
do {
    Start-Sleep -Seconds 2
    $raw=(& $adb -s $Serial shell run-as com.nexusroom.android cat $resultPath 2>$null) -join "`n"
    try{$result=$raw|ConvertFrom-Json}catch{$result=$null}
}while(!$result -and [DateTime]::UtcNow -lt $deadline)
if(!$result){throw 'Native voice fixture timed out'}
$raw
if(!$result.ok){throw ('Native voice fixture failed: '+$result.error)}
if($WakePresentation){
    $activities=(& $adb -s $Serial shell dumpsys activity activities) -join "`n"
    if($activities -notmatch '(?:topResumedActivity|mResumedActivity).*com.nexusroom.android/.MainActivity'){throw 'Local background wake did not bring MainActivity to the foreground'}
    & $adb -s $Serial shell uiautomator dump /data/local/tmp/nexusroom-wake-ui.xml | Out-Null
    $ui=(& $adb -s $Serial shell cat /data/local/tmp/nexusroom-wake-ui.xml) -join ''
    if(!$ui.Contains('收起 Agent 悬浮窗')){throw 'Local background wake did not open the production Agent panel'}
    Write-Host 'PASS native background MainActivity launch and visible Agent panel (local event fixture).'
}
