param([switch]$SkipDistribution,[switch]$VerifyArtifacts)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-NexusRoot
$parseErrors=@()
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'scripts'),(Join-Path $root 'tests'),(Join-Path $root 'config') -Filter '*.ps1' -File -Recurse) {
    $tokens=$null; $errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    $parseErrors+=@($errors)
}
if ($parseErrors.Count) {throw 'PowerShell script syntax errors found.'}
Write-Host 'PASS PowerShell script syntax.'
$node=Initialize-NexusNode
Invoke-NexusNative $node.Executable @((Join-Path $PSScriptRoot 'check-documentation.mjs')) 'Source documentation links'
$consistencyArguments=@((Join-Path $root 'tests\current-release-consistency.mjs'))
if (!(Get-NexusSubmissionRoot $root)) {$consistencyArguments+='--source-only'}
Invoke-NexusNative $node.Executable $consistencyArguments 'Release declaration consistency'
if (!$SkipDistribution) {
    $distributionArguments=@((Join-Path $PSScriptRoot 'distribute.mjs'))
    if ($VerifyArtifacts) {$distributionArguments+='--verify-artifacts'}
    Invoke-NexusNative $node.Executable $distributionArguments 'Source distribution and available release checksums'
}
Write-Host 'These checks validate source structure and available release identities; they do not rerun physical-device or model evaluations.'
$global:LASTEXITCODE=0
