param([switch]$Microphone,[switch]$Presentation)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
$saved=Save-NexusEnvironment
try {
    Set-NexusBuildEnvironment -WithoutAndroid
    $fixtureRoot=Join-Path $root '.local\voice-fixtures'
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    & (Join-Path $PSScriptRoot 'prepare-voice.ps1') -OutputDirectory (Join-Path $fixtureRoot 'models')
    $voice=New-Object -ComObject SAPI.SpVoice
    $voices=$voice.GetVoices()
    $english=$null; $chinese=$null
    for ($index=0; $index -lt $voices.Count; $index++) {
        $candidate=$voices.Item($index)
        if ($candidate.GetAttribute('Language') -eq '409') {$english=$candidate}
        if ($candidate.GetAttribute('Language') -eq '804') {$chinese=$candidate}
    }
    if (!$english -or !$chinese) {throw 'Install the Windows English (United States) and Chinese (Simplified) offline desktop voices, or provide the generated 16 kHz WAV fixtures manually.'}
    function Save-VoiceFixture([string]$Name,[string]$Text,$Token) {
        $target=Join-Path $fixtureRoot $Name
        $stream=New-Object -ComObject SAPI.SpFileStream
        try {
            $stream.Format.Type=18 # SAPI SAFT16kHz16BitMono
            $stream.Open($target,3,$false)
            $voice.Voice=$Token
            $voice.AudioOutputStream=$stream
            $voice.Rate=0
            [void]$voice.Speak($Text,0)
        } finally {$stream.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream)}
        return $target
    }
    $wake=Save-VoiceFixture 'wake-en.wav' 'Hi Nexus. On this computer, create a new text file.' $english
    $command=Save-VoiceFixture 'command-zh.wav' '请在电脑打开记事本。' $chinese
    $negative=Save-VoiceFixture 'negative-en.wav' 'The weather is sunny today. Open a window please.' $english
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($voice)
    $evidenceName=if ($Microphone) {'windows-native-microphone.json'} else {'windows-native.json'}
    $arguments=@('run','--project',(Join-Path $root 'tests\VoiceNativeSmoke\VoiceNativeSmoke.csproj'),'--disable-build-servers','--',$wake,$command,$negative,'--evidence',(Join-Path $(if ($env:NEXUS_TEST_EVIDENCE_DIR) {$env:NEXUS_TEST_EVIDENCE_DIR} else {Join-Path (Get-NexusCacheRoot) 'current-validation'}) ('voice-v1.0.0\'+$evidenceName)))
    if ($Microphone) {$arguments+=@('--microphone')}
    if ($Presentation) {$arguments+=@('--presentation')}
    Invoke-NexusNative 'dotnet' $arguments 'Real offline KWS / bilingual ASR / VAD native regression'
} finally {Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
