param([switch]$DesktopRegression)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$saved=Save-NexusEnvironment
try {
    Set-NexusBuildEnvironment
    Add-NexusToolPath (Join-Path $env:JAVA_HOME 'bin')
    $root=Get-NexusRoot
    $node=Get-NexusReleaseNode
    Initialize-NexusNpmProject (Join-Path $root 'tests') 'tests'
    # Use the distribution's fixed, pristine Chromium; installing test browsers is unnecessary.
    $package=Get-NexusWindowsPayload $root (Get-NexusRelease).version
    $env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $package 'runtime\browsers'
    Push-Location $root
    try {
        foreach ($test in @('integration.mjs','host-regression.mjs','pc-agent-contract.mjs','pc-room-files-contract.mjs','pc-remote-ui.mjs','voice-room.mjs','voice-ui.mjs')) {
            Invoke-NexusNative $node.Executable @((Join-Path $root ('tests\'+$test))) $test
        }
        Invoke-NexusNative $node.Executable @('--test','tests/pc-harness-policy.test.mjs','tests/pc-room-files.test.mjs','tests/communication-rtc.test.mjs','tests/runtime-path.test.mjs') 'Agent, runtime path and media unit regressions'
        Invoke-NexusNative $node.Executable @('--test','tests/single-exe-format.test.mjs') 'Single EXE archive validation regression'
        Invoke-NexusNative $node.Executable @('tests/communication-contract.mjs') 'Communication protocol regression'
        Invoke-NexusNative $node.Executable @('tests/communication-ui.mjs') 'Communication UI regression'
        Invoke-NexusNative 'dotnet' @('run','--project','tests/voice/VoiceTests.csproj','-v','minimal') 'Voice arbitration and intent regression'
        & (Join-Path $PSScriptRoot 'verify-voice-native.ps1')
        foreach ($test in @('android-room-identity.ps1','android-room-session.ps1','android-pc-viewport.ps1','windows-single-exe.ps1')) {
            & (Join-Path $root ('tests\'+$test))
        }
        if ($DesktopRegression) {Invoke-NexusNative $node.Executable @('tests/pc-remote-contract.mjs') 'Desktop regression'}
    } finally {Pop-Location}
} finally {Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
