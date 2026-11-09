param(
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [Parameter(Mandatory=$true)][string]$PackageDirectory,
    [switch]$InventoryOnly,
    [switch]$AllowHistoricalDocuments
)
$ErrorActionPreference='Stop'
$verificationScript=Join-Path $PSScriptRoot 'verify-release.mjs'
if (!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {throw 'The release Node executable is missing.'}
if (!(Test-Path -LiteralPath $verificationScript -PathType Leaf)) {throw 'The release verification script is missing.'}

# ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
# Quote each argument for Windows argv parsing, without passing through a shell.
function ConvertTo-WindowsArgument([string]$Value) {
    $builder=[Text.StringBuilder]::new()
    [void]$builder.Append([char]'"')
    $slashes=0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]'\') {$slashes++; continue}
        if ($character -eq [char]'"') {
            [void]$builder.Append([char]'\',($slashes*2+1))
            [void]$builder.Append([char]'"')
        } else {
            [void]$builder.Append([char]'\',$slashes)
            [void]$builder.Append($character)
        }
        $slashes=0
    }
    [void]$builder.Append([char]'\',($slashes*2))
    [void]$builder.Append([char]'"')
    return $builder.ToString()
}
$arguments=@('--preserve-symlinks','--preserve-symlinks-main',[IO.Path]::GetFullPath($verificationScript),'--package',[IO.Path]::GetFullPath($PackageDirectory))
if ($InventoryOnly) {$arguments+='--inventory-only'}
if ($AllowHistoricalDocuments) {$arguments+='--allow-historical-documents'}
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=[IO.Path]::GetFullPath($NodeExecutable)
$start.Arguments=($arguments | ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '
$start.WorkingDirectory=Split-Path $PSScriptRoot -Parent
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
$start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
$process=[Diagnostics.Process]::new()
$process.StartInfo=$start
try {
    if (!$process.Start()) {throw 'The release verifier could not start.'}
    # Drain both pipes concurrently before waiting, including large native
    # stderr/CLIXML output. PowerShell never interprets the native error stream.
    $stdoutRead=$process.StandardOutput.ReadToEndAsync()
    $stderrRead=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdoutText=$stdoutRead.GetAwaiter().GetResult()
    $stderrText=$stderrRead.GetAwaiter().GetResult()
    $exitCode=$process.ExitCode
    if ($stdoutText.Length) {Write-Output $stdoutText.TrimEnd()}
    if ($stderrText.Length) {Write-Output $stderrText.TrimEnd()}
    if ($exitCode -ne 0) {throw "Release verification failed (exit $exitCode)."}
} finally {
    $process.Dispose()
}
