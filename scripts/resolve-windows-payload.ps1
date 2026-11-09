. (Join-Path $PSScriptRoot 'submission-paths.ps1')
# Developer/verification access to the files embedded in the single EXE.
function Get-NexusWindowsPayload([string]$WorkspaceRoot, [string]$Version) {
    $root=[IO.Path]::GetFullPath($WorkspaceRoot)
    $exe=Resolve-NexusProjectPath $root ('artifacts\NexusRoom-Windows-x64-'+$Version+'.exe')
    if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {throw 'Build or download the current single Windows EXE first.'}
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$exe; $start.Arguments='--extract-only'; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false); $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $process=[Diagnostics.Process]::Start($start)
    try {
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $result=$stdout.GetAwaiter().GetResult().Trim(); $errorText=$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath (Join-Path $result 'NexusRoom.Host.exe'))) {throw ('Windows EXE extraction failed: '+$errorText)}
        return $result
    } finally {$process.Dispose()}
}
