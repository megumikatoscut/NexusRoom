# Resolve paths in the final submission without depending on a drive or user profile.
function Get-NexusSubmissionRoot([string]$SourceRoot) {
    $parent=Split-Path ([IO.Path]::GetFullPath($SourceRoot)) -Parent
    if ((Test-Path -LiteralPath (Join-Path $parent '02_Release_Artifacts')) -and (Test-Path -LiteralPath (Join-Path $parent '06_Engineering_Evidence'))) {return $parent}
    return $null
}
function Resolve-NexusProjectPath([string]$SourceRoot,[string]$RelativePath) {
    $root=[IO.Path]::GetFullPath($SourceRoot)
    $submission=Get-NexusSubmissionRoot $root
    $name=$RelativePath.Replace('\','/').TrimStart('/')
    if ($submission) {
        $prefix=[IO.Path]::GetFileName($submission)+'/'
        if ($name.StartsWith($prefix)) {return Join-Path $submission $name.Substring($prefix.Length)}
        if ($name -match '^0[1-7]_[^/]+(?:/|$)') {return Join-Path $submission $name}
        if ($name -eq 'tests/results' -or $name.StartsWith('tests/results/')) {return Join-Path (Join-Path $submission '06_Engineering_Evidence\Verification\Results') $name.Substring(13).TrimStart('/')}
        if ($name -eq 'tests/evidence' -or $name.StartsWith('tests/evidence/')) {return Join-Path (Join-Path $submission '06_Engineering_Evidence\Verification\Runtime_Evidence') $name.Substring(14).TrimStart('/')}
        if ($name -match '^docs/(PACKAGING_VALIDATION|FINAL_TEST_RESULTS_MANIFEST)\.json$') {return Join-Path (Join-Path $submission '06_Engineering_Evidence\Verification') $name.Substring(5)}
        if ($name -eq 'docs/VOICE_PRESENTATION_VALIDATION.json') {return Join-Path $submission '06_Engineering_Evidence\Verification\Runtime_Evidence\VOICE_PRESENTATION_VALIDATION.json'}
        if ($name -eq 'artifacts' -or $name.StartsWith('artifacts/')) {
            $rest=if ($name.Length -gt 10) {$name.Substring(10)} else {''}
            if ($rest -match '^NexusRoom-Windows[^/]*\.exe$') {return Join-Path (Join-Path $submission '02_Release_Artifacts\Windows') $rest}
            if ($rest -match '^NexusRoom-Android[^/]*\.apk$') {return Join-Path (Join-Path $submission '02_Release_Artifacts\Android') $rest}
            return Join-Path (Join-Path $submission '02_Release_Artifacts') $rest
        }
    }
    return Join-Path $root $RelativePath
}

function Get-NexusChecksumName([string]$SourceRoot,[string]$File) {
    $name=[IO.Path]::GetFileName($File)
    if (Get-NexusSubmissionRoot $SourceRoot) {
        if ([IO.Path]::GetExtension($File) -eq '.exe') {return 'Windows/'+$name}
        if ([IO.Path]::GetExtension($File) -eq '.apk') {return 'Android/'+$name}
    }
    return $name
}
